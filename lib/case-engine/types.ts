// lib/case-engine/types.ts
// 案件 App 的数据契约（方案见《09 · 现行方案》§八）。
// 只放类型，不放实现；加案子只加一个 cases/<id>.ts，不改这里。

/** 三个自机身份（一人一台手机＝三人各一份账本） */
export type CaseIdentity = "wolinyu" | "pi" | "kim";

export type CaseActId = "investigate" | "prosecute" | "trial";

/** 证据权限：已授权 / 待授权 / 非常规获得（偷窥、私下拿）/ 锁死 */
export type CaseAccess = "granted" | "pending" | "obtained" | "locked";

/** 争点所属层：现场 / 程序 / 语义 */
export type CaseLayer = "scene" | "procedure" | "semantics";

export interface CaseEvidenceCheck {
    /** 按钮上显示的动词，如「对帧」 */
    label: string;
    /** 核一次扣多少分钟（缺省＝不扣） */
    minutes?: number;
    /** 核出来的结果（零 AI，纯文本） */
    result: string;
}

export interface CaseEvidenceAsk {
    /** 向谁求 */
    to: CaseIdentity | "court";
    /** 草的底稿（玩家可改，再发） */
    draft: string;
}

export interface CaseEvidence {
    id: string;
    name: string;
    /** 页眉上的节选标记，如「节选 · 2027고합0147 · 3/7 页起」 */
    sectionMark?: string;
    /** 材料正文节选（60~200 字，AI 不许改） */
    desc: string;
    /** 指向哪一层争点（可多层） */
    pointsTo: CaseLayer[];
    /** 按身份给初始权限；没写＝locked */
    initialAccess: Partial<Record<CaseIdentity, CaseAccess>>;
    /** 假线索：不指向任何争点，用来把人带偏 */
    redHerring?: boolean;
    check?: CaseEvidenceCheck;
    ask?: CaseEvidenceAsk;
}

export interface CaseAct {
    id: CaseActId;
    title: string;
    /** 这一幕哪些身份可玩 */
    playableIdentities: CaseIdentity[];
    /** 本幕可用的庭间时间（分钟）；不给＝本幕不计时 */
    timeBudgetMin?: number;
}

export interface CaseEnding {
    id: string;
    title: string;
    /** 判法说明（只写判法，不写台词——台词归剧情 AI） */
    text: string;
}

export interface CasePackage {
    /** 文件夹名，如 exit9_invalid_nods */
    id: string;
    title: string;
    caseNo: string;
    meta: {
        /** 剧情内时间，如 2027-04-01 21:03 */
        date: string;
        place: string;
        deliveredBy: string;
        deliveredLine: string;
    };
    /** 真相（绝不进注入） */
    truth: string;
    acts: CaseAct[];
    evidence: CaseEvidence[];
    disputes: { layer: CaseLayer; text: string }[];
    endings: CaseEnding[];
    /** 开局待办（按依赖/重要性排序） */
    openingTodos: string[];
    /** 两句话协议：只给事实骨架，台词归剧情 AI */
    protocol: { open: string; settle: string };
}

/** 玩家私下记下的一条观察（≤60 字） */
export interface CaseObservation {
    evidenceId?: string;
    text: string;
    /** 写入时的现实时间戳 */
    at: number;
    /** 记这一条扣掉的剧情分钟 */
    minutes?: number;
}

/** 通讯＝被提交进案件 App 的剧情消息（只读节选，只增不改） */
export interface CaseCommEntry {
    from: string;
    text: string;
    at: number;
    source: "story" | "delivery";
}

/** 求的草稿：可以改、可以补，只有玩家点发送才会出去 */
export interface CaseDraft {
    evidenceId: string;
    text: string;
    at: number;
    sent: boolean;
}

/** 越界痕迹（案件与生活同一本账） */
export interface CaseTrace {
    text: string;
    at: number;
    risk: number;
}

export type CaseSessionStatus = "active" | "filed" | "noted" | "void";

export interface CaseSession {
    id: string;
    ensembleScriptId: string;
    caseId: string;
    identity: CaseIdentity;
    actId: CaseActId;
    status: CaseSessionStatus;
    /** evidenceId → 权限 */
    access: Record<string, CaseAccess>;
    checkedIds: string[];
    /** 剩余庭间分钟；null＝本幕不计时 */
    minutesLeft: number | null;
    observations: CaseObservation[];
    comms: CaseCommEntry[];
    drafts: CaseDraft[];
    traces: CaseTrace[];
    risk: number;
    todosDone: string[];
    submitted: boolean;
    endingId: string | null;
    createdAt: number;
    updatedAt: number;
}

/** 案件 App 绑定的剧本（全局设置页里选一次） */
export interface CaseBoundScript {
    id: string;
    title: string;
}