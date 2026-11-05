# cortico-world-qq-stickers · QQ 表情管理

> Cortico World 扩展（QQ 生态）：只读地浏览 / 挑选本地 QQ 表情包库，按情感、场景或角色给 QQ bot 配图。
> 内置频控冷却、概率掷骰、情感同义词映射与防重复机制；发图仍由 QQ 协议扩展（如 `cortico-world-qq-final`）通过 `[表情包:分类/文件名]` 标记完成，本扩展不改动任何表情包素材。

- 包名：`cortico-world-qq-stickers`
- World id：`qq-stickers`
- 类型：`world`（Cortico World API 6）
- 运行形态：ESM + TypeScript 源码直接加载（`main: ./src/index.ts`），无需构建

---

## 特性

1. **单一工具调用链**
   - `qq_sticker_pick`：每轮回复前必调一次，工具按设定概率掷骰决定本轮是否配图。
   - 通过时返回候选列表（可按情感 / 角色 / 关键词筛选，支持翻页），由模型从中挑一张；未命中或冷却中返回 `[出图跳过]`，引导模型用文字回复。
   - 回执里始终回显本轮掷骰结果（命中率、保底进度），跳过时写明冷却或概率原因。
2. **情感分类与同义词映射**
   - 表情库一级子文件夹即情感分类（如 `开心`、`得意`、`难过`、`困惑`）。
   - 内置同义词表：`快乐 -> 开心`、`认真 -> 坚定`、`疑惑 -> 困惑`、`哭 -> 哭泣 / 难过` 等，命中后会在回执里说明映射关系。
3. **频控与概率**
   - 全局发图冷却（默认 45 秒）与同类情感冷却（默认 90 秒），可分别设为 0 关闭。
   - 基础触发概率（默认 0.5）：掷骰未命中时返回 `[出图跳过]`，引导模型用文字回复而不道歉。
4. **防重复**
   - 内存 LRU 滑动窗口（默认记住最近 10 张）与可选的 `avoid` 入参共同排除刚发过的图；匹配充足时优先避开，不足时全量回退，不会报空。
   - 默认 Fisher–Yates 洗牌；关闭 `random` 时按「分类 → 自家角色优先 → 名称」确定性排序。
5. **只读与安全**
   - 仅读取 `emojiDir` 下的图片文件名，不写入、不复制、不修改表情包。
   - 全扩展不发起网络请求，不读取 QQ 号等账号信息。
6. **可注入的环境提示词**
   - `src/ENV_PROMPT.md` 会作为 env prompt 注入系统前缀，写明发图节奏、频控跳过语义、语音消息不携带图片标记等纪律；可在 WebUI 关闭或改写。

---

## 安装与启用

1. 将本扩展放到本地扩展目录（目录名与包名一致）：

   ```
   %COOPANION_DIR%/data/extensions/local/cortico-world-qq-stickers
   ```

2. 在 Coopanion 的「扩展管理 / World 配置」中启用「QQ表情管理」，等价于配置：

   ```json
   { "worlds": { "qq-stickers": { "enabled": true } } }
   ```

3. 指定表情库根目录 `worlds.qq-stickers.emojiDir`。目录约定：

   ```
   <emojiDir>/
   ├── 开心/
   │   ├── 小明-开心-001.gif
   │   └── DeepSeek-开心-002.png
   ├── 得意/
   │   └── 菲比-得意-001.gif
   └── 难过/
       └── ...
   ```

   - 一级子文件夹 = 情感分类；分类下可以再分子目录。
   - 文件名建议 `角色-情感-序号.ext`：`-` 之前视为角色前缀（用于 `character` 筛选与「自家形象优先」排序）。
   - 支持 `.png` / `.gif` / `.jpg` / `.jpeg` / `.webp` / `.bmp`。
4. 生效：目录扫描结果缓存 5 秒，新增表情包或改 `emojiDir` 后无需重启，稍等片刻自动出现。

> 表情包发送链路不在本扩展内：bot 拿到真实相对路径后，在回复文本里写 `[表情包:分类/文件名]`，由 QQ 协议扩展负责实际发图。

---

## 配置项

配置键均在 `worlds.qq-stickers` 段下，WebUI 设置面板会按下列 schema 渲染。

| 配置键 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | 是否启用本 World；通常由部署配置或 WebUI 打开。 |
| `emojiDir` | string | 无（空） | 表情库根目录；一级子文件夹即情感分类。为空或不存在的目录会返回提示。 |
| `limit` | number | `5` | `qq_sticker_pick` 未传 `limit` 时的默认候选条数，范围 1–50。 |
| `defaultChance` | number | `0.5` | 基础触发概率（0–1）。掷骰未命中时返回 `[出图跳过]`。 |
| `cooldownSeconds` | number | `45` | 全局发图冷却（秒），0 表示关闭。 |
| `categoryCooldownSeconds` | number | `90` | 同一情感分类的发图冷却（秒），0 表示关闭。 |
| `recentHistorySize` | number | `10` | 防重复滑动窗口大小，记住最近 N 张并在匹配充足时避开。 |
| `defaultRandom` | boolean | `true` | 未显式传 `random` 时是否打乱候选顺序。 |
| `promptEnabled` | boolean | `true` | 是否把 `src/ENV_PROMPT.md` 注入系统前缀。 |
| `promptText` | string | `""` | 覆盖提示词中的「发图纪律」正文，留空用内置默认，最多 2000 字。 |

---

## 工具清单

| 工具 | 作用 | 标签 |
| --- | --- | --- |
| `qq_sticker_pick` | 每轮掷骰决定是否配图，通过时按情感 / 角色 / 关键词列出候选（可翻页） | `read` |

### `qq_sticker_pick`

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "mood":      { "type": "string",  "title": "情感 / 场景", "description": "想表达的情感、场景或分类，如 开心、得意、困了；支持同义词转换。留空则从全库挑选。" },
    "category":  { "type": "string",  "title": "情感分类", "description": "按一级文件夹筛选，支持模糊匹配与同义词转换（如 快乐->开心、认真->坚定）。留空时不限制分类。" },
    "character": { "type": "string",  "title": "角色",     "description": "按文件名前缀的角色筛选，如 小明、助手、猫猫；模糊匹配。" },
    "keyword":   { "type": "string",  "title": "关键词",   "description": "在分类、角色、文件名里模糊综合匹配。" },
    "random":    { "type": "boolean", "title": "随机打乱", "default": true, "description": "是否打乱返回顺序。" },
    "avoid":     { "type": "array", "items": { "type": "string" }, "title": "避开的表情", "description": "需要临时避开的路径或文件名列表。" },
    "force":     { "type": "boolean", "title": "强制出图", "default": false, "description": "是否绕过概率掷骰与冷却限制。" },
    "limit":     { "type": "number",  "title": "条数", "default": 5, "description": "返回候选条数，最大 50。" },
    "offset":    { "type": "number",  "title": "偏移", "default": 0, "description": "翻页偏移，从 0 开始。" }
  },
  "required": []
}
```

- 每次调用都依次执行：冷却检定 → 概率掷骰 → 匹配 → 防重复排除 → 洗牌 → 返回候选，并提交本次频控状态。
- `mood` 先尝试落到已有分类（含同义词），落不到再退化为关键词模糊匹配；`mood` 与 `category` 同时给时以 `category` 为准。
- 返回示例：`掷骰通过：本轮配图（命中率 50%，保底进度 0/5）。匹配 23 张，显示第 1-3 张，请从中挑一张……- [表情包:得意/小明-调皮-001.gif] 小明·得意 ...`
- 未命中示例：`[出图跳过] 本轮未通过：掷骰未命中（命中率 50%，第 2 次未中，保底进度 2/5）。请保持自然，用文字表达情感，不要道歉。`

---

## 环境提示词

`src/ENV_PROMPT.md` 中的占位符必须与 `envPromptVars()` 返回的 key 一一对应：

| 占位符 | 含义 |
| --- | --- |
| `{{stickerPrompt}}` | 面板里可编辑的发图说明正文（`promptText`，留空为内置默认） |
| `{{stickerTotal}}` | 去重后的图片总数 |
| `{{stickerCategories}}` | 分类分布，如 `开心 171、得意 101、...` |

只要表情库为空或 `promptEnabled: false`，`envPromptVars()` 返回 `null`，本段提示词不注入。

---

## 事件

本扩展只注册工具与 env prompt，不订阅任何事件（`describe.events` 为空数组）。

---

## 自检 / 验收命令

扩展源码是 TypeScript 且未附 tsconfig（宿主提供 `cortico/*` 虚拟模块类型），因此采用 Node 原生类型擦除做语法与加载校验：

```bash
# 1. 仅做语法检查（Node 23.6+ 默认支持 TS，旧版加 --experimental-strip-types）
node --check src/index.ts

# 2. 实际 import 一次，确认模块可加载并检查导出与工具名
node --input-type=module -e "
const m = await import('./src/index.ts');
console.log(m.id, m.label);
console.log(m.STICKER_CATALOG_WORLD.describe.tools.map((t) => t.name));
"

# 3. 校验 describe.json 可解析且工具名同步
node -e "
const d = require('./describe.json');
console.log(d.tools.map((t) => t.name));
"
```

若本地装有 TypeScript 并自建了 tsconfig（把 `cortico/*` 映射到宿主源码或类型垫片），可再跑 `npx tsc --noEmit -p .`。

---

## 目录结构

```
cortico-world-qq-stickers/
├── package.json          # 扩展包清单（cortico.kind = world, api = 6）
├── describe.json         # 工具 / 提示词元数据（与 index.ts 的 describe 保持一致）
├── README.md
└── src/
    ├── index.ts          # World 定义、扫描、频控、两个工具的实现
    └── ENV_PROMPT.md     # 注入系统前缀的发图纪律提示词
```

---

## 版本记录

完整更新日志见 [CHANGELOG.md](CHANGELOG.md)。

---

## 致谢 / Credits

本扩展站在这些开源项目与社区实践之上，特此致谢：

- **[Cortico](https://github.com/Pal-AI-Lab/Cortico)**（Pal-AI-Lab）：Cortico World 扩展框架与 `cortico/core/types.ts`、`cortico/world.ts` 契约的上游实现。本扩展按 World API 6 编写，只做扩展，不改动框架。
- **[Coopanion](https://github.com/Pal-AI-Lab/Coopanion)**（Pal-AI-Lab）：桌面宠物宿主，本扩展以本地扩展形式运行于其 `data/extensions/local` 目录。
- **[cortico-world-qq-final](https://github.com/hth768/cortico-world-qq-final)**：QQ 协议扩展，负责把回复里的 `[表情包:分类/文件名]` 标记真正渲染成 QQ 图片消息；本扩展只产出路径，不碰协议层。
- **[fatfish-qq-bot](https://github.com/zouxinhao594-alt/fatfish-qq-bot)**（大肥鱼 · QQ 陪伴机器人）：本地表情包按情感分类、按情绪配图的思路参考了该项目的实践；本扩展在此基础上补齐了频控冷却、概率掷骰、同义词映射与防重复机制，并收口为单一工具 `qq_sticker_pick`。

参考与改动说明：

- 参考上述项目的「情感分类目录 + 角色前缀命名 + 情绪配图节奏」组织方式；
- 在原始 `sticker_catalog` 单工具的基础上收口命名（官方 `qq_` 前缀），新增窄入参的单张挑选工具，并把两者收敛到同一内部实现，避免行为分叉；
- 所有频控、掷骰、同义词与防重复行为保持原有语义，仅做工具暴露方式与提示词的规范化。

> 表情包素材（角色形象、图片）版权归各原作者所有。本扩展只按目录索引本地文件，不内嵌、不复制、不改动任何素材。

---

## License

[MIT](./LICENSE) © 2026 cortico-world-qq-stickers contributors。

## 发图通道（两种模式，面板顶部切换）

面板「QQ表情管理 · 发图通道」里有一个开关，决定这个扩展把图发到哪里：

- **关闭（qq-final）**：本扩展自己走 OneBot HTTP 通道发图，图片以 `[表情包:分类/文件名]` 标记随正文带出。
- **开启（AstrBot 桥）**：QQ 收发已交给 AstrBot 侧的桥接管，本扩展只做**发图决策**（掷骰 / 保底 / 冷却 / 防连发照旧），
  输出一个分类键（target），由模型调 `astrbot_call_tool` 让 AstrBot 侧把图发出去；此时不再输出本地路径标记。

> 该开关属于「要重启本 World 才生效」的项（面板会在标题旁标出），改完请重启 World。

### 改提示词

面板「提示词」页里只有**一个**条目，显示的就是**当前发图通道那一份成品正文**（可直接编辑）：

- `src/ENV_PROMPT_BRIDGE.md` —— AstrBot 桥通道用的正文；
- `src/ENV_PROMPT_QQFINAL.md` —— qq-final 通道用的正文。

正文里只有库信息是变量（`{{stickerLibraryLine}}` / `{{stickerTotal}}` / `{{stickerCategories}}`），其余都是静态文字，
改完保存即用（记得触发一次「重载前缀」，因为桌宠的系统前缀是会话级快照）。
切换通道需重启 World，重启后面板里的提示词条目会自动换成另一份。

面板配置里的「附加说明（可选）」会接在库信息后面，两套通道都生效。
注意：桌宠的系统前缀是**会话级快照**，改完提示词后需要触发一次「重载前缀」，否则老会话里仍是旧文案。

### 表情包从哪来

桥接模式下发的是 AstrBot 侧 `meme_manager` 的表情库（按分类键取图）。要精确挑到某一张，
需要该库已建好语义索引，模型会用 `search_memes` 拿带画面说明的候选再指定 id。
