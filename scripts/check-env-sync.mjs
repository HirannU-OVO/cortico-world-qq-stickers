// 校验提示词单源一致性：
// 1) describe.json 里内嵌的 envPrompt 必须与当前主用（AstrBot 桥）那份成品逐字一致；
// 2) 两套发图通道的成品模板都必须存在，且各自用到的占位符齐全。
import { readFileSync } from 'node:fs';

const normalize = (s) => s.replace(/\r\n/g, '\n');

const bridge = normalize(readFileSync(new URL('../src/ENV_PROMPT_BRIDGE.md', import.meta.url), 'utf8'));
const qqfinal = normalize(readFileSync(new URL('../src/ENV_PROMPT_QQFINAL.md', import.meta.url), 'utf8'));
const describe = JSON.parse(readFileSync(new URL('../describe.json', import.meta.url), 'utf8'));
const embedded = describe.prompts?.find((p) => p.role === 'envPrompt')?.content;

const problems = [];
if (embedded === undefined) {
  problems.push('describe.json 缺少 role=envPrompt 的 prompts 条目');
} else if (normalize(embedded) !== bridge) {
  problems.push('describe.json 的 envPrompt 与 src/ENV_PROMPT_BRIDGE.md 不一致（改了其中一处忘了另一处）');
}
if (!bridge.includes('{{stickerLibraryLine}}')) problems.push('ENV_PROMPT_BRIDGE.md 缺少 {{stickerLibraryLine}} 占位');
if (!qqfinal.includes('{{stickerTotal}}') || !qqfinal.includes('{{stickerCategories}}')) {
  problems.push('ENV_PROMPT_QQFINAL.md 缺少 {{stickerTotal}} / {{stickerCategories}} 占位');
}

if (problems.length > 0) {
  console.error('提示词同步校验失败：');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('提示词同步校验通过：describe.json 与桥接模式成品一致，两套通道的模板与占位符齐全。');
