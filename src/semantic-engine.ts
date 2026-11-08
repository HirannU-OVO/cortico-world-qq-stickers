/**
 * 表情语义索引（自包含 vector index，不依赖任何其它扩展）。
 *
 * 设计参考 AstrBot 的 meme_manager 插件：索引自带 manifest（schema 版本 / 模型 / 维度）、
 * 旧向量可复用、模型或维度变了要能识别出来、垃圾条目要能清、落盘必须原子。
 * 但实现是这里自己的：BM25(CJK 2/3-gram) + Cosine + RRF 融合，纯 Node、零依赖、零 faiss。
 *
 * 数据文件：`<dataDir>/vector-memory.json`
 * ```json
 * { "schema": 2, "model_name": "bge-m3", "dimension": 1024, "updated_at": "...",
 *   "vectors": { "stickers": [ { "text": "...", "vector": "base64(fp16 LE)"|null, "timestamp": 0 } ] } }
 * ```
 * 兼容旧格式（只有 vectors，无 schema）：读进来照用，下次落盘自动升到 v2。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SCHEMA = 2;
const BM25_K1 = 1.5;
const BM25_B = 0.75;
const RRF_K = 60;
const COSINE_FLOOR = 0.3;
const SAVE_DEBOUNCE_MS = 2000;

/* ── fp16 编解码：与既有索引文件同一套位运算，旧向量可直接解码 ─────────── */

function f32ToF16(value: number): number {
  const f = new Float32Array(1);
  const u = new Uint32Array(f.buffer);
  f[0] = value;
  const x = u[0]!;
  const sign = (x >>> 16) & 0x8000;
  const rest = x & 0x7fffffff;
  if (rest >= 0x7f800000) return sign | 0x7c00 | (rest > 0x7f800000 ? 0x0200 : 0);
  if (rest > 0x477fe000) return sign | 0x7c00;
  if (rest < 0x33000000) return sign;
  let exp = (rest >>> 23) - 127 + 15;
  let mant = rest & 0x007fffff;
  if (exp <= 0) {
    mant = (rest & 0x007fffff) | 0x00800000;
    const shift = 14 - exp;
    mant = (mant + (1 << (shift - 1))) >> shift;
    return sign | mant;
  }
  mant = mant + 0x00000fff + ((mant >>> 13) & 1);
  if (mant & 0x00800000) {
    mant = 0;
    exp += 1;
  }
  return sign | (exp << 10) | (mant >>> 13);
}

function f16ToF32(h: number): number {
  const sign = (h & 0x8000) << 16;
  const exp = (h & 0x7c00) >>> 10;
  const mant = h & 0x03ff;
  let out: number;
  if (exp === 0) {
    if (mant === 0) out = 0;
    else {
      let e = -1;
      let m = mant;
      while (!(m & 0x0400)) {
        m <<= 1;
        e -= 1;
      }
      m &= 0x03ff;
      out = ((127 + 15 + e - 10) << 23) | (m << 13);
    }
  } else if (exp === 0x1f) {
    out = mant ? 0x7fc00000 : 0x7f800000;
  } else {
    out = ((exp - 15 + 127) << 23) | (mant << 13);
  }
  const f = new Float32Array(1);
  const u = new Uint32Array(f.buffer);
  u[0] = (out | sign) >>> 0;
  return f[0]!;
}

export function encodeVectorFp16(vec: readonly number[]): string {
  const bytes = new Uint8Array(vec.length * 2);
  for (let i = 0; i < vec.length; i++) {
    const h = f32ToF16(vec[i]!);
    bytes[i * 2] = h & 0xff;
    bytes[i * 2 + 1] = (h >>> 8) & 0xff;
  }
  return Buffer.from(bytes).toString('base64');
}

export function decodeVectorFp16(encoded: string): Float32Array {
  const raw = Buffer.from(encoded, 'base64');
  const out = new Float32Array(raw.length >>> 1);
  for (let i = 0; i < out.length; i++) out[i] = f16ToF32(raw[i * 2]! | (raw[i * 2 + 1]! << 8));
  return out;
}

/* ── 分词与打分 ───────────────────────────────────────────────────────── */

const CJK_RUN = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+|[a-zA-Z0-9_]+/g;
const CJK_HEAD = /^[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;

/** 中文按 2/3-gram、拉丁按整词切；口语查询下比整句更稳。 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const seg of String(text ?? '').toLowerCase().match(CJK_RUN) ?? []) {
    if (CJK_HEAD.test(seg)) {
      for (const n of [2, 3]) {
        for (let i = 0; i + n <= seg.length; i++) out.push(seg.slice(i, i + n));
      }
    } else {
      out.push(seg);
    }
  }
  return out;
}

function bm25(queryTokens: string[], docs: string[][]): number[] {
  const n = docs.length;
  if (!n) return [];
  const lens = docs.map((d) => d.length);
  const avg = lens.reduce((a, b) => a + b, 0) / n || 1;
  const querySet = new Set(queryTokens);
  const df = new Map<string, number>();
  const tfs: Array<Map<string, number>> = [];
  for (const doc of docs) {
    const tf = new Map<string, number>();
    for (const token of doc) {
      if (!querySet.has(token)) continue;
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }
    tfs.push(tf);
    for (const token of tf.keys()) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const scores: number[] = [];
  for (let i = 0; i < n; i++) {
    let score = 0;
    const dl = lens[i]!;
    for (const token of querySet) {
      const d = df.get(token);
      if (!d) continue;
      const idf = Math.log((n - d + 0.5) / (d + 0.5) + 1);
      const f = tfs[i]!.get(token) ?? 0;
      score += idf * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avg))));
    }
    scores.push(score);
  }
  return scores;
}

function rrf(lists: Array<Array<{ idx: number }>>): Map<number, number> {
  const out = new Map<number, number>();
  for (const list of lists) {
    list.forEach((item, rank) => out.set(item.idx, (out.get(item.idx) ?? 0) + 1 / (RRF_K + rank + 1)));
  }
  return out;
}

function l2(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm);
  if (!norm || !Number.isFinite(norm)) return vec;
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! / norm;
  return vec;
}

/* ── 索引本体 ─────────────────────────────────────────────────────────── */

interface Item {
  text: string;
  vector: string | null;
  timestamp: number;
}

interface StoreData {
  schema?: number;
  model_name?: string;
  dimension?: number;
  updated_at?: string;
  vectors: Record<string, Item[]>;
}

export interface SearchHit {
  text: string;
  score: number;
  via: 'bm25' | 'vector' | 'both';
}

export interface IndexStats {
  schema: number;
  model: string;
  dimension: number;
  total: number;
  indexed: number;
  /** 与当前维度不一致的条目数（换过模型时会出现，检索时跳过）。 */
  offDimension: number;
}

export class VectorStore {
  static readonly SAVE_DEBOUNCE_MS = SAVE_DEBOUNCE_MS;

  private data: StoreData = { schema: SCHEMA, vectors: {} };
  private readonly file: string;
  private readonly dir: string;
  private dirty = false;
  private lastSave = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 矩阵缓存：同一 scope 的向量只在数据变动后重建。 */
  private cache = new Map<string, { version: number; dim: number; rows: number[]; matrix: Float32Array }>();
  private versions = new Map<string, number>();

  constructor(dataDir: string) {
    this.dir = dataDir;
    this.file = join(dataDir, 'vector-memory.json');
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as StoreData;
      if (!raw || typeof raw !== 'object' || !raw.vectors || typeof raw.vectors !== 'object') return;
      this.data = {
        vectors: raw.vectors,
        schema: Number(raw.schema) || 1,
        ...(raw.model_name ? { model_name: raw.model_name } : {}),
        ...(Number(raw.dimension) ? { dimension: Number(raw.dimension) } : {}),
        ...(raw.updated_at ? { updated_at: raw.updated_at } : {}),
      };
      // 旧格式没有 dimension：从第一条带向量的条目反推，便于识别「换过模型」
      if (!this.data.dimension) {
        for (const list of Object.values(this.data.vectors)) {
          const first = list.find((item) => item.vector);
          if (first?.vector) {
            this.data.dimension = Buffer.from(first.vector, 'base64').length / 2;
            break;
          }
        }
      }
    } catch {
      /* 没有或损坏都从空库起步，不影响表情包本身 */
    }
  }

  private save(): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const payload: StoreData = {
        ...this.data,
        schema: SCHEMA,
        updated_at: new Date().toISOString(),
        ...(this.data.dimension ? { dimension: this.data.dimension } : {}),
      };
      const tmp = `${this.file}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      renameSync(tmp, this.file);
      this.data.schema = SCHEMA;
      this.dirty = false;
      this.lastSave = Date.now();
    } catch {
      /* 磁盘异常不打断主流程；下次再试 */
    }
  }

  private schedule(): void {
    if (Date.now() - this.lastSave < SAVE_DEBOUNCE_MS) {
      this.dirty = true;
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.save();
        }, SAVE_DEBOUNCE_MS);
        this.timer.unref?.();
      }
      return;
    }
    this.save();
  }

  private bump(scope: string): void {
    this.versions.set(scope, (this.versions.get(scope) ?? 0) + 1);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.dirty || !this.lastSave) this.save();
  }

  /** 记录出向量的模型名（换模型时索引仍可读，但检索会按维度对齐后再用）。 */
  setModel(name: string): void {
    const clean = String(name ?? '').trim();
    if (!clean || clean === this.data.model_name) return;
    this.data.model_name = clean;
    this.schedule();
  }

  /** 入库；同一文本（前 200 字）只留一条。 */
  add(scope: string, text: string, vector: readonly number[] | null, maxPerScope: number): void {
    const key = String(text ?? '').slice(0, 200);
    if (!key) return;
    const list = (this.data.vectors[scope] ??= []);
    if (list.some((item) => item.text === key)) return;
    list.push({ text: key, vector: vector?.length ? encodeVectorFp16(vector) : null, timestamp: Date.now() / 1000 });
    if (list.length > maxPerScope) this.data.vectors[scope] = list.slice(-maxPerScope);
    if (vector?.length && !this.data.dimension) this.data.dimension = vector.length;
    this.bump(scope);
    this.schedule();
  }

  pendingVectors(limit: number): Array<{ scope: string; index: number; text: string }> {
    const out: Array<{ scope: string; index: number; text: string }> = [];
    for (const [scope, list] of Object.entries(this.data.vectors)) {
      for (let i = 0; i < list.length; i++) {
        if (list[i] && !list[i]!.vector) {
          out.push({ scope, index: i, text: list[i]!.text });
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
  }

  setVector(scope: string, index: number, vector: readonly number[] | null): void {
    const item = this.data.vectors[scope]?.[index];
    if (!item) return;
    item.vector = vector?.length ? encodeVectorFp16(vector) : null;
    if (vector?.length && !this.data.dimension) this.data.dimension = vector.length;
    this.bump(scope);
    this.schedule();
  }

  /**
   * 清理已不存在的条目（表情删了/改名了）：keepTexts 是当前仍有效的文本集合。
   * 返回删掉的条数。参考 meme_manager 的 metadata inventory 对账思路。
   */
  prune(scope: string, keepTexts: ReadonlySet<string>): number {
    const list = this.data.vectors[scope];
    if (!list?.length) return 0;
    // 必须和 add() 用同一套键：入库时文本截到 200 字，比较时也要截。
    const keep = new Set([...keepTexts].map((text) => text.slice(0, 200)));
    const kept = list.filter((item) => keep.has(item.text));
    const removed = list.length - kept.length;
    if (!removed) return 0;
    this.data.vectors[scope] = kept;
    this.bump(scope);
    this.schedule();
    return removed;
  }

  stats(): IndexStats {
    let total = 0;
    let indexed = 0;
    let offDimension = 0;
    const dim = Number(this.data.dimension) || 0;
    for (const list of Object.values(this.data.vectors)) {
      for (const item of list) {
        total += 1;
        if (!item.vector) continue;
        indexed += 1;
        if (dim) {
          const bytes = Buffer.from(item.vector, 'base64').length;
          if (bytes / 2 !== dim) offDimension += 1;
        }
      }
    }
    return {
      schema: Number(this.data.schema) || 1,
      model: this.data.model_name ?? '',
      dimension: dim,
      total,
      indexed,
      offDimension,
    };
  }

  private matrixFor(scope: string): { dim: number; rows: number[]; matrix: Float32Array } | null {
    const version = this.versions.get(scope) ?? 0;
    const cached = this.cache.get(scope);
    if (cached && cached.version === version) return cached;
    const items = this.data.vectors[scope] ?? [];
    let dim = 0;
    const rows: number[] = [];
    const chunks: Float32Array[] = [];
    for (let i = 0; i < items.length; i++) {
      const enc = items[i]!.vector;
      if (!enc) continue;
      const vec = l2(decodeVectorFp16(enc));
      if (!dim) dim = vec.length;
      if (vec.length !== dim) continue; // 维度不齐（换过模型）跳过，不炸整库
      rows.push(i);
      chunks.push(vec);
    }
    if (!rows.length) {
      this.cache.set(scope, { version, dim: 0, rows: [], matrix: new Float32Array(0) });
      return this.cache.get(scope)!;
    }
    const matrix = new Float32Array(rows.length * dim);
    chunks.forEach((vec, r) => matrix.set(vec, r * dim));
    const entry = { version, dim, rows, matrix };
    this.cache.set(scope, entry);
    return entry;
  }

  /** Hybrid Recall：BM25 + Cosine 并行，RRF 融合；任一路空则只用另一路。 */
  hybridSearch(scope: string, query: string, queryVector: readonly number[] | null, topK: number): SearchHit[] {
    const items = this.data.vectors[scope] ?? [];
    if (!items.length || topK <= 0) return [];

    const queryTokens = tokenize(query);
    const bm25Hits = queryTokens.length
      ? bm25(queryTokens, items.map((it) => tokenize(it.text)))
          .map((score, idx) => ({ idx, score }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, topK * 2)
      : [];

    let cosineHits: Array<{ idx: number; score: number }> = [];
    const m = this.matrixFor(scope);
    if (queryVector?.length && m && m.rows.length && queryVector.length === m.dim) {
      const q = l2(Float32Array.from(queryVector));
      const scores = m.rows.map((_, r) => {
        let dot = 0;
        const base = r * m.dim;
        for (let d = 0; d < m.dim; d++) dot += m.matrix[base + d]! * q[d]!;
        return dot;
      });
      cosineHits = scores
        .map((score, r) => ({ idx: m.rows[r]!, score }))
        .filter((x) => x.score > COSINE_FLOOR)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK * 2);
    }

    if (!bm25Hits.length && !cosineHits.length) return [];
    const fused = rrf([bm25Hits, cosineHits]);
    const inBm25 = new Set(bm25Hits.map((h) => h.idx));
    const inCosine = new Set(cosineHits.map((h) => h.idx));
    return [...fused.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([idx, score]) => ({
        text: items[idx]!.text,
        score: +score.toFixed(4),
        via: inBm25.has(idx) && inCosine.has(idx) ? 'both' : inCosine.has(idx) ? 'vector' : 'bm25',
      }));
  }
}

/* ── embedding 客户端 ─────────────────────────────────────────────────── */

/** 兼容 OpenAI `/v1/embeddings` 与 Ollama `/api/embeddings` 两种回包；失败返回 null。 */
export class EmbeddingClient {
  private readonly url: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, readonly number[]>();

  constructor(opts: { url: string; model: string; timeoutMs?: number }) {
    this.url = String(opts.url ?? '').trim();
    this.model = String(opts.model ?? '').trim() || 'default';
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  signature(): string {
    return `http|${this.model}|${this.url}`;
  }

  async embed(text: string): Promise<readonly number[] | null> {
    const key = String(text ?? '').trim();
    if (!key || !this.url) return null;
    const hit = this.cache.get(key);
    if (hit) return hit;
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: key, prompt: key }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { embedding?: number[]; data?: Array<{ embedding?: number[] }> };
      const vector = Array.isArray(data.data) ? data.data[0]?.embedding : data.embedding;
      if (!Array.isArray(vector) || !vector.length) return null;
      if (this.cache.size > 512) this.cache.clear();
      this.cache.set(key, vector);
      return vector;
    } catch {
      return null;
    }
  }
}
