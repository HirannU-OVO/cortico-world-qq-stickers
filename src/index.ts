// 框架按 package.json 的 main 导入本文件，并读取具名导出 id/label/defaults/create 作为 WorldDefinition。
import { readdirSync, existsSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolDef, World, WorldHost } from 'cortico/core/types.ts';
import type { WorldContext, WorldDefinition } from 'cortico/world.ts';

interface CatalogConfig {
  enabled: boolean;
  /** 表情库根目录：一级子文件夹即分类，图片可以再往下分。 */
  emojiDir?: string;
  /** sticker_catalog 默认返回条数。 */
  limit?: number;
  /** 全局默认触发概率（0.0 ~ 1.0，默认 0.5）。 */
  defaultChance?: number;
  /** 全局发图冷却时间（秒，默认 45 秒，0 为关）。 */
  cooldownSeconds?: number;
  /** 单一情感分类冷却时间（秒，默认 90 秒，0 为关）。 */
  categoryCooldownSeconds?: number;
  /** 防连发滑动窗口大小（保留最近 N 张不重复输出，默认 10）。 */
  recentHistorySize?: number;
  /** 默认输出是否打乱（默认 true）。 */
  defaultRandom?: boolean;
  /** 是否把「情绪配图」说明注入系统前缀。 */
  promptEnabled?: boolean;
  /** 注入的正文；空则用内置默认。 */
  promptText?: string;
}

interface Item {
  category: string;
  /** 相对表情库根目录的 posix 路径，供 [表情包:路径] 使用。 */
  rel: string;
  name: string;
  /** 文件名前缀里的角色，如「大肥鱼」。 */
  character: string;
}

interface Scan {
  /** 可直接发送的条目数（同一张图可能挂在多个分类下）。 */
  total: number;
  /** 去重后的实际图片数（按 inode 判定）。 */
  unique: number;
  byCategory: Map<string, number>;
  byCharacter: Map<string, number>;
  items: Item[];
}

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** 自家形象优先排序。 */
const RANK: Record<string, number> = { 大肥鱼: 0, DeepSeek: 1 };

const IMAGE_EXTS = new Set(['.png', '.gif', '.jpg', '.jpeg', '.webp', '.bmp']);

const DEFAULT_PROMPT =
  '想发 QQ 表情包时，先用 sticker_catalog 按情感或角色挑一张，拿到真实路径，再在回复里写 [表情包:分类/文件名]；不要编造文件名。\n' +
  '【发图节奏】表情包是表达情绪的佐料，适度使用（参考每约 3~5 轮回复配 1 张，一次最多一张，不是每句必带；没有贴切的不发）。\n' +
  '【频控跳过】工具自身有冷却和概率机制，返回 [出图跳过] 是正常的节流保护，不是报错；请直接用文字自然表达，严禁向用户解释冷却或为此道歉！\n' +
  '【语音与表情包纪律】QQ 发语音（voice=true）时，正文严禁携带任何 [表情包:路径] 或 [图片:路径] 标记，避免 TTS 把表情包标记当成台词念出来；发语音时只发纯台词，想发表情包请单走普通文字消息。';

const PROMPT_MAX_LENGTH = 2000;

/** 情绪同义词 / 别名映射：用户或模型传入的情绪词 -> 库中实际的一级分类。 */
const CATEGORY_SYNONYMS: Record<string, string[]> = {
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

const TOOL_SPEC = {
  name: 'sticker_catalog',
  description:
    '挑选或浏览本地 QQ/桌宠表情包库。可按情感分类（如 开心、得意、难过、困惑，支持同义词转换）、角色或关键词挑选。工具内置频控冷却与概率掷骰机制：当返回 [出图跳过: ...] 时，表示本次属于正常频控节流，请直接用纯文字自然回复，绝不要道歉或提及冷却。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      category: {
        type: 'string',
        title: '情感分类',
        description: '按一级文件夹筛选，如 开心、得意、困惑、难过；支持模糊匹配与同义词转换（如 快乐->开心、认真->坚定）。留空时不限制分类。',
      },
      character: {
        type: 'string',
        title: '角色',
        description: '按文件名前缀的角色筛选，如 大肥鱼、DeepSeek、菲比；模糊匹配。',
      },
      keyword: {
        type: 'string',
        title: '关键词',
        description: '在分类、角色、文件名里模糊综合匹配。',
      },
      random: {
        type: 'boolean',
        title: '随机打乱',
        description: '是否打乱返回顺序（默认 true，乱序挑选；false 则按分类/角色/名称确定性排序）。',
      },
      avoid: {
        type: 'array',
        items: { type: 'string' },
        title: '避开的表情',
        description: '需要临时避开的表情包路径或文件名列表（如最近几轮发过的图），匹配充足时优先排除。',
      },
      force: {
        type: 'boolean',
        title: '强制出图',
        description: '是否绕过概率掷骰与冷却时间限制（测试或极关键情绪场景使用）。',
      },
      limit: {
        type: 'number',
        title: '条数',
        description: '本次返回多少条候选，默认取配置值，最大 50。',
      },
      offset: {
        type: 'number',
        title: '偏移',
        description: '从第几条开始，用于翻页，默认 0。',
      },
    },
    required: [],
  },
  tags: ['read'] as const,
};

/** 只读地浏览与挑选表情库：按分类/角色/关键词挑图，供 QQ bot 用 [表情包:路径] 发送。 */
class StickerCatalogWorld implements World {
  readonly id = 'qq-stickers';
  private readonly cfg: CatalogConfig;
  private host: WorldHost | null = null;
  private cache: { at: number; scan: Scan } | null = null;

  // 状态机：记录全局上次出图时间、单分类上次出图时间、近期展示历史
  private lastGlobalSendAt = 0;
  private lastCategorySendAt = new Map<string, number>();
  private recentRel: string[] = [];

  constructor(ctx: WorldContext<CatalogConfig>) {
    this.cfg = ctx.cfg;
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    const scan = this.scan();
    host.log.info(`表情包目录已就绪：${scan.unique} 张图 / ${scan.total} 个分类条目，共 ${scan.byCategory.size} 个分类，根目录 ${this.root()}`);
  }

  async stop(): Promise<void> {
    this.host = null;
    this.cache = null;
    this.lastGlobalSendAt = 0;
    this.lastCategorySendAt.clear();
    this.recentRel = [];
  }

  envPromptVars(): Record<string, string> | null {
    if (this.cfg.promptEnabled === false) return null;
    const scan = this.scan();
    if (!scan.total) return null;
    const cats = [...scan.byCategory.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ${n}`)
      .join('、');
    return {
      stickerTotal: String(scan.unique),
      stickerCategories: cats,
      stickerPrompt: this.promptText(),
    };
  }

  webUi() {
    return {
      badges: [{ label: '表情包', value: this.scan().unique, tone: 'on' as const }],
      config: [
        {
          id: 'world:qq-stickers',
          owner: 'world:qq-stickers',
          schema: {
            type: 'object',
            title: 'QQ表情管理',
            description: '本地情感表情包库：内置触发概率、防连发冷却锁、同义词智能映射与去重洗牌机制。',
            properties: {
              'worlds.qq-stickers.emojiDir': {
                type: 'string',
                title: '表情库根目录',
                description: '一级子文件夹即情感分类。改完约 5 秒后生效。',
                'x-hot': true,
                'x-path': { kind: 'directory' as const, recommendedDir: this.root() },
              },
              'worlds.qq-stickers.limit': {
                type: 'number',
                title: '默认返回条数',
                description: 'sticker_catalog 不传 limit 时的默认候选条数，1~50。',
                minimum: 1,
                maximum: 50,
                'x-hot': true,
              },
              'worlds.qq-stickers.defaultChance': {
                type: 'number',
                title: '基础触发概率 (0~1)',
                description: '模型尝试挑图时命中的基础概率。默认 0.5（50% 概率出图，其余跳过引导模型纯文字回复）。',
                minimum: 0.0,
                maximum: 1.0,
                multipleOf: 0.05,
                'x-hot': true,
              },
              'worlds.qq-stickers.cooldownSeconds': {
                type: 'number',
                title: '全局发图冷却时间 (秒)',
                description: '两次发图之间的最短间隔时间（默认 45 秒）。处于冷却期内会返回友好跳过提示。设为 0 关闭。',
                minimum: 0,
                maximum: 600,
                'x-hot': true,
              },
              'worlds.qq-stickers.categoryCooldownSeconds': {
                type: 'number',
                title: '同类情感冷却时间 (秒)',
                description: '同一分类（如 开心）连续出图的最短间隔（默认 90 秒），避免反复发同一种表情。设为 0 关闭。',
                minimum: 0,
                maximum: 600,
                'x-hot': true,
              },
              'worlds.qq-stickers.recentHistorySize': {
                type: 'number',
                title: '防重复历史记忆窗口',
                description: '在内存中记住最近输出过的表情数量（默认 10 张），匹配充裕时强制避开，杜绝连撞。',
                minimum: 3,
                maximum: 30,
                'x-hot': true,
              },
              'worlds.qq-stickers.defaultRandom': {
                type: 'boolean',
                title: '默认随机乱序',
                description: '调用不显式传 random 时是否默认随机打乱候选顺序（默认开启）。',
                'x-hot': true,
              },
              'worlds.qq-stickers.promptEnabled': {
                type: 'boolean',
                title: '注入情绪配图说明',
                description: '关掉后系统前缀里不再出现这段发图纪律说明，工具依然可用。',
                'x-hot': true,
              },
              'worlds.qq-stickers.promptText': {
                type: 'string',
                title: '情绪配图说明正文',
                description: `留空用内置默认；最多 ${PROMPT_MAX_LENGTH} 字。改完下一轮生效。`,
                'x-hot': true,
              },
            },
          },
        },
      ],
      promptDocs: [
        {
          key: 'worlds.qq-stickers.envPrompt',
          title: 'QQ表情管理 · 环境提示词',
          description: '进 system 前缀的那一段：可编辑的发图纪律，加上库规模与分类概览。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt' as const,
          vars: [
            { name: 'stickerPrompt', description: '面板里可编辑的发图说明正文' },
            { name: 'stickerTotal', description: '表情包总数' },
            { name: 'stickerCategories', description: '按分类的分布' },
          ],
        },
      ],
    };
  }

  tools(): ToolDef[] {
    return [{ ...TOOL_SPEC, barrierAfter: true, handler: async (args) => this.run(args) }];
  }

  private root(): string {
    return (this.cfg.emojiDir ?? '').trim();
  }

  private promptText(): string {
    const custom = (this.cfg.promptText ?? '').trim();
    return (custom || DEFAULT_PROMPT).slice(0, PROMPT_MAX_LENGTH);
  }

  /** 检定出图冷却与触发概率 */
  private checkGate(category: string, force: boolean): { pass: boolean; reason?: string } {
    if (force) return { pass: true };

    const now = Date.now();
    const cooldownSec = this.cfg.cooldownSeconds ?? 45;
    const catCooldownSec = this.cfg.categoryCooldownSeconds ?? 90;

    // 1. 全局冷却检定
    if (cooldownSec > 0 && this.lastGlobalSendAt > 0) {
      const elapsed = (now - this.lastGlobalSendAt) / 1000;
      if (elapsed < cooldownSec) {
        const remain = Math.ceil(cooldownSec - elapsed);
        return { pass: false, reason: `全局发图冷却中（还需等待 ${remain} 秒）。请本轮直接用纯文字自然回复，无需向用户解释冷却。` };
      }
    }

    // 2. 单分类冷却检定
    if (catCooldownSec > 0 && category) {
      const lastCatAt = this.lastCategorySendAt.get(category) ?? 0;
      if (lastCatAt > 0) {
        const elapsed = (now - lastCatAt) / 1000;
        if (elapsed < catCooldownSec) {
          const remain = Math.ceil(catCooldownSec - elapsed);
          return { pass: false, reason: `情感分类「${category}」刚发过不久（冷却中，剩余 ${remain} 秒）。请尝试其他情感或用纯文字回复。` };
        }
      }
    }

    // 3. 概率掷骰检定
    const chance = Math.min(1, Math.max(0, this.cfg.defaultChance ?? 0.5));
    if (chance < 1.0 && Math.random() > chance) {
      return { pass: false, reason: `本轮配图掷骰未命中（触发概率 ${Math.round(chance * 100)}%）。请保持自然，用文字表达情感，不要道歉。` };
    }

    return { pass: true };
  }

  /** 记录出图成功，提交时间戳与近期历史 */
  private commitSend(rel: string, category: string): void {
    const now = Date.now();
    this.lastGlobalSendAt = now;
    if (category) {
      this.lastCategorySendAt.set(category, now);
    }
    const maxRecent = this.cfg.recentHistorySize ?? 10;
    const idx = this.recentRel.indexOf(rel);
    if (idx !== -1) this.recentRel.splice(idx, 1);
    this.recentRel.push(rel);
    while (this.recentRel.length > maxRecent) {
      this.recentRel.shift();
    }
  }

  /** 扫一遍表情库；5 秒内的重复调用复用结果，新增文件夹下一轮自动出现。 */
  private scan(): Scan {
    if (this.cache && Date.now() - this.cache.at < 5000) return this.cache.scan;
    const scan: Scan = { total: 0, unique: 0, byCategory: new Map(), byCharacter: new Map(), items: [] };
    const seen = new Set<string>();
    const root = this.root();
    if (root && existsSync(root)) {
      let entries: import('node:fs').Dirent[] = [];
      try {
        entries = readdirSync(root, { withFileTypes: true });
      } catch (e) {
        this.host?.log.warn('表情库根目录读取失败', { err: String(e), root });
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const category = entry.name;
        const dir = join(root, category);
        for (const rel of this.walk(dir, '')) {
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
    this.cache = { at: Date.now(), scan };
    return scan;
  }

  /** 递归列出目录下的图片（posix 相对路径），跳过不可读目录。 */
  private walk(dir: string, prefix: string): string[] {
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
        out.push(...this.walk(join(dir, entry.name), rel));
      } else if (IMAGE_EXTS.has(extname(entry.name).toLowerCase())) {
        out.push(rel);
      }
    }
    return out;
  }

  private run(args: Record<string, unknown>): string {
    const scan = this.scan();
    if (!scan.total) {
      return `表情库为空或目录不存在：${this.root() || '（未配置 emojiDir）'}。请在 World 配置里指定表情库根目录。`;
    }

    const text = (k: string) => (typeof args[k] === 'string' ? (args[k] as string).trim().toLowerCase() : '');
    const rawCategory = text('category');
    const character = text('character');
    const keyword = text('keyword');
    const force = Boolean(args.force);
    const random = args.random !== undefined ? Boolean(args.random) : (this.cfg.defaultRandom ?? true);
    const avoidParam = Array.isArray(args.avoid)
      ? (args.avoid.filter((x): x is string => typeof x === 'string').map((s) => s.trim().toLowerCase()) as string[])
      : [];
    const num = (k: string, def: number) => {
      const n = Number(args[k]);
      return Number.isFinite(n) ? n : def;
    };
    const limit = Math.max(1, Math.min(50, num('limit', this.cfg.limit ?? 5)));
    const offset = Math.max(0, num('offset', 0));

    // A. 纯目录概览请求（不带筛选参数），直接放行返回库概览，不扣除冷却与掷骰
    if (!rawCategory && !character && !keyword) {
      const cats = [...scan.byCategory.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join('、');
      const chars = [...scan.byCharacter.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join('、');
      return (
        `表情库共 ${scan.unique} 张图（按情感挂了 ${scan.total} 个可直接发送的条目，同一张图可能出现在多个分类下）。\n` +
        `分类：${cats}\n角色：${chars || '（文件名不带角色前缀）'}\n` +
        '用 category（分类）或 character（角色）筛选；也可用 keyword 模糊搜。拿到文件名后写 [表情包:分类/文件名] 发图。'
      );
    }

    // B. 意图挑选表情包，进入频控与冷却检定流水线
    const gate = this.checkGate(rawCategory, force);
    if (!gate.pass) {
      return `[出图跳过] ${gate.reason}`;
    }

    // C. 匹配候选列表函数
    const findMatches = (targetCats: string[]) => {
      return scan.items.filter((m) => {
        if (targetCats.length > 0) {
          const mCat = m.category.toLowerCase();
          if (!targetCats.some((c) => mCat.includes(c) || c.includes(mCat))) return false;
        }
        if (character && !`${m.character} ${m.name}`.toLowerCase().includes(character)) return false;
        if (keyword && ![m.category, m.character, m.name, m.rel].join(' ').toLowerCase().includes(keyword)) return false;
        return true;
      });
    };

    let matched: Item[] = [];
    let matchedCategoryHint = '';

    if (rawCategory) {
      // 1. 先用原始传入的 category 查找
      matched = findMatches([rawCategory]);
      // 2. 如果直接匹配不到，尝试通过同义词映射扩展转换后再匹配
      if (!matched.length) {
        const mapped = CATEGORY_SYNONYMS[rawCategory] ?? [];
        if (mapped.length > 0) {
          matched = findMatches(mapped.map((s) => s.toLowerCase()));
          if (matched.length > 0) {
            matchedCategoryHint = `（已将「${rawCategory}」映射为「${mapped.join(' / ')}」进行匹配）`;
          }
        }
      }
    } else {
      matched = findMatches([]);
    }

    if (!matched.length) {
      return `没有匹配的表情包（category=${rawCategory || '-'} character=${character || '-'} keyword=${keyword || '-'}）。可以先不带参数看看有哪些分类。`;
    }

    // D. 防连发重复机制：收集所有需避开的项（传入的 avoid 以及内存中最近输出过的 recent）
    const avoidSet = new Set<string>([...this.recentRel.map((s) => s.toLowerCase()), ...avoidParam]);
    const isAvoided = (item: Item) => {
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

    // E. 乱序洗牌与自家优先
    if (random) {
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

    const page = matched.slice(offset, offset + limit);
    if (!page.length) {
      return `匹配 ${matched.length} 张${matchedCategoryHint}，但 offset=${offset} 已超出范围；offset 从 0 开始。`;
    }

    // F. 提交本次出图状态（刷新冷却时间戳与 LRU 滑动窗口）
    const chosen = page[0];
    this.commitSend(chosen.rel, chosen.category);

    const lines = page.map((m) => `- [表情包:${m.rel}] ${m.character ? `${m.character}·` : ''}${m.category}`);
    const more = offset + page.length < matched.length ? `\n还有 ${matched.length - offset - page.length} 张未显示，可用 offset 翻页。` : '';
    return `匹配 ${matched.length} 张${matchedCategoryHint}，显示第 ${offset + 1}-${offset + page.length} 张：\n${lines.join('\n')}${more}`;
  }
}

export const STICKER_CATALOG_WORLD: WorldDefinition<CatalogConfig> = {
  id: 'qq-stickers',
  label: 'QQ表情管理',
  defaults: () => ({
    enabled: false,
    limit: 5,
    defaultChance: 0.5,
    cooldownSeconds: 45,
    categoryCooldownSeconds: 90,
    recentHistorySize: 10,
    defaultRandom: true,
    promptEnabled: true,
    promptText: '',
  }),
  create: (ctx) => new StickerCatalogWorld(ctx),
  describe: {
    tools: [
      {
        ...TOOL_SPEC,
        summary: {
          zh: '按情感或角色挑选表情包；内置冷却与概率控制，拿到文件名后用 [表情包:路径] 发送。',
          en: 'Browse and pick stickers by emotion/character with built-in cooldown & chance control.',
        },
      },
    ],
    events: [],
  },
};

export const id = STICKER_CATALOG_WORLD.id;
export const label = STICKER_CATALOG_WORLD.label;
export const defaults = STICKER_CATALOG_WORLD.defaults;
export const create = STICKER_CATALOG_WORLD.create;
export default STICKER_CATALOG_WORLD;
