/**
 * 表情语义检索：把「一句话情绪/场景」变成最贴切的表情包 rel 候选列表。
 *
 * 数据与索引都归本扩展所有（<dataDir>/semantic.json 为描述源，vector-memory.json 为向量索引）；
 * 检索引擎（Hybrid Recall = BM25 + Cosine + RRF）与 embedding 客户端都在本包内
 * （见 semantic-engine.ts）——不再跨包 import 兄弟扩展，装这一个就不用装别的 world。
 *
 * 向量路是增强、不是依赖：索引刚建时全部走 BM25（caption/tags 的 CJK n-gram 分词已很能打），
 * 后台补索引进度推进后向量路逐渐生效。
 */
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';

import { EmbeddingClient, VectorStore } from './semantic-engine.ts';

export interface SemanticEmbedConfig {
  /** OpenAI 兼容 embedding 端点；留空 = 只走 BM25 文本检索（无向量路）。 */
  url?: string;
  model?: string;
  timeoutMs?: number;
}

export interface SemanticCoverage {
  /** 有描述的唯一图片数。 */
  captions: number;
  /** 其中已补上向量的条数（后台补索引进度）。 */
  indexed: number;
}

/** 单条语义描述（与 semantic.json 的 entries 同形）。 */
export interface SemanticEntry {
  caption: string;
  tags: string[];
  sha256?: string;
}

export interface SemanticIndex {
  /** 描述与索引是否就绪（semantic.json 读取成功）。 */
  ready(): boolean;
  /** 索引自检：schema 版本 / 模型 / 维度 / 条数 / 与当前维度不符的条数 / 本次清掉的旧条目。 */
  stats(): {
    schema: number;
    model: string;
    dimension: number;
    total: number;
    indexed: number;
    offDimension: number;
    pruned: number;
  };
  coverage(): SemanticCoverage;
  /** 语义检索：mood → 最贴切的 rel 列表（按贴合度降序）；不可用返回 []。 */
  search(mood: string, limit: number): Promise<string[]>;
  /** 落盘未写完的向量（World stop 时调用）。 */
  flush(): void;
  /** 已收录描述的 rel 全量列表（策展审计用）。 */
  rels(): string[];
  /** 某条 rel 的现有描述；没有返回 null。 */
  entry(rel: string): SemanticEntry | null;
  /**
   * 写入/更新一条描述：更新内存与检索映射、入库、（有 embedder 时）补这一条的向量，
   * 最后原子落盘 semantic.json。模型看图打标走这里。
   */
  describe(rel: string, caption: string, tags: string[]): Promise<{ embedded: boolean }>;
}

/**
 * 入库文本：caption + tags（tags 给 BM25 提供高信号词，如「比心/撒娇」）。
 *
 * caption 保持原文不动：向量是由 AstrBot 侧用 bge-m3 对**含模板前缀的原文**算好的（1024 维），
 * 这里若剥离前缀，文本键就与既有向量错位、命中会被直接丢弃——除非全量重新 embed。
 * 模板前缀对余弦相似度的相对排序影响很小，不值得为它重建索引。
 */
function indexText(entry: { caption: string; tags: string[] }): string {
  const tags = (entry.tags || []).join('、');
  return tags ? `${entry.caption}\n标签：${tags}` : entry.caption;
}

const SCOPE = 'stickers';
const MAX_PER_SCOPE = 2000;
const BACKFILL_BATCH = 8;
const BACKFILL_DELAY_MS = 150;

/**
 * 加载语义索引。任何失败（无 semantic.json / memory 扩展不在 / 引擎初始化失败）
 * 都返回 null——调用方退化到同义词表选图，绝不抛错。
 */
export async function loadSemanticIndex(
  dataDir: string,
  embed: SemanticEmbedConfig,
): Promise<SemanticIndex | null> {
  try {
    const file = resolve(dataDir, 'semantic.json');
    const raw = JSON.parse(await readFile(file, 'utf8')) as {
      version?: number;
      generated_at?: string;
      source?: string;
      entries?: Record<string, { sha256?: string; caption?: string; tags?: string[] }>;
    };
    const entries = raw.entries ?? {};
    const rels: string[] = Object.keys(entries);
    // 空 entries 也要加载：「冷启动 + 逐条 describe」是开源用户的正常路径，
    // 索引里没东西只代表 search 暂时没命中，不代表功能不可用。

    // caption 文本 → 该描述下的 rel 列表（同图多分类位置共享一条描述）
    const relsByText = new Map<string, string[]>();
    let captionCount = 0;
    const seenText = new Set<string>();
    for (const rel of rels) {
      const e = entries[rel]!;
      if (!e.caption) continue;
      const text = indexText({ caption: e.caption, tags: e.tags || [] });
      if (!seenText.has(text)) { seenText.add(text); captionCount++; }
      const list = relsByText.get(text) ?? [];
      list.push(rel);
      relsByText.set(text, list);
    }

    const store = new VectorStore(dataDir);

    // 全量入库（add 自带按文本去重，重复启动安全）
    for (const text of relsByText.keys()) {
      store.add(SCOPE, text, null, MAX_PER_SCOPE);
    }
    // 对账：表情删掉/改名后，旧向量不该一直留着
    const pruned = store.prune(SCOPE, new Set(relsByText.keys()));
    if (embed.model) store.setModel(embed.model);

    // embedding 客户端：端点留空时向量路关闭，BM25 照常
    let embedder: EmbeddingClient | null = null;
    if (embed.url) {
      embedder = new EmbeddingClient({
        url: embed.url,
        model: embed.model || 'default',
        timeoutMs: embed.timeoutMs ?? 30_000,
      });
    }

    let active = true;

    /** 原子落盘 semantic.json（临时文件 + rename，避免半截文件）。 */
    const persist = async (): Promise<void> => {
      raw.entries = entries;
      raw.version = raw.version ?? 1;
      raw.generated_at = new Date().toISOString();
      raw.source = raw.source ?? 'cortico-world-qq-stickers';
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(raw, null, 1), 'utf8');
      await rename(tmp, file);
    };

    /** 后台补向量：每次取一小批没向量的条目，逐条 embed 后原地回填。 */
    const backfill = async (): Promise<void> => {
      while (active) {
        const pending = store.pendingVectors(BACKFILL_BATCH);
        if (!pending.length) return;
        for (const item of pending) {
          if (!active) return;
          const vector = embedder ? await embedder.embed(item.text) : null;
          store.setVector(item.scope, item.index, vector);
        }
        await new Promise((r) => setTimeout(r, BACKFILL_DELAY_MS));
      }
    };
    void backfill().catch(() => { /* 后台补索引失败静默，BM25 照常 */ });

    return {
      ready: () => true,
      stats: () => ({ ...store.stats(), pruned }),
      coverage: () => {
        const pending = store.pendingVectors(MAX_PER_SCOPE).filter((p) => p.scope === SCOPE).length;
        return { captions: captionCount, indexed: Math.max(0, captionCount - pending) };
      },
      rels: () => Object.keys(entries),
      entry: (rel: string) => {
        const e = entries[rel];
        return e && e.caption ? { caption: e.caption, tags: e.tags || [], ...(e.sha256 ? { sha256: e.sha256 } : {}) } : null;
      },
      describe: async (rel: string, caption: string, tags: string[]): Promise<{ embedded: boolean }> => {
        const clean = String(caption ?? '').trim();
        const relKey = String(rel ?? '').trim();
        if (!relKey || !clean) throw new Error('rel 与 caption 都不能为空');
        const tagList = (Array.isArray(tags) ? tags : []).map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 16);
        const old = entries[relKey];
        const oldText = old?.caption ? indexText({ caption: old.caption, tags: old.tags || [] }) : '';
        const nextText = indexText({ caption: clean, tags: tagList });

        entries[relKey] = { ...(old || {}), caption: clean, tags: tagList };

        // 检索映射：旧文本去掉这条 rel（空列表删除），新文本追加
        if (oldText) {
          const list = relsByText.get(oldText);
          if (list) {
            const at = list.indexOf(relKey);
            if (at >= 0) list.splice(at, 1);
            if (!list.length) relsByText.delete(oldText);
          }
        }
        const list = relsByText.get(nextText) ?? [];
        if (!list.includes(relKey)) list.push(relKey);
        relsByText.set(nextText, list);
        if (!seenText.has(nextText)) {
          seenText.add(nextText);
          captionCount++;
        }

        // 入库 + 单条补向量：即时 embed（失败不影响写入，后台 backfill 会再补）
        store.add(SCOPE, nextText, null, MAX_PER_SCOPE);
        let embedded = false;
        if (embedder) {
          try {
            const vector = await embedder.embed(nextText);
            if (vector) {
              const hit = store.pendingVectors(MAX_PER_SCOPE).find((p) => p.scope === SCOPE && p.text === nextText);
              if (hit) store.setVector(hit.scope, hit.index, vector);
              embedded = true;
            }
          } catch {
            /* 留给后台 backfill */
          }
        }
        try {
          store.flush();
        } catch {
          /* 向量落盘失败不阻断描述写入 */
        }
        await persist();
        return { embedded };
      },
      search: async (mood: string, limit: number): Promise<string[]> => {
        const query = mood.trim();
        if (!query) return [];
        try {
          const vector = embedder ? await embedder.embed(query) : null;
          // 多取一倍再收敛：先按「强命中」筛（向量路命中 via=vector/both —— 真正语义相关），
          // 纯 BM25 词面命中在口语查询下噪声大，只在没有强命中时兜底使用。
          // hybridSearch 的 score 是 RRF 融合分，只反映名次、不做数值阈值；收敛靠 top-N + via。
          const hits = store.hybridSearch(SCOPE, query, vector, Math.max(6, limit * 2));
          const strong = vector ? hits.filter((h) => h.via !== 'bm25') : hits;
          const picked = (strong.length ? strong : hits).slice(0, Math.max(1, limit));
          const out: string[] = [];
          for (const hit of picked) {
            const list = relsByText.get(hit.text);
            if (!list?.length) continue;
            // 同一描述对应多个分类位置（硬链接）时随机取一个，避免总命中同一分类
            out.push(list[Math.floor(Math.random() * list.length)]!);
          }
          return out;
        } catch {
          return [];
        }
      },
      flush: () => {
        try { store.flush(); } catch { /* 落盘失败不打断停止流程 */ }
      },
    };
  } catch {
    return null;
  }
}
