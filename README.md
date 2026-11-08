# cortico-world-qq-stickers

> **Cortico World 扩展**：为 [Coopanion](https://github.com/Pal-AI-Lab/Coopanion) 桌面宠物提供规范化的本地 QQ 表情包检索、情绪配图、频控掷骰与语义检索支持。

- World id：`qq-stickers`；包名：`cortico-world-qq-stickers`
- 运行形态：纯只读索引本地图片文件，不修改任何表情包素材
- 发图方式：本地库直发（经 AstrBot Open API，图文分段）或输出 `[表情包:路径]` 供 QQ 协议扩展发送
- 数据自持：表情库、语义描述与向量索引全部位于本机，凭据与端点走运营层配置

---

## 核心特性

- **单一仲裁的配图工具链**：`qq_sticker_send` 统一仲裁发图概率、保底计数、全局/分类冷却与防连发窗口；掷骰未通过时显式返回 `[出图跳过]` 与原因（含保底进度），引导模型直接以自然文本收尾。
- **多级情绪分类与同义词映射**：本地文件夹即分类（如 `开心`、`得意`、`难过`、`困惑`），内置同义词与情绪衍生词映射（如「兴奋 → 开心」「委屈 → 难过」）。
- **细粒度频控与防刷屏**：全局发图冷却 + 单分类独立冷却 + 内存 LRU 滑动窗口，自动规避近期重复与分类扎堆。
- **语义检索（可选增强）**：每张表情的「使用场景描述」经 embedding 入索引，`mood` 一句话即可召回最贴切的候选池；检索引擎（Hybrid Recall：BM25 + Cosine + RRF 融合）**内置于本包**（`src/semantic-engine.ts`），不依赖任何其它 world。
- **三级退化**：语义检索 → 同义词表匹配 → 全库随机，任一环节不可用都不影响出图。
- **治理边界**：本扩展被停用时工具随之消失，任何链路都无法发图；发图频率只由本扩展裁决。

---

## 架构与工作流程

```text
Coopanion 桌宠 (对话轮 / 主动搭话轮)
  │  调用 qq_sticker_send(to, mood)
  ▼
cortico-world-qq-stickers (扩展核心控制层)
  ├─ 频控门禁 (Gatekeeper)
  │   ├─ 基础概率掷骰 (defaultChance) 与保底计数
  │   ├─ 全局冷却 (cooldownSeconds) 与单分类冷却 (categoryCooldownSeconds)
  │   └─ 防连发滑动窗口 (recentHistorySize LRU 避重)
  │   └─ [未通过] 显式返回 [出图跳过] 及原因，引导模型纯文字收尾
  ▼
混合检索引擎 (内置 Hybrid Recall Engine)
  ├─ 语义向量检索 (BM25 + Cosine + RRF 融合，接本地 Embedding)
  ├─ 本地同义词与情绪分类映射 (三级优雅退化)
  └─ 全库洗牌兜底
  ▼
发图通道分发
  ├─ AstrBot 桥模式：经 AstrBot Open API 直发本机图片（独立单段收尾）
  └─ 协议扩展模式：返回 [表情包:路径] 标记交由底层 QQ 协议扩展发出
```

---


## 配套插件

本扩展与 **[cortico-world-qq-initiative](https://github.com/HirannU-OVO/cortico-world-qq-initiative)** 配合使用：

- 主动搭话轮由 `qq-initiative` 驱动，配图统一交给本扩展的 `qq_sticker_send`，掷骰与频控不分散；
- 对方发消息的对话轮同样走 `qq_sticker_send`，两种轮次一套账本。

两个插件可独立安装，同装时自动配合；本扩展停用后，主动搭话轮只会发纯文字。

---

## 安装与快速上手

### 1. 放置扩展

将扩展目录放置于桌宠扩展目录：

```
%COOPANION_DIR%/data/extensions/local/cortico-world-qq-stickers/
```

### 2. 启用扩展

在 Coopanion 的扩展管理中启用本扩展，或在 `config.json` 中配置：

```jsonc
{
  "worlds": {
    "qq-stickers": {
      "enabled": true,
      "emojiDir": "D:/path/to/sticker-library" // 本机表情包根目录：一级子文件夹即分类
    }
  }
}
```

### 3. 选择发图通道

| 通道 | 配置 | 行为 |
| :--- | :--- | :--- |
| **AstrBot 桥接** | `bridgeMode: true` | 配图由本扩展经 AstrBot Open API 直发本机表情，对话轮与主动搭话轮通用；需配好运营层的 `bridgeApiUrl` / `bridgeApiToken` / `bridgePlatformId` |
| **协议扩展** | `bridgeMode: false` | `qq_sticker_pick` 掷骰后返回候选，模型把 `[表情包:分类/文件名]` 写进正文，由 QQ 协议扩展（如 `cortico-world-qq-final`）发出 |

### 4. 语义检索（可选）

索引文件 `sticker-semantic/vector-memory.json` 自带清单：`schema`（格式版本）、`model_name`（出向量的模型）、
`dimension`（向量维度）、`updated_at`。启动时会做三件事：

- **维度对账**：与当前维度不一致的条目在检索时跳过（换过 embedding 模型不会炸库），日志会报「N 条维度不符已跳过」；
- **失效清理**：表情被删/改名后，对应向量会被清掉，日志报「清掉 N 条已失效」；
- **后台补向量**：缺向量的条目按批补，`qq_sticker_curate(operation="audit")` 能看到待补数量。

换 embedding 模型或维度时不需要手动删索引：旧向量会被判定为维度不符而跳过，缺的会按新模型补上。


语义描述放在表情库旁的 `sticker-semantic/semantic.json`，由一次性迁移脚本按内容哈希生成（详见下文「语义索引」）。未配置 embedding 端点时自动只走 BM25 文本检索。

---

## 工具 / 接口列表

> 下表「权限」为工具对文件的读写级别：只读不落盘，执行会向外部发信，管理会改动表情库。

| 工具（权限） | 作用与机制 |
| :--- | :--- |
| `qq_sticker_send(to, mood?)`<br>执行 | 桥接模式专用。按掷骰仲裁后直发一张贴合情绪的单段表情；`mood` 可写一句话描述场景，走语义检索选图 |
| `qq_sticker_file(mood?, category?, file?)`<br>只读 | 抽取指定或匹配的一张图片，返回 `log:` 句柄供多模态发信使用（不掷骰、不受频控） |
| `qq_sticker_pick(...)`<br>只读 | 协议扩展模式专用。掷骰并返回候选列表，模型把 `[表情包:路径]` 写进正文 |
| `qq_sticker_curate(operation, ...)`<br>管理 | 表情库策展。`audit` 列缺描述/待补向量/incoming 未归类；`inspect` 取图给模型看；`describe` 提交描述与标签（自动建向量）；`alias` 维护分类口语别名；`organize` 把 incoming 新图归入分类 |

---

## 配置参数速查

### 面板可见：发图通道（`world:qq-stickers-mode`）

| 面板显示名 | 配置 id | 类型 | 默认值 | 说明 |
| :--- | :--- | :---: | :---: | :--- |
| AstrBot 桥模式 | `bridgeMode` | 布尔 | `false` | 打开后配图由 `qq_sticker_send` 直发本机表情，关闭后该工具停用；改完需重启 |
| 直发回执标注选图来源 | `sendSourceNote` | 布尔 | `true` | 回执注明是语义匹配、分类关键词兜底还是随机抽取 |
| 直发后把图也回给模型看 | `sendBackImage` | 布尔 | `false` | 直发成功后把图片作为附件回传模型供复核，想省 token 可关闭 |
| 单图上限（MB） | `maxImageMb` | 数字 | `10` | 单张表情大小上限（1~100MB），超限直接跳过 |

### 面板可见：情感与频控（`world:qq-stickers`）

| 面板显示名 | 配置 id | 类型 | 默认值 | 说明 |
| :--- | :--- | :---: | :---: | :--- |
| 表情库根目录 | `emojiDir` | 字符串 | 空 | 本机表情包存放目录，一级子文件夹即情感分类 |
| 默认返回条数 | `limit` | 数字 | `5` | `qq_sticker_pick` 默认候选条数（1~20） |
| 基础触发概率 (0~1) | `defaultChance` | 数字 | `0.5` | 模型尝试出图时的基础掷骰概率，未命中引导纯文本回复 |
| 全局发图冷却时间 (秒) | `cooldownSeconds` | 数字 | `45` | 两次发图之间的最短间隔时间，设为 0 关闭 |
| 同类情感冷却时间 (秒) | `categoryCooldownSeconds` | 数字 | `90` | 同一分类连续出图的最短间隔，避免表情扎堆 |
| 防重复历史记忆窗口 | `recentHistorySize` | 数字 | `10` | 内存中记录最近出过的表情张数，匹配充足时强制避开 |
| 默认随机乱序 | `defaultRandom` | 布尔 | `true` | 未显式指定时是否默认打乱候选顺序 |
| 注入情绪配图说明 | `promptEnabled` | 布尔 | `true` | 系统前缀中是否自动注入发图纪律与表情库概览 |
| 附加说明（可选） | `promptText` | 字符串 | 空 | 接在发图纪律正文后的自定义提示词说明 |

### 运营层（配置文件，不进面板）

| 配置项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `bridgeApiUrl` | `http://127.0.0.1:6185` | AstrBot 面板地址（Open API） |
| `bridgeApiToken` | `""` | 带 `im` + `file` 两个 scope 的 Open API Key；留空则直发通道禁用 |
| `bridgePlatformId` | `""` | umo 平台名（AstrBot 侧 aiocqhttp 平台的自定义 id） |
| `semanticEmbeddingUrl` | `http://127.0.0.1:11434/v1/embeddings` | OpenAI 兼容 embedding 端点；留空只走 BM25 |
| `semanticEmbeddingModel` | `bge-m3` | embedding 模型名 |

---

## 常见排障

| 现象 | 原因 | 处理 |
| :--- | :--- | :--- |
| 模型调了 `qq_sticker_send` 却没发出图片 | 基础概率掷骰未通过或处于发图冷却期 | 检查回执中的 `[出图跳过]` 原因；频控保护下未通过时会附带保底进度并引导模型以纯文字收尾，属于正常预期行为 |
| 语义检索未生效，回执总显示兜底或随机 | 本地 Embedding 端点未连通或未配置 | 检查运营层配置 `semanticEmbeddingUrl` 是否已连通本机端点；未配置时会自动降级为 BM25 关键词与同义词分类兜底 |
| 新加的表情图片如何建立语义描述与向量 | 需执行策展流程提取特征并写入索引 | 图片放入对应分类目录后，可通过 `qq_sticker_curate(operation="audit")` 检查待补列表，并用 `describe` 补充描述生成向量 |

---

## 语义索引

- **描述来源**：兼容 [meme_manager](https://github.com/anka-afk/astrbot_plugin_meme_manager)（anka，MIT）的 `semantic_metadata.json` 格式，用 `scripts/export-semantic.cjs` 按 `content_sha256` 映射到本地文件路径，产出 `sticker-semantic/semantic.json`。
- **向量重算**：描述文本统一用本机 embedding 端点重算，不与上游模型的维度/向量绑定。
- **增量维护**：索引与本地库 diff 后为新图补描述即可，旧索引不受影响；`qq_sticker_curate` 的 `audit` / `describe` 就是为此准备的。

---

## 依赖与参考

| 上游项目 | 用途 | 许可 |
| :--- | :--- | :--- |
| [cortico-world-emote-pics](https://www.npmjs.com/package/cortico-world-emote-pics) | 桌宠情绪配图与概率频控的产品思路参考 | MIT |
| [meme_manager](https://github.com/anka-afk/astrbot_plugin_meme_manager) | 语义元数据字段（`content_sha256` / `caption` / `tags`）的格式对接参考 | MIT |
| [cortico-world-qq-final](https://www.npmjs.com/package/cortico-world-qq-final) | `[表情包:路径]` 标记与分段发送的消息形态约定参考 | MIT |


## 许可证

[MIT License](LICENSE) © 2026 HirannU
