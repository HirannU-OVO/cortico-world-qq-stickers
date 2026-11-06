## [Unreleased]

开发中（`package.json` 记 `0.3.2-dev.1`）。按规范，正式发布打 Tag 时再把这里整合成 `0.3.2`。

### 变更

- **语义索引改为自带引擎，不再依赖其它 world**：原来 `src/semantic.ts` 会跨包动态 import
  `cortico-world-memory` 的 `VectorStore` / `EmbeddingClient`，那个世界一被卸载或精简，语义检索就整段失效
  （日志「表情语义索引不可用」），对只想装表情包的用来说等于被强制多装一个 world。
  现在检索引擎（BM25 + Cosine + RRF）与 embedding 客户端都在本包 `src/semantic-engine.ts`，零外部依赖，
  数据文件格式保持兼容（旧 `vector-memory.json` 直接可读，无需重建）。
- **索引加清单与自检**（参考 AstrBot meme_manager 的做法）：`vector-memory.json` 现在带
  `schema`（格式版本）/`model_name`（出向量的模型）/`dimension`/`updated_at`；
  启动时做维度对账（换模型后维度不符的条目检索时跳过并计数）、失效清理（表情删了对应向量清掉）、
  后台补向量。启动日志会报「索引 v2 / 模型 xxx / 1024 维 / N 条维度不符已跳过 / 清掉 N 条已失效」。
- **新增自测**：`test/semantic-engine.test.mjs` 12 条断言（fp16 往返、CJK 分词、BM25、向量路 via、
  维度对账、失效清理、长文本不误删、原子落盘、两种 embedding 回包、端点留空关闭向量路）。
  `npm test` 可跑。

### 升级提示

- 之前为了兼容语义检索而安装的 `cortico-world-memory` 现在**可以卸掉**，不再被本扩展需要。

# 更新日志

本文件记录「QQ 表情管理」扩展的版本变化。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.3.1] - 2026-11-05

> 本版把「按分类随机配图」升级为「按语义描述选图」，并补齐桥接直发与策展工具：
> 对话轮与主动搭话轮共用一套掷骰账本，图片不再依赖 QQ 协议扩展的标记解析。

### 新增

- **语义检索**：每张表情的 caption 与 tags 经 embedding 建索引，`mood` 直接写一句话（如「被夸了有点不好意思」）即可召回最贴切的候选；检索引擎复用 cortico-world-memory 的 Hybrid Recall（BM25 + Cosine + RRF），跨包动态加载。
- **三级退化**：语义检索 → 同义词表匹配 → 全库随机，任一环节不可用都不影响出图；embedding 端点留空时只走 BM25 文本检索。
- **桥接直发 `qq_sticker_send`**：经 AstrBot Open API 直接把本机表情发到 QQ（独立一段收尾），不依赖真实 QQ 事件，对话轮与主动搭话轮通用。
- **附件通道 `qq_sticker_file`**：把一张表情作为附件取出（`log:` 句柄），配合 `astrbot_send_message(image=…)` 使用。
- **策展工具 `qq_sticker_curate`**：`audit` 列缺描述/待补向量/incoming 未归类文件，`inspect` 取图给模型看，`describe` 提交描述与标签（自动建向量），`alias` 维护分类口语别名，`organize` 把 incoming 新图归入分类。
- **分类别名外置**：别名存于 `sticker-semantic/aliases.json`，不同表情库无需改代码。

### 修复

- 掷骰通过但所选分类没有匹配图时，不再把「通过但没图」发回模型，而是全库兜底随机一张并在回执写明。
- 复合情感词（「得意 开心」「害羞 被抓包」）整句比分类名必然落空：改为先切词再逐个过同义词表。
- 工具带屏障导致同一轮里后续发信工具被拦成未执行：已移除屏障。
- 情绪词带修饰语（「有点得意」「特别难过」）匹配落空：补子串匹配；否定说法（「不开心」「没有生气」）会被识别拦下，不会反着配图。
- `qq_sticker_file` 未接语义索引导致口语 mood 被掰成粗略分类、选图跑偏。
- `incoming/` 不再被当成分类参与选图；空语义索引不再判定为不可用（冷启动逐条 describe 即可自举）。

### 优化

- 选图路由改为「分类优先、语义兜底」：标准情绪词走分类池，整句/口语描述才进语义检索；语义命中收窄到 top-3 且优先向量路命中，串图明显减少。
- 单次候选上限 50 → 20，避免候选列表挤占上下文。
- 提示词改为每个通道一份成品模板，面板只显示当前通道那份、正文可直接编辑；提示词单源校验并入 `npm run check`。
- 工具回执直接写明本轮掷骰结果与保底进度，被跳过时写明冷却或概率原因。

## [0.2.0] - 2026-11-02

### 新增

- 新增 `qq_sticker_pick`，与 catalog 共用同一实现。

### 优化

- 工具按 QQ 生态官方前缀收口为 `qq_sticker_catalog`。
- 同步 `describe.json` / `ENV_PROMPT.md` / README。
- 包描述改为「QQ 生态表情管理」定位。

## [0.1.0] - 2026-10-30

### 新增

- 首个可用版本，`sticker_catalog` 单工具 + 情感分类 + 频控冷却 + 概率掷骰 + 同义词 + 防重复。
