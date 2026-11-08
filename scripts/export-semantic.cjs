/**
 * 一次性迁移脚本：把 AstrBot meme 包的语义元数据（caption/tags）按内容哈希
 * 映射到本地表情库的 rel 路径，产出 sticker-semantic/semantic.json。
 *
 * 本地文件名与包内文件名对不上（本地是「分类-角色-序号」重命名过的），必须按 sha256；
 * 同一张图在多个分类下是硬链接，多个 rel 共享同一条 caption。
 *
 * 用法：node scripts/export-semantic.cjs <meme_packs_dir> <emoji_dir> <out_dir>
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PACKS = process.argv[2] || 'D:/Tools/QQbot/AstrBot/instances/fd5a26eb-3c69-4bfd-96d0-816c067b27bb/core/data/plugin_data/meme_manager/packs';
const LIB = process.argv[3] || 'D:/Tools/Coopanion/data/home/companion/sticker-library';
const OUT = process.argv[4] || 'D:/Tools/Coopanion/data/home/companion/sticker-semantic';

// 1) 汇总各包元数据：sha → {caption, tags, category, vision_model, prompt_version}
const bySha = new Map();
let packEntries = 0;
for (const pack of fs.readdirSync(PACKS)) {
  const p = path.join(PACKS, pack, 'semantic_metadata.json');
  if (!fs.existsSync(p)) continue;
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const v of Object.values(m.images || {})) {
    if (!v || !v.content_sha256) continue;
    const caption = String(v.caption || v.caption_text || '').trim();
    if (!caption) continue;
    packEntries++;
    bySha.set(v.content_sha256.toLowerCase(), {
      caption,
      tags: Array.isArray(v.tags) ? v.tags : [],
      category: String(v.category || ''),
      vision_model: String(v.vision_model || ''),
      prompt_version: String(v.prompt_version || ''),
    });
  }
}
console.log(`包内带 caption 的条目: ${packEntries}，按内容哈希去重: ${bySha.size}`);

// 2) 本地库逐文件算 sha256，映射 rel
const entries = {};
let total = 0, hit = 0;
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { walk(path.join(dir, e.name)); continue; }
    if (!/\.(png|gif|jpe?g|webp)$/i.test(e.name)) continue;
    total++;
    const abs = path.join(dir, e.name);
    const sha = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    const meta = bySha.get(sha);
    if (!meta) return;
    hit++;
    const rel = path.relative(LIB, abs).replace(/\\/g, '/');
    entries[rel] = { sha256: sha, ...meta };
  }
};
walk(LIB);
console.log(`本地库文件: ${total}，命中: ${hit} (${Math.round((hit / total) * 100)}%)`);

// 3) 落盘
const out = {
  version: 1,
  generated_at: new Date().toISOString(),
  source: 'meme_manager semantic_metadata.json (按 content_sha256 迁移)',
  entries,
};
fs.mkdirSync(OUT, { recursive: true });
const outPath = path.join(OUT, 'semantic.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
console.log(`已写入 ${outPath}（${Object.keys(entries).length} 条 rel）`);
