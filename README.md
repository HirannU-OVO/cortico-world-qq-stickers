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

## 工具列表

> 下表「权限」为工具对文件的读写级别：只读不落盘，执行会向外部发信，管理会改动表情库。

| 工具（权限） | 作用与机制 |
| :--- | :--- |
| `qq_sticker_send(to, mood?)`<br>执行 | 桥接模式专用。按掷骰仲裁后直发一张贴合情绪的单段表情；`mood` 可写一句话描述场景，走语义检索选图 |
| `qq_sticker_file(mood?, category?, file?)`<br>只读 | 抽取指定或匹配的一张图片，返回 `log:` 句柄供多模态发信使用（不掷骰、不受频控） |
| `qq_sticker_pick(...)`<br>只读 | 协议扩展模式专用。掷骰并返回候选列表，模型把 `[表情包:路径]` 写进正文 |
| `qq_sticker_curate(operation, ...)`<br>管理 | 表情库策展。`audit` 列缺描述/待补向量/incoming 未归类；`inspect` 取图给模型看；`describe` 提交描述与标签（自动建向量）；`alias` 维护分类口语别名；`organize` 把 incoming 新图归入分类 |

---

## 配置参数速查

### 面板可见（`worlds.qq-stickers`）

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `enabled` | boolean | `false` | 是否启用表情管理扩展 |
| `emojiDir` | string | `""` | 表情包根目录（一级子文件夹即分类） |
| `bridgeMode` | boolean | `false` | AstrBot 桥接模式：配图改由 `qq_sticker_send` 直发 |
| `limit` | number | `5` | `qq_sticker_pick` 默认返回条数（1~20） |
| `defaultChance` | number | `0.5` | 基础发图概率（0.0 ~ 1.0），保底次数由它推导 |
| `cooldownSeconds` | number | `45` | 全局发图冷却（秒，0 关闭） |
| `categoryCooldownSeconds` | number | `90` | 同一分类的最短间隔（秒，0 关闭） |
| `recentHistorySize` | number | `10` | 防连发滑动窗口（记住最近张数） |
| `defaultRandom` | boolean | `true` | 候选是否默认打乱 |
| `promptEnabled` | boolean | `true` | 是否注入配图纪律说明 |
| `promptText` | string | `""` | 附加说明，接在纪律正文之后（两套通道都生效） |

### 运营层（配置文件，不进面板）

| 配置项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `bridgeApiUrl` | `http://127.0.0.1:6185` | AstrBot 面板地址（Open API） |
| `bridgeApiToken` | `""` | 带 `im` + `file` 两个 scope 的 Open API Key；留空则直发通道禁用 |
| `bridgePlatformId` | `""` | umo 平台名（AstrBot 侧 aiocqhttp 平台的自定义 id） |
| `semanticEmbeddingUrl` | `http://127.0.0.1:11434/v1/embeddings` | OpenAI 兼容 embedding 端点；留空只走 BM25 |
| `semanticEmbeddingModel` | `bge-m3` | embedding 模型名 |

---

## 语义索引

- **描述来源**：兼容 [meme_manager](https://github.com/anka-afk/astrbot_plugin_meme_manager)（anka，MIT）的 `semantic_metadata.json` 格式，用 `scripts/export-semantic.cjs` 按 `content_sha256` 映射到本地文件路径，产出 `sticker-semantic/semantic.json`。
- **向量重算**：描述文本统一用本机 embedding 端点重算，不与上游模型的维度/向量绑定。
- **增量维护**：索引与本地库 diff 后为新图补描述即可，旧索引不受影响；`qq_sticker_curate` 的 `audit` / `describe` 就是为此准备的。

---

## 参考与致谢

本项目为原创实现。下表列明所参考的项目、参考内容及其边界：

| 项目 | 许可 | 我们参考了什么 |
| :--- | :--- | :--- |
| [cortico-world-emote-pics](https://www.npmjs.com/package/cortico-world-emote-pics) | MIT | 桌宠侧情绪配图与概率频控的产品思路；实现为本项目独立编写 |
| [meme_manager](https://github.com/anka-afk/astrbot_plugin_meme_manager)（AstrBot 插件） | MIT | 语义元数据字段格式（`content_sha256` / `caption` / `tags`）兼容；**未包含其代码**，仅做数据格式对接 |
| [cortico-world-qq-final](https://www.npmjs.com/package/cortico-world-qq-final) | MIT | `[表情包:路径]` 标记与分段发送的消息形态约定 |
| [cortico-world-memory](https://github.com/hth768/cortico-world-memory) | 见上游仓库 | 早期版本跨包复用它；现在本包自带引擎（见 `src/semantic-engine.ts`），**无需安装**，仅在鸣谢里保留出处 |

> **边界声明**：本仓库不包含任何第三方项目的源代码或素材；表情包图片与语义描述均为使用者本地数据，未随仓库分发。与上游的交互均通过公开接口或公开数据格式完成。若权利人认为有不妥之处，欢迎提 issue 沟通处理。

---

## 许可证

[MIT License](LICENSE) © 2026 HirannU
