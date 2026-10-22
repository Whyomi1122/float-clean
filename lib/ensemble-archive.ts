/**
 * 群像杀青归档引擎（2026-10-10 新建 · 杀青归档方案）
 * ─────────────────────────────────────────────────────────────
 * 背景：对齐 chill 平台的「杀青总结」机制 —— 已杀青的剧情在 AI 眼里清空，
 *       平台保留全部记录，AI 只能靠「世界书 + 归档 + 续写指令」确认从哪继续。
 *
 * 用户拍板（2026-10-10）：
 *   ① 存储：每个剧本一份（script.archives），不全局共享。
 *   ② 「清空」= 真删：已杀青的剧情不占 token、AI 看不到（与 float 现有
 *      `turns.slice(-N)` 掐头逻辑天然契合，只是把它从"固定 N 幕"改为"杀青点"）。
 *   ③ 范围：杀青之后，AI 能看到「从杀青点起全部」剧情（不再砍 10 幕）。
 *   ④ 生成：调当前群像模型总结，**只总结剧情正文、不含任何指令/提示词**，
 *      可重新总结上一次、可直接编辑。
 *   ⑤ 格式：对齐 chill 示例 —— 头部范围行 + 【时间戳】正文 + 【关键锚点】。
 *
 * 本文件只负责「纯函数」部分：判定范围、拼装总结输入、格式化注入块。
 * 落盘（appendEnsembleArchive / undoLastEnsembleArchive）在 ensemble-storage.ts。
 */

import type { EnsembleArchiveEntry } from "./ensemble-storage";

/** 一幕（与 EnsembleTurn 对齐的最小字段集，避免循环依赖）。 */
export type ArchiveTurn = {
  id: string;
  senderType: "user" | "narration" | string;
  senderId?: string;
  senderName?: string;
  content: string;
  createdAt?: string;
};

/**
 * 计算「本次杀青应覆盖的幕」。
 *
 * 规则（对齐 chill）：从**上次杀青的截止点之后**开始，到最新一幕结束。
 *   · 首次杀青（无归档）→ 从第 1 幕开始
 *   · 再次杀青 → 从「上次归档覆盖到的最后一幕」之后再开始
 *
 * @param turns  剧本全部幕（按时间正序）。
 * @param archives 已有归档（按追加顺序，最后一条为最近一次）。
 * @returns 需要本次杀青的幕数组（可能为空 → 说明没有新剧情可杀青）。
 */
export function computePendingTurns(
  turns: ArchiveTurn[],
  archives?: EnsembleArchiveEntry[]
): ArchiveTurn[] {
  if (!turns || turns.length === 0) return [];
  const list = archives ?? [];
  if (list.length === 0) return [...turns];

  // 找最近一次归档覆盖到的最后一幕 id，返回它之后的所有幕
  const last = list[list.length - 1];
  const anchorId = last?.lastTurnId;
  if (!anchorId) return [...turns];

  const idx = turns.findIndex((t) => t.id === anchorId);
  if (idx < 0) {
    // 锚点丢失（幕被删过）→ 保守起见：全部视为待杀青，避免漏剧情
    return [...turns];
  }
  return turns.slice(idx + 1);
}

/**
 * 计算「AI 可见的幕」——杀青点之后的剧情 + 归档。
 *
 * 对齐用户口径 ③：杀青之后 AI 能看到「从杀青点起全部」。
 * 未杀青过时返回全部（首发状态）。
 */
export function computeVisibleTurns(
  turns: ArchiveTurn[],
  archives?: EnsembleArchiveEntry[]
): ArchiveTurn[] {
  const list = archives ?? [];
  if (list.length === 0) return [...turns];
  const anchorId = list[list.length - 1]?.lastTurnId;
  if (!anchorId) return [...turns];
  const idx = turns.findIndex((t) => t.id === anchorId);
  if (idx < 0) return [...turns];
  return turns.slice(idx + 1);
}

/**
 * 已杀青的幕 id 集合（用于 UI 打 ✓ Wrapped 印记）。
 */
export function computeWrappedTurnIds(
  turns: ArchiveTurn[],
  archives?: EnsembleArchiveEntry[]
): Set<string> {
  const wrapped = new Set<string>();
  const list = archives ?? [];
  if (list.length === 0) return wrapped;
  const anchorId = list[list.length - 1]?.lastTurnId;
  if (!anchorId) return wrapped;
  const idx = turns.findIndex((t) => t.id === anchorId);
  if (idx < 0) return wrapped;
  for (let i = 0; i <= idx; i++) {
    const t = turns[i];
    if (t) wrapped.add(t.id);
  }
  return wrapped;
}

/** 把一幕渲染成总结输入里的一行（保持叙述/对白的可读区分）。 */
function renderTurnForSummary(t: ArchiveTurn): string {
  const time = formatTurnTime(t.createdAt);
  const who =
    t.senderType === "narration" || t.senderId === "narration"
      ? "［旁白］"
      : t.senderName || "［角色］";
  return `${time} ${who}：${(t.content ?? "").trim()}`;
}

/** 幕时间 → `YYYY-MM-DD HH:mm`（无则为空串）。 */
function formatTurnTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}`;
}

/**
 * 构造「发给总结模型的用户提示」。
 *
 * ⚠️ 用户口径 ④：**只总结剧情正文、不含任何指令/系统提示词**。
 *    因此这里只喂 turns 的正文，绝不拼 systemPrompt / 世界书 / 状态面板。
 *
 * @param turns   本次要总结的幕（computePendingTurns 的结果）。
 * @param opts.rangeLabel 头部范围行（如 `归档 · 至 2026.09.30 WED 11:48`）。
 */
export function buildArchiveSummaryPrompt(
  turns: ArchiveTurn[],
  opts?: { rangeLabel?: string; previousArchive?: string }
): string {
  const body = turns.map(renderTurnForSummary).join("\n");
  const prev = opts?.previousArchive?.trim();
  const head = opts?.rangeLabel
    ? `─────  ${opts.rangeLabel}  ─────`
    : "─────  归档  ─────";

  return `你是一个剧本归档助手。请把下面这段**已发生的剧情**压缩成一份「归档」，供 AI 在清空原文后回忆使用。

【输出格式（严格遵守）】
${head}
【时间戳1】该时段的剧情叙述……
【时间戳2】该时段的剧情叙述……
【关键锚点】
· 关键信物 / 承诺 / 行程约定 / 关系变化 / 知情范围（逐条列出）

【要求】
- 只记录**已经发生**的剧情、人物当前认知、关系变化、物品状态。
- 按时间顺序，每个时间段一格；越近的越详细。
- 结尾必须有一段「【关键锚点】」，汇总本段最重要的几件事。
- 用第三人称；不写标题、不写解释、不写对未来剧情的建议。
- 不包含任何指令、设定、写作要求——只写剧情本身。
${prev ? `\n【上一份归档（仅用于衔接语气与风格，不要重复它的内容）】\n${prev}\n` : ""}
【本次要归档的剧情】
${body}

归档：`;
}

/**
 * 把「历史归档 + 本次归档」拼成注入 AI 的文本块。
 *
 * 注入位置：systemPrompt 里、世界书之后（归档属于"发生了什么"，
 * 世界书属于"世界是什么"，前者更贴近本轮续写）。
 *
 * @param archives 已归档条目（按追加顺序）。
 * @returns 格式化文本；无归档时为空串。
 */
export function buildArchiveBlock(archives?: EnsembleArchiveEntry[]): string {
  const list = (archives ?? []).filter((a) => (a.content ?? "").trim().length > 0);
  if (list.length === 0) return "";

  const merged = list.map((a) => a.content.trim()).join("\n\n");
  return `
═══════════ 剧情归档 · 杀青总结（这里是你"记得"的全部已发生剧情，请以它为准）═══════════
⚠️ 本块是唯一可信的过往剧情来源。**不要**试图回忆归档之外的细节——它们已被封存。
若归档与你的印象冲突，一律以归档为准。

${merged}
`;
}

/** 归档条目 → 头部范围标签（对齐 chill：`归档 · 至 2026.09.30 WED 11:48`）。 */
export function makeRangeLabel(at: Date = new Date(), override?: string): string {
  if (override && override.trim()) return override.trim();
  const wd = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][at.getDay()];
  const p = (n: number) => String(n).padStart(2, "0");
  return `归档 · 至 ${at.getFullYear()}.${p(at.getMonth() + 1)}.${p(
    at.getDate()
  )} ${wd} ${p(at.getHours())}:${p(at.getMinutes())}`;
}

/**
 * 用「剧情时间」生成头部范围标签（用户 2026-10-10 拍板）。
 *
 * ⚠️ 归档头部必须用**剧情时间**，不是现实时间——否则跑架空剧情时，
 *    头部日期会与正文里的【时间戳】驴唇不对马嘴。
 *
 * @param storyDate 剧情时间（由 resolveStoryTime(script.timeAwareness) 求得）。
 *                  没有时间感知配置时退回现实时间，保证标签一定有值。
 * @param fallback  兜底时间（默认 new Date()）。
 */
export function makeStoryRangeLabel(
  storyDate?: Date | null,
  fallback: Date = new Date()
): string {
  const d = storyDate ?? fallback;
  const wd = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][d.getDay()];
  const p = (n: number) => String(n).padStart(2, "0");
  return `归档 · 至 ${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${wd} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}`;
}

/** 统计信息（供 UI 三栏：总条数 / 已杀青 / 未杀青）。 */
export type ArchiveStats = {
  total: number;
  wrapped: number;
  pending: number;
};

export function computeArchiveStats(
  turns: ArchiveTurn[],
  archives?: EnsembleArchiveEntry[]
): ArchiveStats {
  const total = turns?.length ?? 0;
  const wrapped = computeWrappedTurnIds(turns ?? [], archives).size;
  return { total, wrapped, pending: Math.max(0, total - wrapped) };
}
