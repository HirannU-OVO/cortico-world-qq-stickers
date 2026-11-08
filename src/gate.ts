/**
 * 表情包掷骰与选图核心（模块级单例）。
 *
 * 状态挂在本模块顶层：同进程内只要以同一 URL import 本文件（qq-stickers 的工具链路、
 * 其他扩展的发送兜底），共享的是同一份概率、保底、冷却与防重复状态——出图频率因此
 * 只有一处仲裁，不随调用方分裂。
 *
 * 本文件不得 import 'cortico/*' 虚拟模块：它会被兄弟扩展跨包动态加载，宿主之外
 * 也要能独立解析。日志通过 configureGate 注入，缺省静默。
 */
import { readdirSync, existsSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

export interface GateConfig {
  /** 表情库根目录：一级子文件夹即分类。 */
  emojiDir: string;
  /** 基础触发概率（0~1）。保底进度由该值推导。 */
  defaultChance: number;
  /** 全局发图冷却（秒，0 关）。 */
  cooldownSeconds: number;
  /** 单分类冷却（秒，0 关）。 */
  categoryCooldownSeconds: number;
  /** 防连发滑动窗口大小。 */
  recentHistorySize: number;
  /** 工具调用未显式传 random 时是否默认洗牌。 */
  defaultRandom: boolean;
  /** 工具调用默认返回条数。 */
  limit: number;
  /**
   * 外部分类别名（开源的库分类各不相同，别名表不能写死在代码里）：
   * 形如 { "开心": ["开森","乐呵"], "得意": ["有点得意","小得意"] }，与内置同义词表合并生效。
   */
  aliases?: Record<string, string[]>;
}

export interface GateLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export interface GateItem {
  category: string;
  /** 相对表情库根目录的 posix 路径，供 [表情包:路径] 使用。 */
  rel: string;
  name: string;
  /** 文件名前缀里的角色，如「bot」。 */
  character: string;
}

export interface GateScan {
  total: number;
  unique: number;
  byCategory: Map<string, number>;
  byCharacter: Map<string, number>;
  items: GateItem[];
}

export interface GateQuery {
  category: string;
  character: string;
  keyword: string;
  force: boolean;
  random: boolean;
  avoid: string[];
  limit: number;
  offset: number;
  /** 语义检索命中的 rel 列表：非空时优先在该池内选图，空/缺省走常规匹配。 */
  prefer?: string[];
}

export type GateSelection =
  | { kind: 'unavailable'; root: string }
  | { kind: 'skip'; reason: string }
  | { kind: 'none'; note: string; category: string; character: string; keyword: string }
  | { kind: 'exhausted'; note: string; matched: number; hint: string; offset: number }
  | { kind: 'page'; note: string; matched: number; hint: string; offset: number; items: GateItem[] };

/** autoPick 的结果：兜底方只需要知道过没过、选中哪张。 */
export interface AutoPickResult {
  pass: boolean;
  /** 未通过原因（冷却 / 概率 / 库不可用），已按给模型看的口吻措辞。 */
  reason?: string;
  rel?: string;
  category?: string;
  character?: string;
}

const IMAGE_EXTS = new Set(['.png', '.gif', '.jpg', '.jpeg', '.webp', '.bmp']);

/** 自家形象优先排序。 */
const RANK: Record<string, number> = { 小明: 0, 助手: 1 };

/** 情绪同义词 / 别名映射：情绪词 -> 库中实际的一级分类。 */
export const CATEGORY_SYNONYMS: Record<string, string[]> = {
  // 认真 / 坚定
  认真: ['坚定'],
  专注: ['坚定'],
  执着: ['坚定'],
  努力: ['坚定'],
  // 开心 / 高兴 / 快乐 / 欢呼
  高兴: ['开心'],
  快乐: ['开心'],
  欢呼: ['开心', '兴奋'],
  喜悦: ['开心'],
  乐: ['开心'],
  欢喜: ['开心'],
  大笑: ['开心'],
  微笑: ['开心'],
  好耶: ['开心', '兴奋'],
  // 得意 / 嘚瑟 / 傲娇
  嘚瑟: ['得意'],
  得瑟: ['得意'],
  傲娇: ['得意'],
  自豪: ['得意'],
  炫耀: ['得意'],
  // 难过 / 伤心 / 落泪 / 哭泣
  伤心: ['难过', '哭泣'],
  落泪: ['哭泣', '难过'],
  流泪: ['哭泣', '难过'],
  哭: ['哭泣', '难过'],
  悲伤: ['难过'],
  委屈: ['难过'],
  心碎: ['难过'],
  抑郁: ['难过'],
  难受: ['难过'],
  // 害羞 / 脸红 / 慌张
  脸红: ['害羞'],
  不好意思: ['害羞'],
  羞: ['害羞'],
  慌: ['慌张'],
  慌乱: ['慌张'],
  手足无措: ['慌张'],
  慌神: ['慌张'],
  // 困倦 / 困 / 睡觉 / 打哈欠
  困: ['困倦'],
  睡觉: ['困倦'],
  打哈欠: ['困倦'],
  困了: ['困倦'],
  想睡: ['困倦'],
  疲倦: ['困倦'],
  乏了: ['困倦'],
  // 思考 / 想 / 琢磨
  想: ['思考'],
  琢磨: ['思考'],
  沉思: ['思考'],
  寻思: ['思考'],
  // 困惑 / 疑惑 / 不解 / 问号
  疑惑: ['困惑'],
  不解: ['困惑'],
  问号: ['困惑'],
  纳闷: ['困惑'],
  迷茫: ['困惑'],
  不懂: ['困惑'],
  懵: ['困惑'],
  问号脸: ['困惑'],
  // 调皮 / 眨眼 / 嘟嘴 / 卖萌
  调皮: ['眨眼', '嘟嘴', '得意'],
  卖萌: ['嘟嘴', '眨眼', '喜欢'],
  撒娇: ['嘟嘴', '害羞', '喜欢'],
  // 喜欢 / 爱 / 摸摸
  爱: ['喜欢'],
  心动: ['喜欢'],
  好感: ['喜欢'],
  摸摸: ['喜欢'],
  抱抱: ['喜欢'],
  // 生气 / 愤怒
  愤怒: ['生气'],
  气: ['生气'],
  发火: ['生气'],
  恼火: ['生气'],
  // 害怕 / 恐惧
  恐惧: ['害怕'],
  吓: ['害怕'],
  惊恐: ['害怕'],
  // 兴奋 / 激动 / 嗨
  激动: ['兴奋'],
  嗨: ['兴奋'],
  燃: ['兴奋'],
  狂喜: ['兴奋'],
  // 平静 / 呆 / 无语
  无语: ['平静', '困惑'],
  呆: ['平静'],
  汗: ['困惑', '慌张'],
  尴尬: ['慌张', '困惑'],
};

// ---- 模块级单例状态 ----

let cfg: GateConfig | null = null;
let logger: GateLogger | null = null;
let cache: { at: number; scan: GateScan } | null = null;
/** 所有者（qq-stickers World）是否在运行。发送方据此守「表情管理关了就不发图」的规矩。 */
let ownerActive = false;
let lastGlobalSendAt = 0;
const lastCategorySendAt = new Map<string, number>();
let recentRel: string[] = [];
/** 连续掷骰未命中次数；自然出图与硬保底出图都会清零。仅统计运气未命中，冷却与无匹配不计入。 */
let missStreak = 0;
/** 本轮硬保底点（连不中多少次必出）；每轮开始时按概率推导并向下抖动 0~2。 */
let hardPoint = 0;
/** 上一轮使用的概率；用于在概率被修改时按比例缩放保底进度。 */
let lastChance = 0;

/** 注入/热更配置与日志；幂等，重复传同值无副作用。 */
export function configureGate(partial: Partial<GateConfig>, log?: GateLogger): void {
  if (log) logger = log;
  if (!cfg) {
    cfg = {
      emojiDir: '',
      defaultChance: 0.5,
      cooldownSeconds: 45,
      categoryCooldownSeconds: 90,
      recentHistorySize: 10,
      defaultRandom: true,
      limit: 5,
      ...partial,
    };
    return;
  }
  Object.assign(cfg, partial);
}

export function gateConfigured(): boolean {
  return cfg !== null;
}

/** 所有者 start 时置 true、stop 时置 false；发送方发图前必须问这一句。 */
export function markOwnerActive(active: boolean): void {
  ownerActive = active;
}

/** 表情扩展当前是否在运行：关了就任何链路都不该发图。 */
export function ownerIsActive(): boolean {
  return ownerActive;
}

/** 表情库根目录（所有者配置的 emojiDir）；未配置时为空串。 */
export function gateRoot(): string {
  return rootDir();
}

/** 面板徽标用的保底水位。 */
export function gatePity(): { missStreak: number; hardPoint: number } {
  syncChanceState();
  return { missStreak, hardPoint };
}

/** 停用时清空运行状态（配置保留与否由调用方决定）。 */
export function resetGateState(): void {
  cache = null;
  lastGlobalSendAt = 0;
  lastCategorySendAt.clear();
  recentRel = [];
  missStreak = 0;
  hardPoint = 0;
  lastChance = 0;
}

/** 库目录有变动（新增/移动图片）时清掉扫描缓存，下一次读取立刻反映新内容。 */
export function invalidateScanCache(): void {
  cache = null;
}

/** 外部分类别名反查表：别名 → 分类（含分类名自身），供 resolveMood 使用。 */
function externalAliasLookup(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const table = cfg?.aliases;
  if (!table) return out;
  for (const [category, aliases] of Object.entries(table)) {
    const cat = String(category ?? '').trim();
    if (!cat) continue;
    out.push([cat, cat]);
    for (const a of Array.isArray(aliases) ? aliases : []) {
      const alias = String(a ?? '').trim();
      if (alias && alias !== cat) out.push([alias, cat]);
    }
  }
  return out.sort((a, b) => b[0].length - a[0].length);
}

function rootDir(): string {
  return (cfg?.emojiDir ?? '').trim();
}

/** 硬保底上限：软保底起点之后最多再容忍多少倍间隔。 */
function capOf(base: number): number {
  const soft = Math.max(2, Math.ceil(1 / base));
  return Math.max(soft + 1, Math.ceil(2.5 / base));
}

/**
 * 概率变更时按比例缩放保底进度并同步硬保底上限。
 * 幂等：面板读取时调用也不会反复缩放。
 */
function syncChanceState(): void {
  const base = Math.min(1, Math.max(0, cfg?.defaultChance ?? 0.5));
  if (lastChance <= 0) {
    lastChance = base;
    return;
  }
  if (Math.abs(base - lastChance) <= 0.001) return;
  const prevCap = capOf(lastChance);
  const nextCap = capOf(base);
  missStreak = Math.max(0, Math.round((missStreak * nextCap) / prevCap));
  hardPoint = nextCap;
  lastChance = base;
}

/** 检定出图冷却与触发概率；pass 时 note 描述本轮掷骰结果，供工具输出回显。 */
function checkGate(category: string, force: boolean): { pass: boolean; reason?: string; note: string } {
  if (force) return { pass: true, note: '本轮强制出图（跳过掷骰与冷却）。' };

  const now = Date.now();
  const cooldownSec = cfg?.cooldownSeconds ?? 45;
  const catCooldownSec = cfg?.categoryCooldownSeconds ?? 90;

  // 1. 全局冷却检定
  if (cooldownSec > 0 && lastGlobalSendAt > 0) {
    const elapsed = (now - lastGlobalSendAt) / 1000;
    if (elapsed < cooldownSec) {
      const remain = Math.ceil(cooldownSec - elapsed);
      return { pass: false, note: '', reason: `本轮未通过：全局发图冷却中（还需等待 ${remain} 秒）。请本轮直接用纯文字自然回复，无需向用户解释冷却。` };
    }
  }

  // 2. 单分类冷却检定
  if (catCooldownSec > 0 && category) {
    const lastCatAt = lastCategorySendAt.get(category) ?? 0;
    if (lastCatAt > 0) {
      const elapsed = (now - lastCatAt) / 1000;
      if (elapsed < catCooldownSec) {
        const remain = Math.ceil(catCooldownSec - elapsed);
        return { pass: false, note: '', reason: `本轮未通过：情感分类「${category}」刚发过不久（冷却中，剩余 ${remain} 秒）。请尝试其他情感或用纯文字回复。` };
      }
    }
  }

  // 3. 概率掷骰检定：软保底 + 硬保底混合
  //    - 前 ceil(1/p) 次：纯随机，保持用户设定的体感
  //    - 之后到 ceil(2.5/p)：概率线性抬升（软保底）
  //    - 硬保底点：ceil(2.5/p) 向下抖动 0~2（只提前、不推后，避免"第 N 条必发"的机械规律）
  const base = Math.min(1, Math.max(0, cfg?.defaultChance ?? 0.5));
  syncChanceState();

  const soft = Math.max(2, Math.ceil(1 / base));
  const cap = capOf(base);
  // 新一轮开始时重摇硬保底点（只向下抖动，保证不会晚于承诺）
  if (missStreak === 0 || hardPoint <= 0) {
    hardPoint = Math.max(soft + 1, cap - Math.floor(Math.random() * 2.2));
  }

  let chance: number;
  if (base >= 1) chance = 1;
  else if (missStreak >= hardPoint - 1) chance = 1;
  else if (missStreak < soft) chance = base;
  else {
    const span = Math.max(1, hardPoint - soft);
    chance = base + (1 - base) * ((missStreak - soft) / span);
  }

  if (chance < 1.0 && Math.random() > chance) {
    missStreak += 1;
    return { pass: false, note: '', reason: `本轮未通过：掷骰未命中（命中率 ${Math.round(chance * 100)}%，第 ${missStreak} 次未中，保底进度 ${missStreak}/${hardPoint}）。请保持自然，用文字表达情感，不要道歉。` };
  }

  return { pass: true, note: `掷骰通过：本轮配图（命中率 ${Math.round(chance * 100)}%，保底进度 ${missStreak}/${hardPoint}）。` };
}

/** 记录出图成功，提交时间戳与近期历史 */
function commitSend(rel: string, category: string): void {
  const now = Date.now();
  lastGlobalSendAt = now;
  missStreak = 0;
  if (category) {
    lastCategorySendAt.set(category, now);
  }
  const maxRecent = cfg?.recentHistorySize ?? 10;
  const idx = recentRel.indexOf(rel);
  if (idx !== -1) recentRel.splice(idx, 1);
  recentRel.push(rel);
  while (recentRel.length > maxRecent) {
    recentRel.shift();
  }
}

/** 扫一遍表情库；5 秒内的重复调用复用结果，新增文件夹下一轮自动出现。 */
export function scanLibrary(): GateScan {
  if (cache && Date.now() - cache.at < 5000) return cache.scan;
  const scan: GateScan = { total: 0, unique: 0, byCategory: new Map(), byCharacter: new Map(), items: [] };
  const seen = new Set<string>();
  const root = rootDir();
  if (root && existsSync(root)) {
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch (e) {
      logger?.warn('表情库根目录读取失败', { err: String(e), root });
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // incoming 是「待归类」暂存区，不是分类——里面的图未入库，归位后才参与选图
      if (entry.name.toLowerCase() === 'incoming') continue;
      const category = entry.name;
      const dir = join(root, category);
      for (const rel of walk(dir, '')) {
        const name = rel.split('/').pop() ?? rel;
        const character = name.includes('-') ? name.split('-')[0] : '';
        scan.items.push({ category, rel: `${category}/${rel}`, name, character });
        scan.total++;
        scan.byCategory.set(category, (scan.byCategory.get(category) ?? 0) + 1);
        if (character) scan.byCharacter.set(character, (scan.byCharacter.get(character) ?? 0) + 1);
        // 同一张图在多个情感分类下是硬链接，按 inode 去重得到真实图片数
        let key = `${category}/${rel}`;
        try {
          const st = statSync(join(dir, rel), { bigint: true });
          key = `${st.dev}:${st.ino}`;
        } catch { /* 读不到就按路径去重 */ }
        if (!seen.has(key)) {
          seen.add(key);
          scan.unique++;
        }
      }
    }
  }
  cache = { at: Date.now(), scan };
  return scan;
}

/** 递归列出目录下的图片（posix 相对路径），跳过不可读目录。 */
function walk(dir: string, prefix: string): string[] {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walk(join(dir, entry.name), rel));
    } else if (IMAGE_EXTS.has(extname(entry.name).toLowerCase())) {
      out.push(rel);
    }
  }
  return out;
}

/** 归一化调用方传入的避开列表。 */
export function parseAvoid(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((x): x is string => typeof x === 'string').map((s) => s.trim().toLowerCase())
    : [];
}

/**
 * 情感词先落到分类（含同义词）：复合词先切分（空格/顿号/逗号/「的」等），逐词过同义词表，
 * 取第一个命中；全落空返回空，交由上层走全库兜底，不再退化为文件名关键词搜索
 * （复合词拿去搜文件名几乎必空，还消耗一次检定）。
 */
/**
 * 否定前缀：子串命中情绪词时，紧邻前方是否定词则该片段作废（「不开心」≠「开心」）。
 * 只收误伤率低的否定词——单字「别/无/非」不收：「特别」末尾是「别」、「无比/非常」是程度副词，
 * 收进来会把「特别难过」判成否定反而漏配。
 */
const NEGATORS = ['不', '没', '没有', '不太', '不怎么', '并不', '毫无', '从不'];

function negatedAt(text: string, at: number): boolean {
  const before = text.slice(Math.max(0, at - 3), at);
  return NEGATORS.some((n) => before.endsWith(n));
}

/**
 * 情感词 → 分类：精确优先，子串兜底（修饰语变体：有点得意 / 挺开心 / 特别难过）。
 * 子串命中要求 ≥2 字且前方无否定词；单字同义词（气/爱/想/哭…）不参与子串，
 * 否则「天气」会被认成「生气」。全落空返回空，由调用方走语义检索或全库兜底。
 */
export function resolveMood(mood: string): { category: string; keyword: string } {
  if (!mood) return { category: '', keyword: '' };
  const scan = scanLibrary();
  const words = mood.split(/[\s,，、·。/的]+/).filter(Boolean);
  const categories = [...scan.byCategory.keys()].sort((a, b) => b.length - a.length);
  const synKeys = Object.keys(CATEGORY_SYNONYMS)
    .filter((k) => k.length >= 2)
    .sort((a, b) => b.length - a.length);
  const extAliases = externalAliasLookup().filter(([alias]) => alias.length >= 2);

  for (const word of words) {
    // 1) 精确匹配（快路径，保持原行为）
    if (scan.byCategory.has(word)) return { category: word, keyword: '' };
    if ((CATEGORY_SYNONYMS[word] ?? []).some((c) => scan.byCategory.has(c))) return { category: word, keyword: '' };
    const exactExt = extAliases.find(([alias]) => alias === word);
    if (exactExt && scan.byCategory.has(exactExt[1])) return { category: exactExt[1], keyword: '' };

    // 2) 子串匹配：分类名 → 内置同义词键 → 外部分类别名（均带否定护栏）
    for (const cat of categories) {
      const at = word.indexOf(cat);
      if (at >= 0 && !negatedAt(word, at)) return { category: cat, keyword: '' };
    }
    for (const key of synKeys) {
      const at = word.indexOf(key);
      if (at >= 0 && !negatedAt(word, at) && CATEGORY_SYNONYMS[key]!.some((c) => scan.byCategory.has(c))) {
        return { category: key, keyword: '' };
      }
    }
    for (const [alias, cat] of extAliases) {
      const at = word.indexOf(alias);
      if (at >= 0 && !negatedAt(word, at) && scan.byCategory.has(cat)) return { category: cat, keyword: '' };
    }
  }
  return { category: '', keyword: '' };
}

/** 统一的挑选实现：频控、掷骰、同义词、防重复、洗牌都在这里。 */
export function selectStickers(q: GateQuery): GateSelection {
  const scan = scanLibrary();
  if (!scan.total) {
    return { kind: 'unavailable', root: rootDir() };
  }

  // A. 频控与掷骰检定（每次调用都必须过闸，频率完全由插件决定）
  const gate = checkGate(q.category, q.force);
  if (!gate.pass) {
    logger?.info(`[表情包] 跳过：${gate.reason ?? ''}`);
    return { kind: 'skip', reason: gate.reason ?? '' };
  }

  // B. 匹配候选列表函数
  const findMatches = (targetCats: string[]) => {
    return scan.items.filter((m) => {
      if (targetCats.length > 0) {
        const mCat = m.category.toLowerCase();
        if (!targetCats.some((c) => mCat.includes(c) || c.includes(mCat))) return false;
      }
      if (q.character && !`${m.character} ${m.name}`.toLowerCase().includes(q.character)) return false;
      if (q.keyword && ![m.category, m.character, m.name, m.rel].join(' ').toLowerCase().includes(q.keyword)) return false;
      return true;
    });
  };

  let matched: GateItem[] = [];
  let hint = '';

  // B0. 语义候选池：调用方给了 prefer（语义检索命中的 rel 列表）时优先在其内选；
  // 命中集为空则原样退回常规匹配，掷骰之后的任何环节都不受影响。
  if (q.prefer && q.prefer.length) {
    const preferSet = new Set(q.prefer.map((x) => String(x).trim().toLowerCase()));
    matched = scan.items.filter((m) => preferSet.has(m.rel.toLowerCase()));
    if (matched.length) {
      hint = `（语义检索命中 ${matched.length} 张）`;
    }
  }

  if (!matched.length) {
    if (q.category) {
      // 1. 先用原始传入的 category 查找
      matched = findMatches([q.category]);
      // 2. 如果直接匹配不到，尝试通过同义词映射扩展转换后再匹配
      if (!matched.length) {
        const mapped = CATEGORY_SYNONYMS[q.category] ?? [];
        if (mapped.length > 0) {
          matched = findMatches(mapped.map((s) => s.toLowerCase()));
          if (matched.length > 0) {
            hint = `（已将「${q.category}」映射为「${mapped.join(' / ')}」进行匹配）`;
          }
        }
      }
    } else {
      matched = findMatches([]);
    }

    if (!matched.length && q.category) {
      // 掷骰已经通过，绝不能让模型拿到「通过但空手」：分类与同义词都没匹配时回退全库随机
      matched = findMatches([]);
      if (matched.length) {
        hint = `（「${q.category}」没有匹配的表情，已从全库兜底随机）`;
      }
    }
  }

  if (!matched.length) {
    logger?.info(`[表情包] 无匹配（情感=${q.category || '-'}，角色=${q.character || '-'}，关键词=${q.keyword || '-'}）`);
    return { kind: 'none', note: gate.note, category: q.category, character: q.character, keyword: q.keyword };
  }

  // C. 防连发重复机制：收集所有需避开的项（传入的 avoid 以及内存中最近输出过的 recent）
  const avoidSet = new Set<string>([...recentRel.map((s) => s.toLowerCase()), ...q.avoid]);
  const isAvoided = (item: GateItem) => {
    const relLower = item.rel.toLowerCase();
    const nameLower = item.name.toLowerCase();
    for (const a of avoidSet) {
      if (!a) continue;
      if (relLower.includes(a) || nameLower.includes(a)) return true;
    }
    return false;
  };

  // 弹性兜底保障：优先排除 avoid 与 recent，但若排除后为空则全量回退，绝不报空
  const freshMatches = matched.filter((item) => !isAvoided(item));
  if (freshMatches.length > 0) {
    matched = freshMatches;
  }

  // D. 乱序洗牌与自家优先
  if (q.random) {
    for (let i = matched.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [matched[i], matched[j]] = [matched[j], matched[i]];
    }
  } else {
    matched.sort((a, b) => {
      if (a.category !== b.category) return a.category.localeCompare(b.category, 'zh');
      const ra = RANK[a.character] ?? 9;
      const rb = RANK[b.character] ?? 9;
      if (ra !== rb) return ra - rb;
      if (a.character !== b.character) return a.character.localeCompare(b.character, 'zh');
      return a.name.localeCompare(b.name, 'zh');
    });
  }

  const page = matched.slice(q.offset, q.offset + q.limit);
  if (!page.length) {
    return { kind: 'exhausted', note: gate.note, matched: matched.length, hint, offset: q.offset };
  }

  // E. 提交本次出图状态（刷新冷却时间戳与 LRU 滑动窗口）
  commitSend(page[0].rel, page[0].category);
  return { kind: 'page', note: gate.note, matched: matched.length, hint, offset: q.offset, items: page };
}

/**
 * 发送兜底入口：完整走冷却 + 概率掷骰 + 保底（selectStickers 内含单次过闸），通过则直接选一张。
 * 供发送方在正文缺表情标记时调用；未配置（表情扩展未启用且未给目录）时返回 pass:false。
 */
export function autoPick(opts?: { force?: boolean; mood?: string; avoid?: string[]; emojiDir?: string; prefer?: string[] }): AutoPickResult {
  if (!cfg) {
    // 允许兜底方在表情扩展未挂载时用目录兜底配置；概率等仍取默认
    if (opts?.emojiDir) {
      configureGate({ emojiDir: opts.emojiDir });
    } else {
      return { pass: false, reason: '表情包功能未配置' };
    }
  } else if (opts?.emojiDir && opts.emojiDir.trim() && !rootDir()) {
    cfg.emojiDir = opts.emojiDir.trim();
  }

  const mood = (opts?.mood ?? '').trim().toLowerCase();
  const resolved = mood ? resolveMood(mood) : { category: '', keyword: '' };
  const sel = selectStickers({
    category: resolved.category,
    character: '',
    keyword: resolved.keyword,
    force: opts?.force ?? false,
    random: true,
    avoid: parseAvoid(opts?.avoid),
    limit: 1,
    offset: 0,
    prefer: opts?.prefer,
  });
  if (sel.kind === 'unavailable') {
    return { pass: false, reason: '表情库为空或目录不存在' };
  }
  if (sel.kind === 'skip') {
    return { pass: false, reason: sel.reason };
  }
  if (sel.kind !== 'page' || sel.items.length === 0) {
    return { pass: false, reason: '没有匹配的表情包' };
  }
  const chosen = sel.items[0];
  return { pass: true, rel: chosen.rel, category: chosen.category, character: chosen.character };
}
