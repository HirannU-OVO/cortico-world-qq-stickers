/**
 * 语义引擎自测（自带向量索引）：只碰临时目录，不写真实表情库。
 * 运行：node --experimental-strip-types test/semantic-engine.test.mjs
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EmbeddingClient,
  VectorStore,
  decodeVectorFp16,
  encodeVectorFp16,
  tokenize,
} from '../src/semantic-engine.ts';

const root = mkdtempSync(join(tmpdir(), 'sticker-engine-'));
let failures = 0;
/** 收集所有 store，退出前统一 flush 清定时器。 */
const stores = [];

function check(label, condition, detail = '') {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

try {
  // fp16 往返
  const sample = [0, 0.5, -0.5, 1, -1, 0.001, 123.456];
  const decoded = decodeVectorFp16(encodeVectorFp16(sample));
  check(
    'fp16 编解码往返误差可接受',
    sample.every((value, i) => Math.abs(value - decoded[i]) <= Math.max(1e-3, Math.abs(value) * 1e-3)),
    JSON.stringify([...decoded]),
  );

  // 分词：中文 2/3-gram，拉丁整词
  const tokens = tokenize('开心开心 happy2');
  check(
    '中文按 2/3-gram 切分',
    tokens.includes('开心') && tokens.includes('开心开') && tokens.includes('happy2'),
    JSON.stringify(tokens.slice(0, 8)),
  );

  // 入库 + 检索（只用 BM25，不依赖网络）
  const store = new VectorStore(root);
  stores.push(store);
  store.add('stickers', '开心 大笑 哈哈\n标签：开心、大笑', null, 100);
  store.add('stickers', '难过 想哭 流泪\n标签：难过', null, 100);
  store.add('stickers', '生气 愤怒 瞪人\n标签：生气', null, 100);
  const bm25Hits = store.hybridSearch('stickers', '开心', null, 2);
  check('纯 BM25 能命中「开心」', bm25Hits.length > 0 && bm25Hits[0].text.startsWith('开心'), JSON.stringify(bm25Hits));

  // 向量路：写入 1024 维归一化向量后应出现 via=vector/both
  const dim = 1024;
  const mk = (seed) => {
    const vec = new Array(dim).fill(0);
    vec[seed] = 1;
    return vec;
  };
  const idStore = new VectorStore(join(root, 'vec'));
  stores.push(idStore);
  idStore.add('stickers', '开心 大笑', null, 100);
  idStore.add('stickers', '难过 想哭', null, 100);
  const pending = idStore.pendingVectors(10);
  check('新条目先记为待补向量', pending.length === 2, JSON.stringify(pending));
  idStore.setVector('stickers', 0, mk(0));
  idStore.setVector('stickers', 1, mk(1));
  idStore.flush();
  const vecHits = idStore.hybridSearch('stickers', '开心', mk(0), 2);
  check('向量路命中且标 via', vecHits.length > 0 && vecHits[0].via !== 'bm25', JSON.stringify(vecHits));

  // 维度对账：换模型后维度不符的条目应被跳过并计数
  const misStore = new VectorStore(join(root, 'dim'));
  stores.push(misStore);
  misStore.add('stickers', '甲 条目', mk(0), 100);
  misStore.flush();
  const rawPath = join(root, 'dim', 'vector-memory.json');
  const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
  raw.vectors.stickers[0].vector = encodeVectorFp16([0.1, 0.2, 0.3]);
  writeFileSync(rawPath, JSON.stringify(raw), 'utf8');
  const reloaded = new VectorStore(join(root, 'dim'));
  stores.push(reloaded);
  const stats = reloaded.stats();
  check('stats 报出维度不符条数', stats.offDimension === 1 && stats.dimension === 1024, JSON.stringify(stats));

  // 失效清理：按 200 字键比对，长文本不该被误删
  const longText = '很长的描述'.repeat(60); // 超过 200 字
  const pruneStore = new VectorStore(join(root, 'prune'));
  stores.push(pruneStore);
  pruneStore.add('stickers', longText, null, 100);
  pruneStore.add('stickers', '短描述', null, 100);
  pruneStore.flush();
  const removedNone = new VectorStore(join(root, 'prune'));
  stores.push(removedNone);
  const removed = removedNone.prune('stickers', new Set([longText, '短描述']));
  check('长文本不会被误判失效', removed === 0, `删了 ${removed} 条`);
  const dropStore = new VectorStore(join(root, 'prune'));
  stores.push(dropStore);
  const dropped = dropStore.prune('stickers', new Set(['短描述']));
  check('确实失效的条目会被清掉', dropped === 1, `删了 ${dropped} 条`);

  // 原子落盘：schema 与 updated_at 会被写回
  const persisted = JSON.parse(readFileSync(rawPath, 'utf8'));
  check('落盘带 schema 与 updated_at', persisted.schema === 2 && typeof persisted.updated_at === 'string', JSON.stringify({ schema: persisted.schema }));

  // embedding 客户端：本地假服务，兼容两种回包
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/v1/embeddings') {
      res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }));
    } else {
      res.end(JSON.stringify({ embedding: [0.4, 0.5] }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const openai = new EmbeddingClient({ url: `http://127.0.0.1:${port}/v1/embeddings`, model: 'bge-m3', timeoutMs: 5000 });
    const v1 = await openai.embed('开心');
    check('OpenAI 兼容回包可解析', Array.isArray(v1) && v1.length === 3, JSON.stringify(v1));
    const ollama = new EmbeddingClient({ url: `http://127.0.0.1:${port}/api/embeddings`, model: 'bge-m3', timeoutMs: 5000 });
    const v2 = await ollama.embed('开心');
    check('Ollama 原生回包可解析', Array.isArray(v2) && v2.length === 2, JSON.stringify(v2));
    const empty = await new EmbeddingClient({ url: '', model: 'x' }).embed('开心');
    check('端点留空时返回 null（向量路关闭）', empty === null, String(empty));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
} finally {
  // 清掉防抖写盘定时器，避免进程退出时 libuv 报 handle 关闭告警
  for (const item of stores) {
    try { item.flush(); } catch { /* 忽略 */ }
  }
  rmSync(root, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} 条断言失败`);
  process.exit(1);
}
console.log('\n全部断言通过');
