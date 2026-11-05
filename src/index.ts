// 框架按 package.json 的 main 导入本文件，并读取具名导出 id/label/defaults/create 作为 WorldDefinition。
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolDef, ToolOutcome, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { WorldContext, WorldDefinition } from 'cortico/world.ts';
import {
  autoPick,
  configureGate,
  gatePity,
  invalidateScanCache,
  parseAvoid,
  resetGateState,
  resolveMood,
  scanLibrary,
  selectStickers,
  type GateQuery,
  type GateSelection,
  markOwnerActive,
} from './gate.ts';
import { deliverSticker, type StickerDeliverConfig } from './deliver.ts';
import { loadSemanticIndex, type SemanticIndex } from './semantic.ts';

interface CatalogConfig {
  enabled: boolean;
  /** 表情库根目录：一级子文件夹即分类，图片可以再往下分。 */
  emojiDir?: string;
  /** qq_sticker_pick 默认返回条数。 */
  limit?: number;
  /** 全局默认触发概率（0.0 ~ 1.0，默认 0.5）。保底次数由该值自动推导，无需单独配置。 */
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
  /** 桥接模式：QQ 收发改由 AstrBot 侧桥插件接管后，配图统一由本插件的 qq_sticker_send
   * 经 AstrBot Open API 直发本机表情（不依赖 event，不受桥的授权闸限制）。
   * 默认关闭＝原 qq-final 行为。
   */
  bridgeMode?: boolean;

  // 直发通道（运营层，不进面板）：经 AstrBot Open API 把本机表情发出。
  /** AstrBot 面板地址，如 http://127.0.0.1:6185。留空用默认。 */
  bridgeApiUrl?: string;
  /** 带 im + file 两个 scope 的 Open API Key。留空 = qq_sticker_send 保持禁用。 */
  bridgeApiToken?: string;
  /** umo 平台名（AstrBot 里 aiocqhttp 平台的自定义 id），如「bot」。 */
  bridgePlatformId?: string;

  // 语义检索（运营层，不进面板）：mood → caption 向量/BM25 检索。
  /** OpenAI 兼容 embedding 端点；留空 = 只走 BM25 文本检索。默认沿用本机 ollama。 */
  semanticEmbeddingUrl?: string;
  /** embedding 模型名。 */
  semanticEmbeddingModel?: string;
}

/** 两套发图通道各一份成品模板；面板显示当前通道那一份，可直接编辑正文。 */
const ENV_PROMPT_BRIDGE_FILE = fileURLToPath(new URL('./ENV_PROMPT_BRIDGE.md', import.meta.url));
const ENV_PROMPT_QQFINAL_FILE = fileURLToPath(new URL('./ENV_PROMPT_QQFINAL.md', import.meta.url));

/** 附加说明长度上限。 */
const PROMPT_MAX_LENGTH = 2000;

/**
 * 把一张表情包作为「附件」取出来。
 *
 * 存在的理由：桥接模式下正常发图走 `astrbot_call_tool(send_meme)`，但那条路需要
 * AstrBot 侧有真实 QQ 事件（meme_manager 的私有 extra），主动搭话轮拿不到。
 * 这个工具走另一条路——把字节交给 Core 分配 log: 句柄，再让模型用
 * `astrbot_send_message(image="log:…")` 发出去，因此不依赖 AstrBot 的插件运行时。
 */
const STICKER_FILE_SPEC = {
  name: 'qq_sticker_file',
  description:
    '把本机表情包里的一张图片作为附件取出来（返回的正文里会带一个 log: 开头的句柄）。' +
    '用法：调完它之后，把那个句柄原样填进 astrbot_send_message 的 image 参数，text 写你要说的话，图就会发到 QQ。' +
    '和 qq_sticker_pick 的区别：pick 只给分类键（走 AstrBot 侧 send_meme），file 直接给图片字节（走本机桥接发送），' +
    '所以它也是「主动搭话时想配一张图」唯一能用的那条路。',
  parameters: {
    type: 'object' as const,
    additionalProperties: false as const,
    properties: {
      mood: {
        type: 'string' as const,
        title: '情感 / 场景',
        description:
          '想表达的情绪或场景。可以直接写一句话或口语描述（如「没听懂但还得点头」「被夸了有点飘」），会走语义检索匹配最贴切的那几张；' +
          '也可以写标准分类词（开心、得意、困了），走同义词表。留空则全库随机。',
      },
      category: {
        type: 'string' as const,
        title: '分类',
        description: '直接指定分类目录，如 开心 / 得意 / 担心；优先级高于 mood。',
      },
      file: {
        type: 'string' as const,
        title: '文件名',
        description: '可指定具体文件（含扩展名），精确到某一张。',
      },
    },
  },
  // 必需：core 在 assembleTools 里读 def.tags.length，缺了会让主循环
  // bootstrap 抛 TypeError 直接退出（表现为「桌宠对任何消息都不回应」）。
  tags: ['read'] as const,
};

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
/** 桥的 deliver 限制是 6MB，这里留一点余量。 */
const MAX_STICKER_BYTES = 5.5 * 1024 * 1024;

const STICKER_TOOL_SPEC = {
  name: 'qq_sticker_pick',
  description:
    '【每轮回复前必调一次，不要和发消息放在同一轮】决定这一轮要不要配表情包。工具按设定概率掷骰：通过时返回候选列表，由你挑一张合适的，把 [表情包:分类/文件名] 原样写进正文；未命中或冷却中返回 [出图跳过: ...]，请直接用纯文字自然回复。可传情感/场景词（如 开心、得意、困了、晚安，支持同义词转换），也可按分类、角色或关键词筛选候选。返回 [出图跳过: ...] 属于正常的节流结果，不是报错，绝不要道歉或提及冷却。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      mood: {
        type: 'string',
        title: '情感 / 场景',
        description: '想表达的情感、场景或分类，如 开心、得意、被夸了、难过、困了；支持同义词转换（快乐->开心、认真->坚定）。留空则从全库挑选。',
      },
      category: {
        type: 'string',
        title: '情感分类',
        description: '按一级文件夹筛选，如 开心、得意、困惑、难过；支持模糊匹配与同义词转换。留空时不限制分类。',
      },
      character: {
        type: 'string',
        title: '角色',
        description: '按文件名前缀的角色筛选，如 小明、助手、猫猫；模糊匹配。',
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
        description: '本次返回多少条候选，默认取配置值，最大 20。',
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

/**
 * 直发工具：把本机表情库的一张图作为独立一段发出去。
 * 对话轮与主动搭话轮通用（Open API 不依赖 event，不受桥的授权闸限制）。
 * 掷骰/保底/冷却仍由 gate 单例唯一仲裁。qq-stickers 关闭时本工具随之消失，
 * 任何链路都发不出图。
 */
const STICKER_SEND_SPEC = {
  name: 'qq_sticker_send',
  description:
    '配图：在正文发出后调用，为这条消息补一张表情包（单独一段收尾）。' +
    '配不配图由它内部掷骰（概率/保底/冷却统一仲裁），没通过就纯文字收尾，不要重试也不要向对方解释。' +
    'mood 可写一句话描述此刻的情绪或场景（如「被夸了有点不好意思」），挑图会更贴。',
  parameters: {
    type: 'object' as const,
    additionalProperties: false as const,
    properties: {
      to: {
        type: 'string',
        title: '投递地址',
        description: 'private:<QQ号> 或 group:<群号>（原样照抄提示词里给的）',
      },
      mood: {
        type: 'string',
        title: '情感 / 场景',
        description: '想表达的情绪或场景（如 开心、得意、困了），掷骰通过时据此选图；留空则全库随机。',
      },
    },
    required: ['to'],
  },
  tags: ['speak'] as const,
};

/**
 * 策展工具：把「判断类」的活交给模型（看图打标、归纳别名、决定归哪个分类），
 * 插件只做机械部分（读图字节、写 semantic.json / aliases.json、建向量、移动文件）。
 * 这是开源后「新图自己长进来」的关键闭环——没有它，新图永远进不了语义检索。
 */
const CURATE_SPEC = {
  name: 'qq_sticker_curate',
  description:
    '表情库策展：新图入库、补语义描述、维护分类别名。判断交给你、落盘由插件完成。' +
    'operation=audit：列出缺描述的图、待补向量、incoming 未归类文件；' +
    'operation=inspect：把一张图取出来给你看（附现有描述）；' +
    'operation=describe：提交你看完图之后的 caption 与 tags，之后语义检索就能命中它；' +
    'operation=alias：维护某个分类的口语别名（如「有点得意」归到「得意」）；' +
    'operation=organize：把 incoming/ 下的新图归入某个分类。',
  parameters: {
    type: 'object' as const,
    additionalProperties: false as const,
    properties: {
      operation: {
        type: 'string' as const,
        enum: ['audit', 'inspect', 'describe', 'alias', 'organize'] as const,
        description: '要做的策展动作。',
      },
      rel: {
        type: 'string' as const,
        title: '图片路径',
        description: '库内相对路径，如「开心/小明-开心-001.gif」；organize 时可只给文件名。',
      },
      caption: {
        type: 'string' as const,
        title: '画面描述',
        description: 'describe 用：你看完图后写的一句话描述（谁在做什么、什么表情、适合什么场景）。',
      },
      tags: {
        type: 'array' as const,
        items: { type: 'string' as const },
        title: '标签',
        description: 'describe 用：3~10 个口语标签（如「有点得意」「被夸懵」「溜了」），语义检索靠它们提高命中。',
      },
      category: {
        type: 'string' as const,
        title: '分类',
        description: 'alias / organize 用的目标分类名。',
      },
      aliases: {
        type: 'array' as const,
        items: { type: 'string' as const },
        title: '别名列表',
        description: 'alias 用：要并入该分类的口语说法；不传则只查看该分类现有别名。',
      },
      limit: {
        type: 'number' as const,
        title: '清单条数',
        description: 'audit 最多列多少条（默认 8，最多 30）。',
      },
    },
    required: ['operation'],
  },
  tags: ['write'] as const,
};

/** 只读地浏览与挑选表情库：按分类/角色/关键词挑图，供 QQ bot 用 [表情包:路径] 发送。 */
class StickerCatalogWorld implements World {
  readonly id = 'qq-stickers';
  private readonly cfg: CatalogConfig;
  private host: WorldHost | null = null;
  private semantic: SemanticIndex | null = null;
  /** 外部分类别名（sticker-semantic/aliases.json）：开源的库分类各不相同，不能写死在代码里。 */
  private aliases: Record<string, string[]> = {};

  constructor(ctx: WorldContext<CatalogConfig>) {
    this.cfg = ctx.cfg;
    this.applyGateConfig();
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.aliases = this.loadAliases();
    this.applyGateConfig();
    markOwnerActive(true);
    const scan = scanLibrary();
    host.log.info(`表情包目录已就绪：${scan.unique} 张图 / ${scan.total} 个分类条目，共 ${scan.byCategory.size} 个分类，根目录 ${this.root()}`);
    // 语义索引：描述与向量库都在表情库旁的 sticker-semantic/ 下；加载失败静默退化到同义词表
    const emojiDir = this.root();
    if (emojiDir) {
      const dataDir = resolve(emojiDir, '..', 'sticker-semantic');
      this.semantic = await loadSemanticIndex(dataDir, {
        url: this.cfg.semanticEmbeddingUrl,
        model: this.cfg.semanticEmbeddingModel,
      });
      if (this.semantic) {
        const cov = this.semantic.coverage();
        host.log.info(`表情语义索引已就绪：${cov.captions} 条描述，向量已补 ${cov.indexed} 条（后台继续）。`);
      } else {
        host.log.info('表情语义索引不可用，选图退化为同义词表匹配。');
      }
    }
  }

  async stop(): Promise<void> {
    this.host = null;
    this.semantic?.flush();
    this.semantic = null;
    markOwnerActive(false);
    resetGateState();
  }

  envPromptVars(): Record<string, string> | null {
    if (this.cfg.promptEnabled === false) return null;
    // 桥接模式：本地库不再用于发图，提示改成「调 AstrBot 侧表情包工具 + 分类键表」。
    if (this.bridgeMode()) {
      // 桥接模式：配图同样来自本机表情库（qq_sticker_send 直发），展示本地库信息
      const scan = scanLibrary();
      if (!scan.total) {
        return { stickerLibraryLine: `本机表情库为空。${this.extraPrompt()}` };
      }
      const cats = [...scan.byCategory.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k} ${n}`)
        .join('、');
      return {
        stickerLibraryLine: `本机表情库共 ${scan.unique} 张图片，分类：${cats}。配图一律由 qq_sticker_send 掷骰直发。${this.extraPrompt()}`,
      };
    }
    const scan = scanLibrary();
    if (!scan.total) return null;
    const cats = [...scan.byCategory.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ${n}`)
      .join('、');
    return {
      stickerTotal: String(scan.unique),
      stickerCategories: cats,
      stickerLibraryLine: `本机表情库共 ${scan.unique} 张图片，分类：${cats}。文件名形如「开心/小明-开心-001.gif」。${this.extraPrompt()}`,
      };
  }

  webUi(): WorldWebUiDecl {
    const scan = scanLibrary();
    const base = Math.min(1, Math.max(0, this.cfg.defaultChance ?? 0.5));
    const pity = gatePity();
    const bridge = this.bridgeMode();
    const badges: Array<{ label: string; value: string | number; tone: 'on' | 'off' | 'plain' }> = [
      { label: '发图通道', value: bridge ? 'AstrBot 桥' : 'qq-final', tone: bridge ? 'on' : 'plain' },
      { label: '表情包', value: scan.unique, tone: scan.unique > 0 ? 'on' : 'off' },
    ];
    // 保底水位：连不中几次 / 多少次必出，方便一眼看出"为什么最近没出图"。
    // 概率为 100% 时每次都会直接出图，不存在保底，不显示这一项。
    if (base < 1 && pity.hardPoint > 0) {
      const near = pity.missStreak >= pity.hardPoint - 1;
      badges.push({ label: '保底', value: `${pity.missStreak}/${pity.hardPoint}`, tone: near ? 'on' : 'plain' });
    }
    // 语义索引覆盖率：描述条数与已补向量的进度，一眼看出检索是否可用。
    if (this.semantic?.ready()) {
      const cov = this.semantic.coverage();
      badges.push({
        label: '语义索引',
        value: `${cov.indexed}/${cov.captions}`,
        tone: cov.captions > 0 ? 'on' : 'off',
      });
    }
    return {
      badges,
      config: [
        {
          id: 'world:qq-stickers-mode',
          owner: 'world:qq-stickers',
          schema: {
            type: 'object',
            title: 'QQ表情管理 · 发图通道',
            description:
              'QQ 收发走哪条路：qq-final = 本机自建 OneBot 直发；AstrBot 桥 = QQ 收发已交给 AstrBot 侧接管，' +
              '配图由本插件的 qq_sticker_send 经 AstrBot Open API 直发本机表情。改完需重启本 World。',
            properties: {
              'worlds.qq-stickers.bridgeMode': {
                type: 'boolean',
                title: 'AstrBot 桥模式',
                description:
                  '打开后对话轮与主动搭话轮的配图统一由 qq_sticker_send 直发本机表情（独立一段收尾）；' +
                  '频率仲裁（概率/保底/冷却/防连发）仍然保留。关闭后 qq_sticker_send 停用。改完需重启本 World 才生效。',
                'x-hot': false,
              },
            },
          },
        },
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
                description: '一级子文件夹即情感分类。两条通道都用它（本地路径标记与桥接直发都从这里取图）。改完约 5 秒后生效。',
                'x-hot': true,
                'x-path': { kind: 'directory' as const, recommendedDir: this.root() },
              },
              'worlds.qq-stickers.limit': {
                type: 'number',
                title: '默认返回条数',
                description: 'qq_sticker_pick 不传 limit 时的默认候选条数，1~20。',
                minimum: 1,
                maximum: 20,
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
                title: '附加说明（可选）',
        description: `留空则不追加；填了会接在出图纪律正文之后，两套通道都生效。最多 ${PROMPT_MAX_LENGTH} 字。改完下一轮生效。`,
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
          description: '当前发图通道的出图纪律正文：正文可直接编辑，库信息是自动填入的变量。切换通道后这里会换成另一份。',
          path: this.bridgeMode() ? ENV_PROMPT_BRIDGE_FILE : ENV_PROMPT_QQFINAL_FILE,
          role: 'envPrompt' as const,
          vars: [
            { name: 'stickerLibraryLine', description: '库信息（分类键表 / 本机库统计）' },
            { name: 'stickerTotal', description: '本机表情包总数' },
            { name: 'stickerCategories', description: '本机表情包分类分布' },
          ],
        },
      ],
    };
  }

  tools(): ToolDef[] {
    // 桥接模式：配图统一走 qq_sticker_send 直发本机表情（对话轮/主动轮通用）；
    // qq_sticker_file 保留作「指定发某张图」的备用通道。分类键协议（send_meme）已退役。
    if (this.bridgeMode()) {
      return [
        { ...STICKER_FILE_SPEC, handler: async (args) => this.pickStickerFile(args) },
        { ...STICKER_SEND_SPEC, handler: async (args) => this.sendSticker(args) },
        { ...CURATE_SPEC, handler: async (args) => this.curate(args) },
      ];
    }
    return [
      // 纯查询/掷骰工具不设 barrierAfter：屏障会拦下同一响应里排在后面的发信工具
      { ...STICKER_TOOL_SPEC, handler: async (args) => this.handle(args) },
      { ...CURATE_SPEC, handler: async (args) => this.curate(args) },
    ];
  }

  // ---------------- 策展（判断交模型，落盘归插件） ----------------

  /** 语义数据目录（与表情库同级）。 */
  private semanticDir(): string {
    return resolve(this.root(), '..', 'sticker-semantic');
  }

  private aliasesFile(): string {
    return join(this.semanticDir(), 'aliases.json');
  }

  private incomingDir(): string {
    return join(this.root(), 'incoming');
  }

  private loadAliases(): Record<string, string[]> {
    try {
      const raw = JSON.parse(readFileSync(this.aliasesFile(), 'utf8')) as Record<string, unknown>;
      const out: Record<string, string[]> = {};
      for (const [cat, list] of Object.entries(raw)) {
        if (!Array.isArray(list)) continue;
        const aliases = list.map((a) => String(a ?? '').trim()).filter(Boolean);
        if (aliases.length) out[cat] = aliases;
      }
      return out;
    } catch {
      return {};
    }
  }

  private saveAliases(next: Record<string, string[]>): void {
    mkdirSync(this.semanticDir(), { recursive: true });
    const file = this.aliasesFile();
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 1), 'utf8');
    renameSync(tmp, file);
  }

  /** 冷启动：semantic.json 不存在时建一份空的并重新加载，让 describe 能工作。 */
  private async ensureSemantic(): Promise<SemanticIndex | null> {
    if (this.semantic) return this.semantic;
    const file = join(this.semanticDir(), 'semantic.json');
    if (!existsSync(file)) {
      mkdirSync(this.semanticDir(), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({ version: 1, generated_at: new Date().toISOString(), source: 'cortico-world-qq-stickers', entries: {} }, null, 1),
        'utf8',
      );
    }
    this.semantic = await loadSemanticIndex(this.semanticDir(), {
      url: this.cfg.semanticEmbeddingUrl,
      model: this.cfg.semanticEmbeddingModel,
    });
    return this.semantic;
  }

  /** incoming 目录下待归类的新图（按文件名）。 */
  private listIncoming(): string[] {
    try {
      return readdirSync(this.incomingDir(), { withFileTypes: true })
        .filter((e) => e.isFile() && IMAGE_EXT_RE.test(e.name))
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  }

  private async curate(args: Record<string, unknown>): Promise<string | ToolOutcome> {
    const op = String(args.operation ?? '').trim();
    if (op === 'audit') return this.curateAudit(args);
    if (op === 'inspect') return this.curateInspect(args);
    if (op === 'describe') return this.curateDescribe(args);
    if (op === 'alias') return this.curateAlias(args);
    if (op === 'organize') return this.curateOrganize(args);
    return '未知 operation，可用：audit / inspect / describe / alias / organize。';
  }

  private curateAudit(args: Record<string, unknown>): string {
    const scan = scanLibrary();
    if (!scan.total) return '表情库为空或目录没配：先把图片放进「分类子文件夹」，再用 operation=audit 检查。';
    const limit = Math.max(1, Math.min(30, Number(args.limit) || 8));
    const described = new Set(this.semantic?.rels() ?? []);
    const missing = scan.items.filter((it) => !described.has(it.rel));
    const cov = this.semantic?.coverage() ?? null;
    const incoming = this.listIncoming();

    const lines: string[] = [
      `表情库：${scan.unique} 张图，${scan.byCategory.size} 个分类（${[...scan.byCategory.keys()].slice(0, 12).join('、')}${scan.byCategory.size > 12 ? '…' : ''}）`,
      cov ? `语义描述：${cov.captions} 条，向量已补 ${cov.indexed}/${cov.captions}` : '语义描述：不可用（describe 一次会自动初始化）',
      `分类别名：${Object.keys(this.aliases).length} 个分类已配置`,
    ];
    if (missing.length) {
      lines.push(
        `缺描述 ${missing.length} 张：${missing.slice(0, limit).map((m) => m.rel).join('、')}${missing.length > limit ? '…' : ''}`,
        '（逐张处理：先 operation=inspect 看图，再 operation=describe 回填 caption/tags）',
      );
    } else {
      lines.push('所有图都有语义描述。');
    }
    if (incoming.length) {
      lines.push(`incoming 未归类 ${incoming.length} 张：${incoming.slice(0, limit).join('、')}（operation=organize 指定分类归位）`);
    }
    return lines.join('\n');
  }

  private curateInspect(args: Record<string, unknown>): ToolOutcome {
    const rel = String(args.rel ?? '').trim();
    const scan = scanLibrary();
    const item = scan.items.find((it) => it.rel === rel || it.name === rel || it.rel.endsWith('/' + rel));
    if (!item) {
      const cats = [...scan.byCategory.keys()].join('、');
      return { text: `库里没有「${rel}」。可用分类：${cats}`, failed: true };
    }
    const existing = this.semantic?.entry(item.rel) ?? null;
    const status = existing
      ? `现有描述：${existing.caption.slice(0, 160)}\n标签：${existing.tags.join('、') || '（无）'}`
      : '这张图还没有语义描述。看完图后用 operation=describe 回填。';
    try {
      const buf = readFileSync(join(this.root(), item.rel));
      if (buf.byteLength > MAX_STICKER_BYTES) {
        return { text: `「${item.rel}」${(buf.byteLength / 1024 / 1024).toFixed(1)}MB，超过看图上限，没法回传。${status}` };
      }
      const mime = MIME_BY_EXT[extname(item.name).toLowerCase()] ?? 'image/png';
      return {
        text: `取出「${item.rel}」（${item.category} / ${item.character || '未知角色'}）。${status}`,
        blobs: [{ bytes: buf, mime, name: item.name, fallbackText: `[表情包 ${item.rel}]` }],
      };
    } catch (err) {
      return { text: `读图失败：${err instanceof Error ? err.message : String(err)}`, failed: true };
    }
  }

  private async curateDescribe(args: Record<string, unknown>): Promise<string> {
    const rel = String(args.rel ?? '').trim();
    const caption = String(args.caption ?? '').trim();
    const tags = Array.isArray(args.tags) ? args.tags.map((t) => String(t ?? '').trim()).filter(Boolean) : [];
    if (!rel) return '缺少 rel：先 operation=audit 看缺描述的图，或 operation=inspect 确认路径。';
    if (!caption) return '缺少 caption：先 operation=inspect 看一眼图，再带上 caption（一句话画面描述）与 tags 重新提交。';

    const scan = scanLibrary();
    const item = scan.items.find((it) => it.rel === rel || it.name === rel || it.rel.endsWith('/' + rel));
    if (!item) return `库里没有「${rel}」这张图，无法写描述。`;

    const sem = await this.ensureSemantic();
    if (!sem) return '语义索引初始化失败（semantic.json 写不进去或 memory 扩展不在），这张图的描述没保存。';
    try {
      const res = await sem.describe(item.rel, caption, tags);
      this.host?.log.info(`[表情包] 已写入语义描述：${item.rel}${res.embedded ? '（向量已补）' : '（向量待后台补）'}`);
      return `已写入「${item.rel}」的描述${res.embedded ? '，向量也已生成' : '，向量稍后自动补'}。之后检索「${tags.slice(0, 3).join('、') || caption.slice(0, 12)}」会命中它。`;
    } catch (err) {
      return `写入失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private curateAlias(args: Record<string, unknown>): string {
    const category = String(args.category ?? '').trim();
    if (!category) return '缺少 category：想给哪个分类配别名？';
    const incoming = Array.isArray(args.aliases) ? args.aliases.map((a) => String(a ?? '').trim()).filter(Boolean) : [];
    const current = this.aliases[category] ?? [];

    if (!incoming.length) {
      const cats = [...scanLibrary().byCategory.keys()];
      return `分类「${category}」现有别名：${current.join('、') || '（无）'}\n传 aliases 数组可追加（如 ["有点得意","小得意"]）。库内分类：${cats.join('、')}`;
    }

    const merged = [...new Set([...current, ...incoming])];
    const next = { ...this.aliases, [category]: merged };
    try {
      this.saveAliases(next);
    } catch (err) {
      return `别名写入失败：${err instanceof Error ? err.message : String(err)}`;
    }
    this.aliases = next;
    this.applyGateConfig();
    this.host?.log.info(`[表情包] 分类「${category}」别名更新：${merged.join('、')}`);
    return `分类「${category}」别名已更新为：${merged.join('、')}。之后这些说法会直接落到该分类。`;
  }

  private curateOrganize(args: Record<string, unknown>): string {
    const rel = String(args.rel ?? '').trim();
    const category = String(args.category ?? '').trim();
    if (!rel) return '缺少 rel：要归位哪张图？（incoming 里的文件名）';
    if (!category) return '缺少 category：归到哪个分类？';
    const name = rel.split('/').pop() ?? rel;
    if (!IMAGE_EXT_RE.test(name)) return `「${name}」不是图片文件。`;

    const src = join(this.incomingDir(), name);
    if (!existsSync(src)) {
      const incoming = this.listIncoming();
      return `incoming 里没有「${name}」。当前待归类：${incoming.join('、') || '（空）'}`;
    }
    const dest = join(this.root(), category, name);
    if (existsSync(dest)) return `「${category}/${name}」已存在，没动它。`;
    try {
      mkdirSync(join(this.root(), category), { recursive: true });
      renameSync(src, dest);
    } catch (err) {
      return `移动失败：${err instanceof Error ? err.message : String(err)}`;
    }
    invalidateScanCache();
    this.host?.log.info(`[表情包] incoming 归位：${name} → ${category}`);
    return `已把「${name}」归入「${category}」。记得再 operation=inspect + describe 补语义描述。`;
  }

  /**
   * 取一张表情包的字节并交给 Core 分配 log: 句柄。
   *
   * 选图分层路由（确定性优先，语义兜底，避免语义压过分类造成跑偏）：
   *   1. 显式 category / file —— 点名即用；
   *   2. mood 能落到确定分类（含同义词映射）—— 走分类池，与旧行为一致；
   *   3. mood 落不到分类（整句/口语/复合描述）—— 走语义检索；
   *   4. 语义不可用或无命中 —— 文件名关键词 → 口语模糊 → 全库。
   * 不掷骰、不受频控——它只负责「把这张图变成可发送的附件」，要不要发由模型自己决定。
   */
  private async pickStickerFile(args: Record<string, unknown>) {
    const scan = scanLibrary();
    if (!scan.items.length) {
      return { text: '表情包库是空的或没配置目录，取不到图。', failed: true as const };
    }
    const catRaw = String(args.category ?? '').trim();
    const mood = String(args.mood ?? '').trim();
    const file = String(args.file ?? '').trim();

    let pool = scan.items.filter((it) => IMAGE_EXT_RE.test(it.name));
    let via: 'category' | 'semantic' | 'keyword' | 'all' = 'all';

    const resolved = catRaw ? { category: catRaw, keyword: '' } : resolveMood(mood);

    if (resolved.category) {
      // 第 1、2 档：确定分类（显式 category 或 mood 命中同义词表）
      const inCat = pool.filter((it) => it.category === resolved.category);
      if (inCat.length) {
        pool = inCat;
        via = 'category';
      }
    }

    if (via === 'all' && mood && this.semantic?.ready()) {
      // 第 3 档：分类落空的口语/整句描述才交给语义，不抢确定分类的活
      const hits = await this.semantic.search(mood, 3);
      if (hits.length) {
        const byRel = new Map(scan.items.map((it) => [it.rel, it] as const));
        const semanticPool = hits.map((rel) => byRel.get(rel)).filter((it): it is (typeof scan.items)[number] => Boolean(it));
        if (semanticPool.length) {
          pool = semanticPool;
          via = 'semantic';
        }
      }
    }

    if (file) {
      // 显式文件名：在池内收窄；池内没有就退到全库找这一张
      const byName = pool.filter((it) => it.name === file || it.rel.endsWith(file));
      if (byName.length) pool = byName;
      else {
        const anywhere = scan.items.filter((it) => it.name === file || it.rel.endsWith(file));
        if (anywhere.length) {
          pool = anywhere;
          via = 'all';
        }
      }
    }

    if (via === 'all') {
      // 第 4 档：关键词 → 口语模糊（语义不可用或无命中时的原路径）
      if (resolved.keyword) {
        const byKw = pool.filter((it) => it.name.includes(resolved.keyword) || it.rel.includes(resolved.keyword));
        if (byKw.length) {
          pool = byKw;
          via = 'keyword';
        }
      }
      if (via === 'all' && mood && !resolved.category) {
        const byText = pool.filter((it) => it.name.includes(mood) || it.rel.includes(mood));
        if (byText.length) {
          pool = byText;
          via = 'keyword';
        }
      }
    }
    if (!pool.length) {
      const cats = [...scan.byCategory.keys()].join('、');
      return {
        text: `库里没有匹配「${catRaw || mood || file}」的图片。可用分类：${cats}`,
        failed: true as const,
      };
    }

    // 库里有约 10 张超过 5.5MB（最大 11.7MB），随机命中就直接换一张，最多试 3 次
    let pick = pool[Math.floor(Math.random() * pool.length)];
    let bytes: Uint8Array | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = attempt === 0 ? pick : pool[Math.floor(Math.random() * pool.length)];
      try {
        const buf = readFileSync(join(this.root(), candidate.rel));
        if (buf.byteLength <= MAX_STICKER_BYTES) {
          pick = candidate;
          bytes = buf;
          break;
        }
      } catch {
        /* 读失败也换一张再试 */
      }
    }
    if (!bytes) {
      return {
        text: '连试 3 张都读不出来或超过桥的 6MB 上限，换个月份/分类再挑吧。',
        failed: true as const,
      };
    }
    const mime = MIME_BY_EXT[extname(pick.name).toLowerCase()] ?? 'image/png';
    const hitNote =
      via === 'semantic' ? '（按语义匹配）' : via === 'keyword' ? '（按关键词模糊命中）' : via === 'category' ? '（按分类匹配）' : '';
    return {
      text:
        `已取出「${pick.category}/${pick.name}」${hitNote}。` +
        `本条回执附带一个 log: 开头的句柄，把它原样填进 astrbot_send_message 的 image 参数` +
        `（text 写你要说的话），图就会发到 QQ。`,
      blobs: [
        {
          bytes,
          mime,
          name: pick.name,
          fallbackText: `[表情包 ${pick.category}/${pick.name}]`,
        },
      ],
    };
  }

  /** 桥接模式开关：配置为 true 时不再走本地 [表情包:路径] 那条路。 */
  private bridgeMode(): boolean {
    return this.cfg.bridgeMode === true;
  }

  /**
   * qq_sticker_send：主动搭话轮的直发配图。
   * 先掷骰（与 qq_sticker_pick 同账本：概率/保底/全局与分类冷却/防连发），
   * 通过才把图作为独立一段发出；没过或失败都回显跳过原因，绝不抛错。
   */
  private async sendSticker(args: Record<string, unknown>): Promise<string> {
    this.applyGateConfig();
    const to = String(args.to ?? '').trim();
    if (!to) {
      return '[出图跳过] 没有可用的投递地址（to 为空），直接结束即可。';
    }
    const mood = typeof args.mood === 'string' ? args.mood.trim() : '';

    // 语义检索先行：mood → 最贴切的 rel 候选池（top-5）；索引不可用返回空，掷骰退化为常规匹配
    let prefer: string[] | undefined;
    if (mood && this.semantic?.ready()) {
      const hits = await this.semantic.search(mood, 3);
      if (hits.length) prefer = hits;
    }

    const pick = autoPick({ emojiDir: this.root(), mood: mood || undefined, prefer });
    if (!pick.pass || !pick.rel) {
      const reason = pick.reason || '本轮掷骰未通过';
      this.host?.log.info(`[表情包] ${to} 直发未通过：${reason}`);
      return `[出图跳过] ${reason}`;
    }

    const deliverCfg: StickerDeliverConfig = {
      bridgeApiUrl: this.cfg.bridgeApiUrl,
      bridgeApiToken: this.cfg.bridgeApiToken,
      bridgePlatformId: this.cfg.bridgePlatformId,
    };
    const log = {
      info: (msg: string, fields?: Record<string, unknown>) => this.host?.log.info(msg, fields),
      warn: (msg: string, fields?: Record<string, unknown>) => this.host?.log.warn(msg, fields),
    };
    const result = await deliverSticker(deliverCfg, this.root(), pick.rel, to, log);
    if (!result.ok) {
      this.host?.log.warn(`[表情包] ${to} 直发没发出去：${result.error ?? '未知原因'}`);
      return `[出图跳过] ${result.error ?? '发送失败'}；别重试、别解释，直接结束。`;
    }
    return `已补一张表情包（${pick.rel}，单独一段）。收尾即可，不用提图。`;
  }

  private root(): string {
    return (this.cfg.emojiDir ?? '').trim();
  }

  /** 附加说明：写在面板里的自定义补充。模板是静态正文，这里把它拼在库信息之后。 */
  private extraPrompt(): string {
    const custom = (this.cfg.promptText ?? '').trim();
    return custom ? ` ${custom}` : '';
  }

  /** 把面板配置同步进掷骰单例；热更配置每次 start / 构造时刷新。 */
  private applyGateConfig(): void {
    configureGate(
      {
        emojiDir: this.root(),
        defaultChance: this.cfg.defaultChance ?? 0.5,
        cooldownSeconds: this.cfg.cooldownSeconds ?? 45,
        categoryCooldownSeconds: this.cfg.categoryCooldownSeconds ?? 90,
        recentHistorySize: this.cfg.recentHistorySize ?? 10,
        defaultRandom: this.cfg.defaultRandom ?? true,
        limit: this.cfg.limit ?? 5,
        aliases: this.aliases,
      },
      this.host
        ? {
            info: (msg, fields) => this.host!.log.info(msg, fields),
            warn: (msg, fields) => this.host!.log.warn(msg, fields),
          }
        : undefined,
    );
  }

  /** 把入参归一化为统一查询条件；mood 先落到分类（含同义词），落不到再退化为关键词。 */
  private buildQuery(args: Record<string, unknown>): GateQuery {
    const text = (k: string) => (typeof args[k] === 'string' ? (args[k] as string).trim().toLowerCase() : '');
    const num = (k: string, def: number) => {
      const n = Number(args[k]);
      return Number.isFinite(n) ? n : def;
    };
    // mood 与 category 同时给时以 category 为准；mood 切词落不到分类时不退化成
    // 文件名关键词搜索（复合词搜索必空），留空走全库兜底
    let category = text('category');
    let keyword = text('keyword');
    const mood = text('mood');
    if (!category && mood) {
      category = resolveMood(mood).category;
    }
    return {
      category,
      character: text('character'),
      keyword,
      force: Boolean(args.force),
      random: args.random !== undefined ? Boolean(args.random) : (this.cfg.defaultRandom ?? true),
      avoid: parseAvoid(args.avoid),
      limit: Math.max(1, Math.min(20, num('limit', this.cfg.limit ?? 5))),
      offset: Math.max(0, num('offset', 0)),
    };
  }

  /** 工具输出：掷骰结果 + 候选列表（或跳过原因）。 */
  private render(sel: GateSelection, mood: string): string {
    if (sel.kind === 'unavailable') {
      return `表情库为空或目录不存在：${sel.root || '（未配置 emojiDir）'}。请在 World 配置里指定表情库根目录。`;
    }
    if (sel.kind === 'skip') {
      return `[出图跳过] ${sel.reason}`;
    }
    if (sel.kind === 'none') {
      const filters = [mood && `mood=${mood}`, sel.category && `category=${sel.category}`, sel.character && `character=${sel.character}`, sel.keyword && `keyword=${sel.keyword}`]
        .filter(Boolean)
        .join(' ');
      return `${sel.note}没有匹配的表情包（${filters || '全库'}）。可以换一个情感/场景词再试，或本轮用纯文字回复。`;
    }
    if (sel.kind === 'exhausted') {
      return `${sel.note}匹配 ${sel.matched} 张${sel.hint}，但 offset=${sel.offset} 已超出范围；offset 从 0 开始。`;
    }
    const lines = sel.items.map((m) => `- [表情包:${m.rel}] ${m.character ? `${m.character}·` : ''}${m.category}`);
    const more = sel.offset + sel.items.length < sel.matched ? `\n还有 ${sel.matched - sel.offset - sel.items.length} 张未显示，可用 offset 翻页。` : '';
    return `${sel.note}匹配 ${sel.matched} 张${sel.hint}，显示第 ${sel.offset + 1}-${sel.offset + sel.items.length} 张，请从中挑一张最贴合当前情绪的，把它的 [表情包:分类/文件名] 原样写进回复正文：\n${lines.join('\n')}${more}`;
  }

  private handle(args: Record<string, unknown>): string {
    const mood = typeof args.mood === 'string' ? args.mood.trim() : '';
    this.applyGateConfig();
    return this.render(selectStickers(this.buildQuery(args)), mood);
  }
}

export const STICKER_CATALOG_WORLD: WorldDefinition<CatalogConfig> = {
  id: 'qq-stickers',
  label: 'QQ表情管理',
  defaults: () => ({
    enabled: false,
    emojiDir: '',
    limit: 5,
    defaultChance: 0.5,
    cooldownSeconds: 45,
    categoryCooldownSeconds: 90,
    recentHistorySize: 10,
    defaultRandom: true,
    promptEnabled: true,
    promptText: '',
    bridgeMode: false,
    bridgeApiUrl: 'http://127.0.0.1:6185',
    bridgeApiToken: '',
    bridgePlatformId: '',
    semanticEmbeddingUrl: 'http://127.0.0.1:11434/v1/embeddings',
    semanticEmbeddingModel: 'bge-m3',
  }),
  create: (ctx) => new StickerCatalogWorld(ctx),
  describe: {
    tools: [
      {
        ...STICKER_TOOL_SPEC,
        summary: {
          zh: '每轮回复前必调：按概率掷骰决定是否配图，通过时返回候选列表，挑一张用 [表情包:路径] 发送。',
          en: 'Call before each reply: dice by configured chance, return candidates on pass, send via [sticker:path].',
        },
      },
      {
        ...STICKER_FILE_SPEC,
        summary: {
          zh: '把本机表情包的一张图取成附件句柄（log:…），供 astrbot_send_message 的 image 参数使用。',
          en: 'Fetch a local sticker as an attachment handle for astrbot_send_message.',
        },
      },
      {
        ...STICKER_SEND_SPEC,
        summary: {
          zh: '按掷骰补一张本机表情包（经 AstrBot Open API 独立一段发出），对话轮与主动搭话轮通用。',
          en: 'Attach a local sticker via the AstrBot Open API as a standalone segment.',
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
export { autoPick };
export default STICKER_CATALOG_WORLD;
