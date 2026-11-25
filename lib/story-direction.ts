/**
 * 群像 · 下一步走向（走向卡）
 *
 * 定位：用户只能写"自己的对白和动作"，结果角色一直被动跟着走。走向卡补上
 * 「不由用户驱动」的那一半剧情 —— **程序抽类型、模型写具体、用户选一张**，
 * 采纳后下一轮真的发生。
 *
 * 铁律（别改）：
 * - 只提供方向，**不替用户写戏**：任何卡都不许写用户的动作、台词、心理。
 * - 一次性使用：用掉就散，不写消息流、不进归档、不改记忆、不动好感度。
 * - 生成是**独立调用**（独立 messages + 独立 system prompt），不 push 会话、
 *   不触发归档/记忆提炼，也不写任何剧本字段。
 * - 每批两张、类型必定不同类型（重抽也一样）；跨批用 recent 去重（交给模型避让，
 *   不做字符串相似度，避免误杀）。
 */
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { simpleLLMCall } from "./api-helpers";
import { buildArchiveBlock } from "./ensemble-archive";
import { buildEnsembleWorldBookBlock, pickBoundBooks, type StickyLedger } from "./ensemble-worldbook";
import { resolveStoryTime } from "./ensemble-time";
import { loadWorldBooks } from "./settings-storage";

/* ─────────────────────────── 类型 ─────────────────────────── */

export type DirectionType = "character" | "you" | "environment" | "accident";

export interface StoryDirection {
    id: string;
    type: DirectionType;
    /** ≤ 10 字，一眼看懂「谁要做什么」 */
    title: string;
    /** 会发生什么：一句可见的行为，不写心理不写气氛 */
    event: string;
    /** 后果：必须真的改变处境 */
    consequence: string;
    /**
     * 2026-11-24：这张卡「针对谁 / 针对哪件事」。
     * 由代码从归档【关键锚点】里挑「最近最没被提到」的线头（挑不到退到最久没露面的角色），
     * 目标是保证每张卡都有具体对象，而不是泛泛地说"他会问点什么"。
     */
    target?: string;
}

/** recent 里存的最小单元（展示过即记，最多 10 条 ≈ 5 批） */
export interface DirectionRecentEntry {
    type: DirectionType;
    title: string;
    gist: string;
}

export interface StoryDirectionState {
    active?: StoryDirection;
    /** 上一批抽到的两张（关掉弹窗再打开要还原，不能重新抽） */
    lastBatch?: StoryDirection[];
    /** 抽这批时的回合数：回合数变了说明戏往前走过了，旧卡就作废 */
    lastBatchTurns?: number;
    /** 2026-11-24：批次序号，`换一批` 就 +1 → 取下一组类型配方（老数据没有也行） */
    batchIndex?: number;
    recent: DirectionRecentEntry[];
}

export const DIRECTION_TYPE_LABEL: Record<DirectionType, string> = {
    character: "角色卡",
    you: "你的卡",
    environment: "环境卡",
    accident: "意外卡",
};

/** v1 四类权重（角色 50 / 你的 20 / 环境 20 / 意外 10） */
const DIRECTION_WEIGHTS: Record<DirectionType, number> = {
    character: 50,
    you: 20,
    environment: 20,
    accident: 10,
};

const ALL_TYPES: DirectionType[] = ["character", "you", "environment", "accident"];
const RECENT_MAX = 10;

/**
 * 三组类型配方轮换（2026-11-24，借鉴《执笔》的「类型批次轮换」）。
 * 每点一次「换一批」就换下一组，避免连着几批都是同一种味道。
 */
const DIRECTION_BATCH_PLAN: DirectionType[][] = [
    ["character", "environment"], // 组1 推进：角色动 + 环境变
    ["you", "character"],         // 组2 关系：你的选择 + 角色反应
    ["accident", "you"],          // 组3 变数：意外 + 你的应对
];

/* ─────────────────────────── 本地存储 ─────────────────────────── */

const LS_KEY = "float_ensemble_story_direction_v1";

type Store = Record<string, StoryDirectionState | undefined>;

function loadStore(): Store {
    if (typeof window === "undefined") return {};
    try {
        const raw = window.localStorage.getItem(LS_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? (parsed as Store) : {};
    } catch {
        return {};
    }
}

function saveStore(store: Store) {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(LS_KEY, JSON.stringify(store));
    } catch { /* 存不下就算了，功能降级为不跨刷新保留 */ }
}

export function loadStoryDirectionState(scriptId?: string): StoryDirectionState {
    if (!scriptId) return { recent: [] };
    const state = loadStore()[scriptId];
    if (!state) return { recent: [] };
    return { ...state, recent: Array.isArray(state.recent) ? state.recent : [] };
}

export function saveStoryDirectionState(scriptId: string | undefined, state: StoryDirectionState) {
    if (!scriptId) return;
    const store = loadStore();
    store[scriptId] = state;
    saveStore(store);
}

/** 采纳 / 撤销：只动 active，不碰 recent */
export function setActiveDirection(scriptId: string | undefined, active: StoryDirection | null) {
    if (!scriptId) return;
    const state = loadStoryDirectionState(scriptId);
    saveStoryDirectionState(scriptId, { ...state, active: active ?? undefined });
}

/** 展示过即记（不采纳也记），去重靠它；顺带把这一批存成 lastBatch 供重开还原 */
export function rememberBatch(scriptId: string | undefined, cards: StoryDirection[], turnCount?: number) {
    if (!scriptId || cards.length === 0) return;
    const state = loadStoryDirectionState(scriptId);
    const added: DirectionRecentEntry[] = cards.map(c => ({
        type: c.type,
        title: c.title,
        gist: c.event,
    }));
    const recent = [...added, ...state.recent].slice(0, RECENT_MAX);
    saveStoryDirectionState(scriptId, { ...state, lastBatch: cards, lastBatchTurns: turnCount, recent });
}

/**
 * 重开弹窗时该还原哪一批：回合数没变（戏没往前走）就还原来那两张，
 * 变了说明现场已经不同，旧卡作废、重新抽。
 */
export function restoreLastBatch(scriptId: string | undefined, turnCount?: number): StoryDirection[] {
    const state = loadStoryDirectionState(scriptId);
    const batch = state.lastBatch ?? [];
    if (batch.length === 0) return [];
    if (typeof turnCount === "number" && typeof state.lastBatchTurns === "number" && state.lastBatchTurns !== turnCount) {
        return [];
    }
    return batch;
}

/** 刷新/切剧本时把没用的卡丢掉：只保留已经采纳的 active 与 recent */
export function clearLastBatch(scriptId: string | undefined) {
    if (!scriptId) return;
    const state = loadStoryDirectionState(scriptId);
    if (!state.lastBatch) return;
    saveStoryDirectionState(scriptId, { ...state, lastBatch: undefined });
}

/**
 * 开新一批：批次序号 +1 并落盘，返回新序号。
 * 「换一批」＝走下一组类型配方（`drawCardTypes(recent, batchIndex)`）。
 */
export function beginDirectionBatch(scriptId: string | undefined): number {
    const state = loadStoryDirectionState(scriptId);
    const next = (typeof state.batchIndex === "number" ? state.batchIndex : -1) + 1;
    if (scriptId) saveStoryDirectionState(scriptId, { ...state, batchIndex: next });
    return next;
}

/* ─────────────────────────── 抽类型 ─────────────────────────── */

function pickWeighted(pool: DirectionType[]): DirectionType {
    const total = pool.reduce((sum, t) => sum + DIRECTION_WEIGHTS[t], 0);
    let r = Math.random() * total;
    for (const t of pool) {
        r -= DIRECTION_WEIGHTS[t];
        if (r <= 0) return t;
    }
    return pool[pool.length - 1];
}

/**
 * 抽本批两个类型（必不相同）。
 *
 * 2026-11-24 起改为**按组轮换**（`batchIndex % 3`），不再纯随机：
 * 换一批＝下一组，连着几批不会是同一种味道。组内仍是硬约束「两个类型不同」；
 * 与「最近用过」的重复只做**软避让** —— 上一批出现过的类型尽量换掉，换不掉就照用。
 * 兜底：最近两批都没出过角色卡 → 强制塞一张角色卡（角色卡是推进主力）。
 */
export function drawCardTypes(recent: DirectionRecentEntry[], batchIndex = 0): [DirectionType, DirectionType] {
    const plan = DIRECTION_BATCH_PLAN[Math.abs(Math.floor(batchIndex)) % DIRECTION_BATCH_PLAN.length] ?? DIRECTION_BATCH_PLAN[0];
    const lastBatchTypes = recent.slice(0, 2).map(r => r.type);

    // 软避让：本组里的类型如果刚在上一批出现过，就换成一个没出现过的
    const picked = plan.map(t => {
        if (!lastBatchTypes.includes(t)) return t;
        const spare = ALL_TYPES.find(x => !lastBatchTypes.includes(x) && !plan.includes(x));
        return spare ?? t;
    });

    // 保证两个不同
    if (picked[0] === picked[1]) {
        const spare = ALL_TYPES.find(x => x !== picked[0]);
        picked[1] = spare ?? picked[1];
    }

    // 兜底：最近两批没有角色卡 → 第一张强制角色卡
    const recentTypes = recent.slice(0, 4).map(r => r.type);
    if (recentTypes.length >= 4 && !recentTypes.includes("character") && picked[0] !== "character") {
        const second: DirectionType = picked[1] === "character" ? "environment" : picked[1];
        return ["character", second];
    }

    return [picked[0], picked[1]];
}

/** 「换这张」：换一个类型（不能与另一张重复），再重写内容 */
export function pickTypeForRedraw(otherType: DirectionType, excludeTypes: DirectionType[] = []): DirectionType {
    const pool = ALL_TYPES.filter(t => t !== otherType && !excludeTypes.includes(t));
    return pickWeighted(pool.length > 0 ? pool : ALL_TYPES.filter(t => t !== otherType));
}

/* ─────────────────────────── 上下文 ─────────────────────────── */

export interface StoryDirectionContext {
    /** 剧本标题（帮助模型理解场景） */
    scriptTitle?: string;
    /** 在场角色：名字 + 人设摘要（没有就只给名字） */
    cast: { name: string; isUser?: boolean; persona?: string }[];
    /** 最近几轮：`说话人：内容` 的纯文本行 */
    recentLines: string[];
    /** 世界书命中块（走现有激活管线，只读） */
    worldBookText?: string;
    /** 剧本归档（只读，取最近一条） */
    archiveText?: string;
    /** 剧情内时间（有就带） */
    storyTimeText?: string;
    /** 最近用过的方向（跨批去重） */
    recentDirections?: DirectionRecentEntry[];
}

/**
 * 从剧本 + 回合快速拼上下文（调用方给 script 与 turns 即可）。
 * 这里只做「取必要量」，不做名额分配。
 */
export function buildDirectionContext(args: {
    scriptTitle?: string;
    cast: { name: string; isUser?: boolean; persona?: string }[];
    turns: { senderName?: string; senderType?: string; content: string }[];
    worldBookText?: string;
    archives?: { content?: string }[];
    timeAwareness?: Parameters<typeof resolveStoryTime>[0];
    recentDirections?: DirectionRecentEntry[];
    recentLimit?: number;
}): StoryDirectionContext {
    const limit = args.recentLimit ?? 14;
    const recentLines = args.turns
        .slice(-limit)
        .map(t => `${t.senderType === "user" ? "用户" : (t.senderName || "旁白")}：${(t.content || "").replace(/\s+/g, " ").slice(0, 200)}`)
        .filter(line => line.trim().length > 3);

    // 归档只读：只取最近一条有内容的
    const lastArchive = [...(args.archives ?? [])].reverse().find(a => String(a.content || "").trim());
    const archiveText = lastArchive ? buildArchiveBlock([lastArchive as never]) : "";

    const resolvedTime = args.timeAwareness ? resolveStoryTime(args.timeAwareness) : null;

    return {
        scriptTitle: args.scriptTitle,
        cast: args.cast,
        recentLines,
        worldBookText: args.worldBookText || "",
        archiveText: archiveText || "",
        storyTimeText: resolvedTime ? `${resolvedTime.dateCn} ${resolvedTime.time24}${resolvedTime.anchorLabel ? `（${resolvedTime.anchorLabel}）` : ""}` : "",
        recentDirections: args.recentDirections ?? [],
    };
}

/** 世界书：只读激活（ledger 用一次性的空表，避免污染主流程的 sticky 状态） */
export function buildDirectionWorldBookText(worldBookIds: string[] | undefined, contextText: string): string {
    try {
        const books = pickBoundBooks(loadWorldBooks(), worldBookIds);
        if (books.length === 0) return "";
        const ledger: StickyLedger = new Map();
        return buildEnsembleWorldBookBlock(books, contextText, ledger).text || "";
    } catch {
        return "";
    }
}

/* ─────────────────────────── 提示词 ─────────────────────────── */

function describeType(t: DirectionType): string {
    switch (t) {
        case "character":
            return "【角色卡】由在场角色**主动发起**：他要做一件事，推动局面变化（不是「回他一句」这类被动反应）。";
        case "you":
            return "【你的卡】给用户一个**处境**：外部发生一件事，把选择/压力抛到用户面前。**绝对不能写用户怎么反应、怎么做、怎么想**。";
        case "environment":
            return "【环境卡】场景或事件本身变化，**改变在场所有人的处境**。禁止「气氛变得微妙 / 空气安静了一瞬 / 时间仿佛静止」这类零推进写法。";
        case "accident":
            return "【意外卡】打破预期，允许配角或无关联的人/事介入（比如有人按门铃、他妈打电话来、车被贴条）。同样必须改变处境。";
    }
}

export function buildStoryDirectionSystemPrompt(): string {
    return [
        "你在为一部多角色群像剧设计「下一步走向」。用户只能写自己的对白和动作，常常卡在「全靠我推」的局面；你的任务是给出**不由用户驱动**的两个方向，供用户抽选。",
        "",
        "【硬红线】",
        "1. 任何一张卡都**不许写用户的动作、台词、心理活动**（「你」只能作为被处境波及的对象出现，不能写他的反应）。",
        "2. 不许写旁白、心理描写、气氛描写——那是别的模块负责的。",
        "3. 每张必须有真实后果：写不出「它改变了什么处境」的卡，直接换一个方向，不要硬凑。",
        "4. 不许与「最近已经用过的方向」重复或近义。",
        "4.5 如果某张卡给了「针对对象」，这张卡必须**围绕它**展开（就是这个人 / 这条线），不许换成别的人或别的事。它被挑出来是因为很久没推进了。",
        "5. 只输出结构化卡片，不写解释、不写客套、不加标题之外的任何说明文字。",
        "",
        "【必须接住现场 · 不合格率最高的一项】",
        "- 每张卡都必须**从【最近对话】的最后一条接着往下**：地点、时间、在场人物、正在做的事都不能换。不许切场景、不许跳时间、不许闪前、不许换成「换了个地方开始聊」。",
        "- 如果最后几条里有人正在说一句话 / 正在做一件事 / 刚被问了一个问题，卡要**回应它**，不要另起一摊。",
        "- 【意外卡】也只能引入**现场能合理出现的人或事**（在场者的家人/同事/来电/门铃/同一个空间的第三方），不许塞与这场戏无关的新角色、新麻烦、新剧情线。",
        "- 只能使用【在场角色】里出现的人；没列出来的人一律当不在场，不许凭印象给角色安排别的身份和关系。",
        "- 自检：读者读完卡应该觉得「对，接下来确实可能是这个」，而不是「这是从别的剧里搬来的」。",
        "",
        "【现实节奏 · 不许开挂】",
        "- **时间尺度**：一张卡 = 接下来**几分钟到一两个小时内**、在**当前这个地点**发生的事。不许出现「第二天一早」「周末」「下个月」「一周后」。",
        "- **不许跳过程**：现实中需要时间或手续的事（报名、投递、审核、面试、缴费、签约、体检、注册、录取、入职、办证、审批、立案、开业、搬家、修复关系…），卡里最多只能写到**其中的第一步**（刚发出申请 / 刚被通知要交材料 / 刚被人叫去谈），**绝不许**出现「已经预注册好了」「手续办完了」「录取通知下来了」「人已经到楼下了」这种一步到位的跳步结果。这类事的正常耗时是几天到几周，不是一轮对话。",
        "- **不许凭空给**角色新资格、新身份、新资源、新关系（突然是某研究院的研究员、突然很有钱、突然认识某个大人物）。除非【在场角色】或【最近对话】里已经出现过，否则一律当没有。",
        "- **符合常识与作息**：上课时间不会出现在酒吧、凌晨不会有人上门家访、没人半夜被一个电话就叫回公司还立刻到岗（剧本明确写了这种职业除外）。",
        "- **一张卡一件事**：不要在一张卡里塞三四件事，也不要写完事件再顺手描写结果之后的连锁反应。",
        "",
        "【字段要求】",
        "- title：≤10 字，一眼看懂「谁要做什么」。",
        "- event：一句话，**可见的行为或事件**，具体到能拍出来。",
        "- consequence：一句话，**必须改变处境**（谁被逼着做什么 / 什么被打断了 / 什么暴露了）。",
        "",
        "【输出格式】严格输出 JSON 数组，不要代码块标记，不要多余文字：",
        '[{"type":"character","title":"他先开口","event":"他放下杯子，直接问你昨天下午去哪了","consequence":"你得给个说法，否则他会起疑"},{"type":"environment","title":"客户提前到","event":"门铃响，客户比约定早半小时到了","consequence":"这场对话被迫打断，你们得先应付他"}]',
    ].join("\n");
}

/* ── 针对对象：直接锁归档里的锚点（2026-11-24） ─────────────────────────
 * 用户的想法：「归档不就是线索吗，直接锁归档里的锚点」——对，但只能做到这一步：
 * 归档是**只留最新一条的滚动摘要**，每行没有时间戳，所以没法真的算「多久没推进」；
 * 于是用**廉价代理**：把归档【关键锚点】拆成条目 → 看哪一条在最近 14 条对话里几乎没被提到
 * → 它就是「最久没被碰的线头」。挑不到就退到「最久没露面的角色」。
 * 不建台账、不改存储，纯读现成的归档文本。
 */

/** 小节标题里带这些字样的，整节都算线头来源（归档用来记「将来要发生的事」的叫法） */
const THREAD_HEADINGS = /线头|待发生|待兑现|未兑现|悬而未决|待办/;
/** 明显不是「可推进的线头」：认知范围、已完成不重播清单、已暴露的错 */
const NOT_THREAD = /知情|知道的|不知|秘密|彼此都|双方都知|不重播|已完成|已发生|已暴露|漏法|暗号|照旧|物品|人物状态/;
/** 「一捆线头」的标签，见到就按顿号拆开 */
const BUNDLE_LABEL = /^(待发生线头|待发生|待兑现|未兑现|悬而未决|线头)\s*[：:]\s*(.+)$/;

/** 去掉行首的 · • - * 数字编号，去行尾句读 */
function cleanBullet(raw: string): string {
    return raw
        .replace(/[\uFEFF\u200B]/g, "")
        .replace(/^[\s·•\-*—>]+/, "")
        .replace(/^\d+[.、)]\s*/, "")
        .trim()
        .replace(/[。；;，,]+$/, "");
}

/** 一行是不是小节标题（【xxx】 或 ═══ / ─── 包边） */
function isHeading(raw: string): boolean {
    return /【[^】]{1,24}】/.test(raw) || /^\s*[═─━=]{3,}/.test(raw);
}

/**
 * 从归档里拆出「可推进的线头」。
 *
 * 认两种写法（2026-11-24 按实机归档补）：
 *  1. 【关键锚点】块里的普通条目（承诺 / 行程约定 / 待兑现 / 关系变化）；
 *  2. 标题里带「线头 / 待发生 / 待兑现」的独立小节。
 * 块里若有一行是「· 待发生线头：A、B、C」——那是**一捆**，拆成单条才有用
 * （否则每次只能拿到半句话，模型也没法「围绕它展开」）。
 * 认知范围、「已完成不重播」、「已暴露的漏法」都不是线头，一律踢掉。
 */
export function extractArchiveThreads(archiveText: string): string[] {
    if (!archiveText) return [];
    // ── 分节：只吃「关键锚点」和标题带 THREAD_HEADINGS 的小节 ──
    const bodies: string[] = [];
    let buf: string[] = [];
    let keep = false;
    const flush = () => {
        if (keep && buf.length) bodies.push(buf.join("\n"));
        buf = [];
    };
    for (const raw of archiveText.split(/\r?\n/)) {
        if (isHeading(raw)) {
            flush();
            keep = /关键锚点/.test(raw) || THREAD_HEADINGS.test(raw);
            continue;
        }
        buf.push(raw);
    }
    flush();
    if (bodies.length === 0) return [];

    const seen = new Set<string>();
    const bundleItems: string[] = []; // 拆开的一捆优先当候选
    const plainItems: string[] = [];
    const push = (target: string[], item: string) => {
        const t = item.trim().replace(/[。；;，,]+$/, "");
        if (t.length < 2 || t.length > 40) return;
        if (seen.has(t)) return;
        seen.add(t);
        target.push(t);
    };
    for (const body of bodies) {
        for (const raw of body.split(/\r?\n/)) {
            const line = cleanBullet(raw);
            if (line.length < 2) continue;
            const bundle = line.match(BUNDLE_LABEL);
            if (bundle) {
                // 只按顿号/分号拆：「（她主张14号／他主张13号）」里的斜杠是"或"，不能拆
                for (const part of bundle[2].split(/[、；;]/)) push(bundleItems, part);
                continue;
            }
            if (line.length > 120) continue;
            if (NOT_THREAD.test(line)) continue;
            push(plainItems, line.length > 40 ? `${line.slice(0, 39)}…` : line);
        }
    }
    return [...bundleItems, ...plainItems].slice(0, 12);
}

/** 二元组命中率：这段文字里有多少相邻两字在最近对话里出现过（越低＝越久没碰） */
function mentionScore(text: string, recentText: string): number {
    const clean = text.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "");
    if (clean.length < 4) return 0;
    let hit = 0;
    let total = 0;
    for (let i = 0; i < clean.length - 1; i++) {
        total++;
        if (recentText.includes(clean.slice(i, i + 2))) hit++;
    }
    return total === 0 ? 0 : hit / total;
}

/** 挑「最近最没被提到」的线头；归档里拆不出来就返回 null */
export function pickStaleThread(archiveText: string, recentLines: string[]): string | null {
    const threads = extractArchiveThreads(archiveText);
    if (threads.length === 0) return null;
    const recentText = recentLines.join("\n");
    let best: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const t of threads) {
        const score = mentionScore(t, recentText);
        if (score < bestScore) {
            bestScore = score;
            best = t;
        }
    }
    // 太长的不适合当"针对对象"，截断到 40 字以内
    return best ? (best.length > 40 ? `${best.slice(0, 40)}…` : best) : null;
}

/** 兜底：在场角色里最近最少被提到的那个（归档拆不出线头时用） */
function pickLeastMentionedCast(ctx: StoryDirectionContext): string | null {
    const recentText = ctx.recentLines.join("\n");
    const candidates = ctx.cast.filter(c => !c.isUser).map(c => c.name).filter(Boolean);
    if (candidates.length === 0) return null;
    let best: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const name of candidates) {
        const score = recentText.split(name).length - 1;
        if (score < bestScore) {
            bestScore = score;
            best = name;
        }
    }
    return best;
}

/**
 * 给这一批每张卡分配「针对对象」：
 * - 角色卡 / 你的卡 → 最久没被碰的线头（归档里锁），没有就退到最久没露面的角色
 * - 环境卡 / 意外卡 → 不绑（它们本来就是"场在变"，硬绑对象会变形）
 */
export function pickDirectionTargets(ctx: StoryDirectionContext, types: DirectionType[]): (string | undefined)[] {
    const stale = pickStaleThread(ctx.archiveText || "", ctx.recentLines);
    const castName = pickLeastMentionedCast(ctx);
    return types.map(t => {
        if (t === "character") return stale || castName || undefined;
        if (t === "you") return stale || undefined;
        return undefined;
    });
}

export function buildStoryDirectionUserPrompt(ctx: StoryDirectionContext, types: DirectionType[]): string {
    const blocks: string[] = [];

    if (ctx.scriptTitle) blocks.push(`【剧本】${ctx.scriptTitle}`);
    if (ctx.storyTimeText) blocks.push(`【剧情内时间】${ctx.storyTimeText}（两张卡都发生在接下来的几十分钟内，不许跳时间）`);

    if (ctx.cast.length > 0) {
        const castLines = ctx.cast.map(c => {
            const persona = (c.persona || "").replace(/\s+/g, " ").slice(0, 260);
            return `- ${c.name}${c.isUser ? "（用户本人）" : ""}${persona ? `：${persona}` : ""}`;
        });
        blocks.push(`【在场角色】（只有这些人存在，别的人一律不在场）\n${castLines.join("\n")}`);
    }

    if (ctx.worldBookText) blocks.push(ctx.worldBookText.trim());
    if (ctx.archiveText) blocks.push(ctx.archiveText.trim());
    if (ctx.recentLines.length > 0) {
        const lines = ctx.recentLines.map((line, i) =>
            i === ctx.recentLines.length - 1 ? `${line}\n└ 上面这条就是**现在**：两张卡都必须紧接着它发生（同一个地点、同一个人、同一件正在做的事）` : line
        );
        blocks.push(`【最近对话（从旧到新，最后一条 = 当前现场）】\n${lines.join("\n")}`);
    }

    const recent = (ctx.recentDirections ?? []).slice(0, RECENT_MAX);
    if (recent.length > 0) {
        blocks.push(
            `【最近已经用过的方向 · 禁止重复或近义】\n${recent
                .map(r => `- ${DIRECTION_TYPE_LABEL[r.type]}：${r.title}（${r.gist}）`)
                .join("\n")}`
        );
    }

    const targets = pickDirectionTargets(ctx, types);
    blocks.push(
        `【本次要写】\n${types
            .map((t, i) => `- ${describeType(t)}${targets[i] ? `\n  针对对象：${targets[i]}\n  （这张卡必须围绕它展开，不许换成别的人/别的事；它已经很久没被推进了）` : ""}`)
            .join("\n")}\n\n` +
        `按上面顺序输出 ${types.length} 张卡，type 字段分别用：${types.map(t => `"${t}"`).join("、")}。`
    );

    return blocks.join("\n\n");
}

/* ─────────────────────────── 生成与解析 ─────────────────────────── */

function makeId(): string {
    return `dir_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeType(raw: unknown): DirectionType | null {
    const s = String(raw ?? "").trim().toLowerCase();
    if (!s) return null;
    if (ALL_TYPES.includes(s as DirectionType)) return s as DirectionType;
    if (s.includes("角色") || s.includes("character")) return "character";
    if (s.includes("你") || s.includes("user") || s.includes("you")) return "you";
    if (s.includes("环境") || s.includes("场景") || s.includes("environment")) return "environment";
    if (s.includes("意外") || s.includes("突发") || s.includes("accident")) return "accident";
    return null;
}

function cleanText(v: unknown, max = 90): string {
    return String(v ?? "").replace(/\s+/g, " ").replace(/^["'「『]|["'」』]$/g, "").trim().slice(0, max);
}

/** 宽松解析：先当 JSON，再退回逐段正则（模型偶尔会加代码块或多余说明） */
export function parseStoryDirectionCards(text: string): StoryDirection[] {
    const raw = String(text || "").trim();
    if (!raw) return [];

    const tryPush = (out: StoryDirection[], item: Record<string, unknown>) => {
        const type = normalizeType(item.type ?? item.kind ?? item.category);
        const title = cleanText(item.title ?? item.name ?? item.head, 20);
        const event = cleanText(item.event ?? item.what ?? item.happens ?? item.action ?? item.content);
        const consequence = cleanText(item.consequence ?? item.result ?? item.effect ?? item.aftermath);
        if (!type || !title || !event || !consequence) return;
        out.push({ id: makeId(), type, title, event, consequence });
    };

    // ① JSON
    const jsonText = raw.replace(/^```(?:json)?/i, "").replace(/```$/g, "").trim();
    const start = jsonText.indexOf("[");
    const end = jsonText.lastIndexOf("]");
    if (start >= 0 && end > start) {
        try {
            const parsed = JSON.parse(jsonText.slice(start, end + 1));
            if (Array.isArray(parsed)) {
                const out: StoryDirection[] = [];
                for (const item of parsed) {
                    if (item && typeof item === "object") tryPush(out, item as Record<string, unknown>);
                }
                if (out.length > 0) return out;
            }
        } catch { /* 退回正则 */ }
    }
    // ② 单个对象
    try {
        const obj = JSON.parse(jsonText);
        if (obj && typeof obj === "object") {
            const out: StoryDirection[] = [];
            tryPush(out, obj as Record<string, unknown>);
            if (out.length > 0) return out;
        }
    } catch { /* ignore */ }

    // ③ 逐段正则：类型行 + 标题/发生/后果 三行
    const out: StoryDirection[] = [];
    const chunks = raw.split(/\n(?=\s*(?:[-*]\s*)?(?:【)?(?:角色卡|你的卡|环境卡|意外卡|character|you|environment|accident))/i);
    for (const chunk of chunks) {
        const type = normalizeType(chunk.match(/(角色卡|你的卡|环境卡|意外卡|character|you|environment|accident)/i)?.[1]);
        if (!type) continue;
        const pick = (re: RegExp) => cleanText(chunk.match(re)?.[1] ?? "");
        const title = pick(/标题\s*[:：]\s*(.+)/) || pick(/^\s*(?:[-*]\s*)?【?[^】\n]{0,6}】?[^\n]*?标题?[:：]?\s*(.+)$/m);
        const event = pick(/(?:会发生什么|会发生|发生)\s*[:：]\s*(.+)/);
        const consequence = pick(/后果\s*[:：]\s*(.+)/);
        if (!title || !event || !consequence) continue;
        out.push({ id: makeId(), type, title: title.slice(0, 20), event, consequence });
    }
    return out;
}

export interface GenerateResult {
    cards: StoryDirection[];
    error?: string;
}

/**
 * 生成一批卡（默认两张、类型不同）。走副 API「下一步走向」，未配置回退全局默认。
 * 不写任何剧本/归档/记忆字段 —— 调用方只拿返回值。
 */
export async function generateStoryDirectionCards(
    ctx: StoryDirectionContext,
    options?: { types?: DirectionType[]; temperature?: number }
): Promise<GenerateResult> {
    const apiConfig = resolveAuxiliaryApiConfig("storyDirectionApiConfigId");
    if (!apiConfig) return { cards: [], error: "没有可用的 API，请到「配置绑定 → AUXILIARY API」设置" };

    const types = options?.types && options.types.length > 0 ? options.types : drawCardTypes(ctx.recentDirections ?? []);

    try {
        const result = await simpleLLMCall(
            apiConfig,
            [
                { role: "system", content: buildStoryDirectionSystemPrompt() },
                { role: "user", content: buildStoryDirectionUserPrompt(ctx, types) },
            ],
            { temperature: options?.temperature ?? 0.85 }
        );
        const content = (result.content || "").trim();
        if (!content) return { cards: [], error: result.error || "模型没有返回内容" };

        let cards = parseStoryDirectionCards(content);
        // 只保留本次要求的类型，且类型不得重复；不足就按需补位
        const seen = new Set<DirectionType>();
        cards = cards.filter(c => {
            if (!types.includes(c.type) || seen.has(c.type)) return false;
            seen.add(c.type);
            return true;
        });
        if (cards.length === 0) return { cards: [], error: "这次没抽出可用的卡，再试一次吧" };
        const kept = cards.slice(0, types.length);
        // 针对对象：把这一批挑好的线头/角色贴回卡片（模型没写时报给它看）
        const targets = pickDirectionTargets(ctx, kept.map(c => c.type));
        kept.forEach((card, i) => {
            if (!card.target && targets[i]) card.target = targets[i];
        });
        return { cards: kept };
    } catch (err) {
        return { cards: [], error: err instanceof Error ? err.message : "生成失败，再试一次吧" };
    }
}

/** 采纳后注入主聊的指令（只提供方向，不替用户写戏） */
export function buildDirectionDirective(direction: StoryDirection | null | undefined): string {
    if (!direction) return "";
    return [
        "【本轮走向】",
        `类型：${DIRECTION_TYPE_LABEL[direction.type]}；发生：${direction.event}；后果：${direction.consequence}。`,
        ...(direction.target ? [`针对：${direction.target}（这一轮就是这条线在动）`] : []),
        "只把它演出来，不要解释这个安排，不要复述用户已写过的内容。",
        "用户输入管「我做了什么」，这段走向管「他那一边发生了什么」，两者并列发生。",
    ].join("\n");
}
