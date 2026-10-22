/**
 * 群像世界书注入引擎（2026-10-09 新建 · 世界书记忆方案「第 2 步：纯增量」）
 * ─────────────────────────────────────────────────────────────────────
 * 背景：五大引擎（chat / checkphone / black-market / calendar / cocreate）均已真实接入
 *       世界书，唯独群像（ensemble）走自己的提示词组装，从未接入 —— 本次补齐。
 *
 * 设计原则（严格遵循《世界书记忆方案 · 设计记录》）：
 *   ① **纯增量**：只加不减，不改任何现有常驻条目；老条目（无 sticky 等新字段）行为不变。
 *   ② **不漏优先**：constant（常驻）永远注入；关键词条目配合 sticky 驻留防漏。
 *   ③ **复用主引擎**：关键词匹配直接调用 `isWorldBookEntryActivated`，
 *      与单聊/群聊的世界书语义**完全一致**，不另造一套。
 *
 * 三层结构在本文件中的落点：
 *   · 第 0 层「骨架」= constant:true 的条目（世界观 / 当前状态 / 文风规则）→ 永远注入
 *   · 第 1 层「角色」= 含 key 的条目 → 关键词命中才注入
 *   · 第 2 层「场景/事件」= 含 key + sticky 的条目 → 命中后驻留 N 轮
 *
 * ⚠️ sticky 驻留状态按「剧本 × 条目 uid」维度记录在**调用方传入的 Map** 里
 *    （不落本地存储，随剧本会话生命周期），避免污染世界书本体数据。
 */

import type { WorldBookConfig, WorldBookEntry } from "./settings-types";
import { isWorldBookEntryActivated } from "./llm-prompt-assembler";

/** sticky 驻留台账：key = 世界书条目 uid，value = 剩余驻留轮数（>0 表示仍在驻留）。 */
export type StickyLedger = Map<string, number>;

/** 单条命中的记录，用于调试面板「触发日志」。 */
export type WorldBookHit = {
  uid: string;
  /** 条目备注（用于日志展示）；空时退回前 12 字正文。 */
  comment: string;
  /** 命中方式：常驻 / 关键词 / 粘性驻留。 */
  source: "constant" | "keyword" | "sticky";
  /** 所属世界书名（日志分组用）。 */
  bookName: string;
  /** 触发它的关键词（keyword 命中有值，其余为空）—— 便于用户排查「为什么这条被翻了」。 */
  matchedKey?: string;
};

/** 本轮扫描过、但**未命中**的条目（调试用：看哪些条目「相关却没触发」）。 */
export type WorldBookMiss = {
  uid: string;
  comment: string;
  bookName: string;
};

export type BuildWorldBookResult = {
  /** 已格式化的注入文本（可直接拼进 systemPrompt）；无命中时为空串。 */
  text: string;
  /** 本轮命中明细（调试用）。 */
  hits: WorldBookHit[];
  /** 本轮扫描但未命中的条目（调试用）。 */
  misses: WorldBookMiss[];
  /** 本轮参与扫描的条目总数（hits + misses）。 */
  scannedCount: number;
};

/** 单条世界书条目 → 给模型的文本行。与方案「content 写陈述句」口径一致，不加祈使前缀。 */
function formatEntry(entry: WorldBookEntry): string {
  const body = (entry.content ?? "").trim();
  return body;
}

/**
 * 解析主关键词：`key` 字段兼容「逗号分隔字符串」与「数组语义」。
 * 与 `isWorldBookEntryActivated` 内的切分口径保持一致（逗号切分 + 去空白）。
 */
function parseKeys(key: string): string[] {
  return key
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

/**
 * 判断某条目本轮是否应当激活（含 sticky 驻留判定）。
 *
 * 顺序（对齐方案「防漏」思路）：
 *   1. constant 常驻 → 永远激活。
 *   2. 关键词命中（复用主引擎，含正则 / probability / 大小写）→ 激活，
 *      且若该条目带 sticky，则**刷新**其驻留计数。
 *   3. 关键词未命中，但 sticky 台账里仍有剩余轮数 → 激活（驻留生效），并递减。
 *   4. 都不满足 → 不激活。
 *
 * @param ledger 调用方持有的 sticky 台账（按剧本维度），本函数会就地更新。
 * @returns 命中方式 + 触发关键词；未命中返回 null。
 */
export function activateEntry(
  entry: WorldBookEntry,
  contextText: string,
  ledger: StickyLedger
): { source: "constant" | "keyword" | "sticky"; matchedKey?: string } | null {
  const uid = entry.uid || entry.comment || "?";

  // 1. 常驻条目：永远注入，不参与 sticky 递减
  if (entry.constant) {
    return { source: "constant" };
  }

  // 2. 关键词命中（复用主引擎语义）
  const matched = isWorldBookEntryActivated(entry, contextText);
  if (matched) {
    // 命中且带 sticky → 刷新驻留计数（sticky 语义：命中后跟着走 N 轮）
    const sticky = typeof entry.sticky === "number" ? entry.sticky : 0;
    if (sticky > 0) ledger.set(uid, sticky);
    // 找出具体命中的关键词（纯展示用，正则模式无法定位则留空）
    const matchedKey = entry.use_regex ? undefined : findMatchedKey(entry.key, contextText);
    return { source: "keyword", matchedKey };
  }

  // 3. 未命中但仍在驻留期（sticky 生效）
  const remain = ledger.get(uid) ?? 0;
  if (remain > 0) {
    const next = remain - 1;
    if (next > 0) ledger.set(uid, next);
    else ledger.delete(uid);
    return { source: "sticky" };
  }

  // 4. 不激活
  return null;
}

/** 在上下文里找出第一个命中的主关键词（纯展示用途）。 */
function findMatchedKey(key: string, contextText: string): string | undefined {
  const lower = contextText.toLowerCase();
  return parseKeys(key).find((k) => lower.includes(k.toLowerCase()));
}

/**
 * 构造群像世界书注入文本。
 *
 * @param books       剧本绑定的世界书（由 `script.worldBookIds` → `loadWorldBooks()` 过滤得到）。
 * @param contextText 关键词匹配的比对原文（本幕上下文：最近若干回合正文 + 用户输入）。
 * @param ledger      sticky 驻留台账（调用方持有，跨轮复用）。
 * @returns 格式化文本 + 命中明细。无任何命中时 text 为空串。
 */
export function buildEnsembleWorldBookBlock(
  books: WorldBookConfig[],
  contextText: string,
  ledger: StickyLedger
): BuildWorldBookResult {
  if (!books || books.length === 0) {
    return { text: "", hits: [], misses: [], scannedCount: 0 };
  }

  const hits: WorldBookHit[] = [];
  const misses: WorldBookMiss[] = [];
  const lines: string[] = [];
  let scannedCount = 0;

  // 轮询所有绑定世界书的所有条目
  for (const book of books) {
    const bookName = book.name || "(未命名)";
    for (const entry of book.entries ?? []) {
      if (entry.disable) continue;
      // 空 key 且非常驻：无意义条目，跳过（避免空串误命中）
      if (!entry.constant && parseKeys(entry.key).length === 0) continue;

      scannedCount++;
      const uid = entry.uid || entry.comment || "?";
      const comment = entry.comment || (entry.content ?? "").trim().slice(0, 12);
      const res = activateEntry(entry, contextText, ledger);

      if (!res) {
        // 未命中：记入 misses（日志用）
        misses.push({ uid, comment, bookName });
        continue;
      }

      const body = formatEntry(entry);
      if (body) {
        hits.push({ uid, comment, source: res.source, bookName, matchedKey: res.matchedKey });
        lines.push(body);
      }
    }
  }

  if (lines.length === 0) {
    return { text: "", hits: [], misses, scannedCount };
  }

  const text = `
═══════════ 世界书 · 记忆库（本轮命中的设定，请严格遵循）═══════════
${lines.join("\n")}
`;
  return { text, hits, misses, scannedCount };
}

/**
 * 便捷入口：从「全部世界书」里挑出剧本绑定的那几本。
 *
 * @param allBooks    `loadWorldBooks()` 返回的全部世界书。
 * @param worldBookIds 剧本 `worldBookIds`（只存 id 引用，内容实时读）。
 */
export function pickBoundBooks(
  allBooks: WorldBookConfig[],
  worldBookIds?: string[]
): WorldBookConfig[] {
  if (!worldBookIds || worldBookIds.length === 0) return [];
  const idSet = new Set(worldBookIds);
  return allBooks.filter((b) => idSet.has(b.id));
}
