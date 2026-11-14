// lib/narrative-ledger.ts
// 剧情台账：把「还悬着什么」从归档正文里抽出来，变成结构化、可追踪、不会自动收束的数据。
//
// 为什么要它：归档只记「已经发生过什么」，长剧情会铺不开——模型记不住哪条线还没完、
// 该谁推动、下一步该走到哪。这里补上另一半：线索（thread）与伏笔（foreshadow）台账。
//
// 设计红线（照执笔文档的核心约束）：
//   · 代码只管数据结构与推进轮次，**不写正文、不替角色做决定**；
//   · 状态只能「升一级」，永远不自动收束（resolved 只能人工或采纳时确认）；
//   · 冲突 / 跨度超限的最高只到「待核（pending）」，不直接注入正文；
//   · 每条都有 audience（知情范围），写某视角时过滤掉他不该知道的东西。
//
// 存储：kv-db，一个 scope（剧本 / 会话）一条 JSON，key = `narrative-ledger:<scope>`。

import { kvGet, kvKeysWithPrefix, kvSet } from "@/lib/kv-db";

/** 线索状态：潜伏 → 升温 → 爆发，收束只能人工。 */
export type ThreadStatus = "latent" | "heating" | "climax" | "resolved";

/** 知情范围：全员 / 只有「我」 / 系统预埋（不注入正文）/ 指定角色。 */
export type LedgerAudience = "all" | "user" | "system" | `char:${string}`;

/** 审核态：正常 / 待核（不注入正文，等人工确认）/ 已归档。 */
export type LedgerReviewState = "active" | "pending" | "archived";

export interface LedgerThread {
  id: string;
  name: string;
  status: ThreadStatus;
  /** 相关角色名（用于按视角过滤、以及在群像里决定谁来推）。 */
  characters: string[];
  /** 上次推进到第几轮（代码只 +1，不跳级）。 */
  lastAdvancedTurn: number;
  /** 每次推进都留痕；planned=true 表示「已计划、正文未到」。 */
  changes: { turn: number; text: string; planned: boolean; at: number }[];
  /** 下一步该往哪走（一句话，人工或采纳时写）。 */
  nextStep: string;
  audience: LedgerAudience;
  review: LedgerReviewState;
  createdAt: number;
  updatedAt: number;
}

export interface LedgerForeshadow {
  id: string;
  content: string;
  /** 埋下时是第几轮。 */
  plantedTurn: number;
  /** 预期兑现窗口（一句话，如「下次独处时」）。 */
  expectedWindow: string;
  /** 兑现条件（一句话）。 */
  revealCondition: string;
  status: "open" | "closed";
  linkedThreadId?: string;
  audience: LedgerAudience;
  review: LedgerReviewState;
  createdAt: number;
  updatedAt: number;
}

export interface NarrativeLedger {
  version: 1;
  scope: string;
  /** 当前推进轮次。 */
  turn: number;
  threads: LedgerThread[];
  foreshadows: LedgerForeshadow[];
  updatedAt: number;
}

const KEY_PREFIX = "narrative-ledger:";
const STATUS_ORDER: ThreadStatus[] = ["latent", "heating", "climax", "resolved"];

export const THREAD_STATUS_LABEL: Record<ThreadStatus, string> = {
  latent: "潜伏",
  heating: "升温",
  climax: "爆发",
  resolved: "收束",
};

function ledgerKey(scope: string): string {
  return `${KEY_PREFIX}${scope}`;
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** 名称归一：去空白与书名号/引号，便于同名合并（同一件事不要长出两条线）。 */
export function normalizeThreadName(name: string): string {
  return (name ?? "")
    .replace(/[《》「」『』【】"'“”]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

export function createEmptyLedger(scope: string): NarrativeLedger {
  return { version: 1, scope, turn: 0, threads: [], foreshadows: [], updatedAt: Date.now() };
}

export function loadNarrativeLedger(scope: string): NarrativeLedger {
  const raw = kvGet(ledgerKey(scope));
  if (!raw) return createEmptyLedger(scope);
  try {
    const parsed = JSON.parse(raw) as NarrativeLedger;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.threads)) return createEmptyLedger(scope);
    return {
      ...createEmptyLedger(scope),
      ...parsed,
      scope,
      threads: parsed.threads ?? [],
      foreshadows: parsed.foreshadows ?? [],
    };
  } catch {
    return createEmptyLedger(scope);
  }
}

export function saveNarrativeLedger(ledger: NarrativeLedger): void {
  const next = { ...ledger, updatedAt: Date.now() };
  kvSet(ledgerKey(next.scope), JSON.stringify(next));
}

/** 只读列出所有已有台账的 scope（面板用）。 */
export function listLedgerScopes(): string[] {
  return kvKeysWithPrefix(KEY_PREFIX).map(key => key.slice(KEY_PREFIX.length));
}

export interface ThreadInput {
  name: string;
  characters?: string[];
  audience?: LedgerAudience;
  nextStep?: string;
  turn?: number;
}

/**
 * 新建或更新一条线索（同名合并，不会长出重复线）。
 * 返回新台账与该线索 id；review 判定为「待核」时不注入正文。
 */
export function upsertThread(
  ledger: NarrativeLedger,
  input: ThreadInput,
): { ledger: NarrativeLedger; threadId: string; created: boolean } {
  const normalized = normalizeThreadName(input.name);
  if (!normalized) {
    return { ledger, threadId: "", created: false };
  }
  const existing = ledger.threads.find(
    thread => thread.review !== "archived" && normalizeThreadName(thread.name) === normalized,
  );
  const turn = input.turn ?? ledger.turn;
  const now = Date.now();
  if (existing) {
    const threads = ledger.threads.map(thread =>
      thread.id === existing.id
        ? {
            ...thread,
            characters: Array.from(new Set([...(thread.characters ?? []), ...(input.characters ?? [])])),
            nextStep: input.nextStep?.trim() ? input.nextStep.trim() : thread.nextStep,
            audience: input.audience ?? thread.audience,
            updatedAt: now,
          }
        : thread,
    );
    return { ledger: { ...ledger, threads }, threadId: existing.id, created: false };
  }
  const thread: LedgerThread = {
    id: makeId("th"),
    name: input.name.trim(),
    status: "latent",
    characters: input.characters ?? [],
    lastAdvancedTurn: turn,
    changes: [],
    nextStep: input.nextStep?.trim() ?? "",
    audience: input.audience ?? "all",
    review: "active",
    createdAt: now,
    updatedAt: now,
  };
  return { ledger: { ...ledger, threads: [...ledger.threads, thread] }, threadId: thread.id, created: true };
}

/**
 * 推进一条线索：轮次记下来，状态**最多升一级**，收束后不再动。
 * 返回 null 表示找不到 / 已收束（调用方别当成功）。
 */
export function advanceThread(
  ledger: NarrativeLedger,
  threadId: string,
  changeText: string,
  options?: { planned?: boolean; turn?: number },
): NarrativeLedger | null {
  const thread = ledger.threads.find(item => item.id === threadId);
  if (!thread || thread.status === "resolved") return null;
  const turn = options?.turn ?? ledger.turn;
  const currentIndex = STATUS_ORDER.indexOf(thread.status);
  const nextStatus = STATUS_ORDER[Math.min(currentIndex + 1, STATUS_ORDER.indexOf("climax"))];
  const now = Date.now();
  const threads = ledger.threads.map(item =>
    item.id === threadId
      ? {
          ...item,
          status: nextStatus,
          lastAdvancedTurn: turn,
          changes: [
            ...item.changes,
            { turn, text: (changeText ?? "").trim(), planned: options?.planned === true, at: now },
          ].slice(-40),
          updatedAt: now,
        }
      : item,
  );
  return { ...ledger, threads };
}

/** 收束（只能人工 / 采纳时调用，代码不会自动收）。 */
export function resolveThread(ledger: NarrativeLedger, threadId: string, reason = ""): NarrativeLedger {
  const now = Date.now();
  return {
    ...ledger,
    threads: ledger.threads.map(thread =>
      thread.id === threadId
        ? {
            ...thread,
            status: "resolved",
            changes: [
              ...thread.changes,
              { turn: ledger.turn, text: reason.trim() || "已收束", planned: false, at: now },
            ].slice(-40),
            updatedAt: now,
          }
        : thread,
    ),
  };
}

/** 归档（从正文视野里拿掉，但记录保留）。 */
export function archiveThread(ledger: NarrativeLedger, threadId: string): NarrativeLedger {
  return {
    ...ledger,
    threads: ledger.threads.map(thread =>
      thread.id === threadId ? { ...thread, review: "archived", updatedAt: Date.now() } : thread,
    ),
  };
}

/** 待核：不注入正文，等人工确认（冲突 / 跨度超限时用）。 */
export function markThreadPending(ledger: NarrativeLedger, threadId: string): NarrativeLedger {
  return {
    ...ledger,
    threads: ledger.threads.map(thread =>
      thread.id === threadId ? { ...thread, review: "pending", updatedAt: Date.now() } : thread,
    ),
  };
}

export function plantForeshadow(
  ledger: NarrativeLedger,
  input: { content: string; expectedWindow?: string; revealCondition?: string; audience?: LedgerAudience; linkedThreadId?: string; turn?: number },
): { ledger: NarrativeLedger; foreshadowId: string } {
  const content = (input.content ?? "").trim();
  if (!content) return { ledger, foreshadowId: "" };
  const now = Date.now();
  const foreshadow: LedgerForeshadow = {
    id: makeId("fs"),
    content,
    plantedTurn: input.turn ?? ledger.turn,
    expectedWindow: input.expectedWindow?.trim() ?? "",
    revealCondition: input.revealCondition?.trim() ?? "",
    status: "open",
    linkedThreadId: input.linkedThreadId,
    audience: input.audience ?? "all",
    review: "active",
    createdAt: now,
    updatedAt: now,
  };
  return { ledger: { ...ledger, foreshadows: [...ledger.foreshadows, foreshadow] }, foreshadowId: foreshadow.id };
}

export function closeForeshadow(ledger: NarrativeLedger, foreshadowId: string): NarrativeLedger {
  return {
    ...ledger,
    foreshadows: ledger.foreshadows.map(item =>
      item.id === foreshadowId ? { ...item, status: "closed", updatedAt: Date.now() } : item,
    ),
  };
}

/**
 * 从归档的【关键锚点】文本里挑出「待兑现」——只作为**候选**返回，不自动写台账，
 * 由面板或采纳流程决定要不要建线（避免模型一句话就长出十条线）。
 */
export function parseAnchorCandidates(anchorText: string): string[] {
  if (!anchorText) return [];
  const lines = anchorText.split(/\n+/).map(line => line.replace(/^[\s\-*·\d.、]+/, "").trim()).filter(Boolean);
  const collected: string[] = [];
  let inPending = false;
  for (const line of lines) {
    if (/^(【?待兑现】?|待兑现|未兑现|悬而未决)/.test(line)) {
      inPending = true;
      const rest = line.replace(/^(【?待兑现】?|待兑现|未兑现|悬而未决)[：:]?/, "").trim();
      if (rest) collected.push(rest);
      continue;
    }
    if (/^(【?(物品与状态|认知与事实澄清|违规隐患|关系变化)】?)/.test(line)) {
      inPending = false;
      continue;
    }
    if (inPending) collected.push(line);
  }
  return Array.from(new Set(collected.map(item => item.replace(/^[\s\-*·]+/, "").trim()).filter(Boolean))).slice(0, 20);
}

/** 视角过滤：谁该看到这条（all 全员可见；char:名字 只有该角色；user 只有「我」；system 永不注入）。 */
export function audienceAllows(audience: LedgerAudience, viewer?: string): boolean {
  if (audience === "system") return false;
  if (audience === "all") return true;
  if (audience === "user") return viewer === "user";
  if (audience.startsWith("char:")) {
    return Boolean(viewer) && audience.slice(5) === viewer;
  }
  return true;
}

/**
 * 生成注入正文的台账块（纯文本，短）。
 * 只取 active、未收束的条目；按视角过滤；限条数，超了截断并提示还有几条。
 */
export function buildLedgerPromptBlock(
  ledger: NarrativeLedger,
  options?: { viewer?: string; maxThreads?: number; maxForeshadows?: number },
): string {
  const viewer = options?.viewer;
  const maxThreads = options?.maxThreads ?? 6;
  const maxForeshadows = options?.maxForeshadows ?? 4;

  const threads = ledger.threads.filter(
    thread => thread.review === "active" && thread.status !== "resolved" && audienceAllows(thread.audience, viewer),
  );
  const foreshadows = ledger.foreshadows.filter(
    item => item.review === "active" && item.status === "open" && audienceAllows(item.audience, viewer),
  );
  if (!threads.length && !foreshadows.length) return "";

  const lines: string[] = ["【线索台账】（这些线还没走完；可以推进一格，不要一次收束，也不要替角色编新的事实）"];
  threads.slice(0, maxThreads).forEach((thread, index) => {
    const people = thread.characters.length ? `｜相关：${thread.characters.join("、")}` : "";
    const next = thread.nextStep ? `｜下一步：${thread.nextStep}` : "";
    lines.push(`${index + 1}. ${thread.name}｜${THREAD_STATUS_LABEL[thread.status]}${people}${next}`);
  });
  if (threads.length > maxThreads) lines.push(`（另有 ${threads.length - maxThreads} 条线索未列出）`);
  if (foreshadows.length) {
    lines.push("【伏笔】（已埋下、还没兑现；时机合适可以露一点，别急着全说破）");
    foreshadows.slice(0, maxForeshadows).forEach((item, index) => {
      const when = item.expectedWindow ? `｜窗口：${item.expectedWindow}` : "";
      lines.push(`${index + 1}. ${item.content}${when}`);
    });
    if (foreshadows.length > maxForeshadows) lines.push(`（另有 ${foreshadows.length - maxForeshadows} 条伏笔未列出）`);
  }
  return lines.join("\n");
}

export function ledgerStats(ledger: NarrativeLedger): {
  activeThreads: number;
  pendingThreads: number;
  openForeshadows: number;
  turn: number;
} {
  return {
    activeThreads: ledger.threads.filter(thread => thread.review === "active" && thread.status !== "resolved").length,
    pendingThreads: ledger.threads.filter(thread => thread.review === "pending").length,
    openForeshadows: ledger.foreshadows.filter(item => item.status === "open" && item.review === "active").length,
    turn: ledger.turn,
  };
}
