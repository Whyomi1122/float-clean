# 记忆与注入架构（开发口径文档）

> 维护：本文件是记忆库 / 归档回流 / App 注入的**唯一口径来源**。改相关逻辑前先读这里；
> 改完口径务必同步更新本文件。定稿日期 2026-11-02，来源：用户与 AI 的多轮实机讨论。

---

## 一、群像记忆口径（权威）

- **杀青 = AI 眼里原文真删**：杀青点之前的原文幕对 AI 不可见。
- **AI 可见 =** 杀青点之后的原文（回放）+ 全部归档合并全文 + 世界书 + 人设。
- 续写没有独立字段，靠 system prompt 契约约束。

## 二、归档回流（ensemble-memory-bridge.ts）

- 杀青 → `syncEnsembleArchiveToMemory` 把归档镜像到**剧本全体 cast** 的记忆库
  （type: `archive`，sourceApp: `ensemble`，`commitArchive` 按 contentHash 去重 + 墓碑）。
- 读取端：`retrieveArchivesForPrompt`（时间倒序 + longTermTokenBudget 预算）→
  `formatArchivesForPrompt`（【归档】标记 + 内容去重）→ 并入 longTermMemories 排最前。
- **墓碑语义**：手动在记忆库删除的归档不会被自动同步复活。
  但「撤销杀青→重新杀青」会解除墓碑（恢复性操作）；「重新同步记忆库」按钮为强制恢复（见下）。
- **修复按钮**：群像档案面板「⟳ 重新同步记忆库」= 按当前 cast 把全部归档**强制重灌**
  （先清墓碑再写入；剧本是唯一事实源）。遇到"有的角色缺记忆"点它。
- 保存档案时内容未变的条目**不会**被回收镜像（否则会自己墓碑拦死自己）。

## 三、其他 App 注入管线（lib/app-injection.ts）

**口径（2026-11-02 定稿）：每个 App 独立开关，默认关——开了才给，不开不给。**

开启后注入内容 = **长期记忆（安全）+ 群像剧情归档 + 剧本绑定世界书**（按上下文走激活管线）。
人设（角色卡自带）各引擎本来就注入，不归本管线管。

### App 清单（设置页展示的六个）

| appId | 界面名 | 引擎 | 状态 |
|---|---|---|---|
| `reading` | 漫卷 | reading-engine.ts | ✅ 已接 |
| `diary` | 手记 | diary-entry-engine.ts | ✅ 已接 |
| `checkphone` | 查手机 | checkphone-engine.ts | ✅ 已接 |
| `dwelling` | 栖所 | dwelling-engine.ts | ✅ 已接 |
| `map` | 冒险 | map-rpg-engine.ts | ✅ 已接 |
| `game` | 游戏 | game-engine.ts | ✅ 已接 |

### 已接管线但**不在清单**（无开关，默认关，行为与从前一致）

| appId | 引擎 | 备注 |
|---|---|---|
| `vn` | vn-engine.ts | 视觉小说；需要时把条目加回 `APP_INJECTION_APPS` 即可 |
| `story` | story-engine.ts | 故事 |
| `cocreate` | cocreate-engine.ts | 共创（两处调用点都已接） |
| `black-market` | black-market-scene-engine.ts | 黑市场景 |

### 未来加开关的操作

1. 在 `lib/app-injection.ts` 的 `APP_INJECTION_APPS` 里加条目（id 与引擎传入的 appId 一致）；
2. 确认对应引擎已调用 `buildAppInjectionMemories` / `buildAppScriptWorldBookBlock`
   （没有就照 vn-engine.ts 的模式改：换掉 `formatLongTermMemories(retrieveMemoriesForPrompt(...))`）；
3. UI 不用改——设置页自动渲染清单。

### 开关存储

- `kv` 键：`appInjection:<appId>`；`"1"` = 开，其他 = 关（默认关）。
- 读写：`isAppInjectionEnabled` / `setAppInjectionEnabled`（lib/app-injection.ts）。

## 四、剧情投递背景口径（lib/ensemble-delivery.ts）

- 背景全文 = 剧本背景 + **全部安全归档合并全文**（不截断）+ 杀青点→起点原文最近 8 幕
  （≤8 幕时全文保留，>8 幕每幕截 300 字）+ 起点台词 + 续写约束行 + 剧本绑定世界书。
- 同一聊天室多段投递**合并注入**（遍历所有 open sessions）。
- 投递面板「查看背景」与实际注入是同一函数产物（预览即真相）。

## 五、工具坑（给后续 AI）

- Grep 工具对中文关键词经常失灵 → 用 `git grep` 英文标识符或直接 Read。
- PowerShell 里 git push 的进度输出会被误报为 error → 看末行 `main -> main` 判断成功。
- 并行 AI 协作：**禁 `git add -A`**；push 前 `git pull --rebase`；对方（一起听）的
  未提交文件（listen-together-engine / music-context / music-now-playing）不碰。
