// lib/case-engine/engine.ts
// 案件 App 的引擎：纯函数，不碰存储、不调 AI、不碰界面。
// 铁律：AI 不许新增证据、不许改材料正文；真相绝不进注入；台词归剧情 AI。

import type {
    CaseAccess,
    CaseEvidence,
    CaseIdentity,
    CasePackage,
    CaseSession,
} from "./types";

export interface CaseResult<T = undefined> {
    ok: boolean;
    reason?: string;
    session: CaseSession;
    value?: T;
}

const OBS_MAX = 60;

export function findEvidence(pkg: CasePackage, evidenceId: string): CaseEvidence | undefined {
    return pkg.evidence.find((e) => e.id === evidenceId);
}

export function accessOf(session: CaseSession, evidenceId: string): CaseAccess {
    return session.access[evidenceId] ?? "locked";
}

/** 已授权 / 非常规获得 都能看；待授权与锁死不能 */
export function canRead(access: CaseAccess): boolean {
    return access === "granted" || access === "obtained";
}

function touch(session: CaseSession, now: number): CaseSession {
    return { ...session, updatedAt: now };
}

function spend(session: CaseSession, minutes: number | undefined): CaseSession {
    if (!minutes || session.minutesLeft === null) return session;
    return { ...session, minutesLeft: Math.max(0, session.minutesLeft - minutes) };
}

/** 开案：按案件包给初始权限，按本幕给剩余分钟 */
export function createSession(
    pkg: CasePackage,
    ensembleScriptId: string,
    identity: CaseIdentity,
    now: number = Date.now(),
): CaseSession {
    const act = pkg.acts.find((a) => a.playableIdentities.includes(identity)) ?? pkg.acts[pkg.acts.length - 1];
    const access: Record<string, CaseAccess> = {};
    for (const e of pkg.evidence) access[e.id] = e.initialAccess[identity] ?? "locked";
    return {
        id: `case-${now}-${identity}`,
        ensembleScriptId,
        caseId: pkg.id,
        identity,
        actId: act?.id ?? "trial",
        status: "active",
        access,
        checkedIds: [],
        minutesLeft: typeof act?.timeBudgetMin === "number" ? act.timeBudgetMin : null,
        observations: [],
        comms: [],
        drafts: [],
        traces: [],
        risk: 0,
        todosDone: [],
        submitted: false,
        endingId: null,
        createdAt: now,
        updatedAt: now,
    };
}

/** 核一次（零 AI，扣分钟，结果来自案件包） */
export function checkEvidence(
    pkg: CasePackage,
    session: CaseSession,
    evidenceId: string,
    now: number = Date.now(),
): CaseResult<string> {
    const ev = findEvidence(pkg, evidenceId);
    if (!ev) return { ok: false, reason: "材料不存在", session };
    if (!canRead(accessOf(session, evidenceId))) return { ok: false, reason: "没有这份材料的权限", session };
    if (!ev.check) return { ok: false, reason: "这份材料没有可核的东西", session };
    if (session.checkedIds.includes(evidenceId)) {
        return { ok: true, session, value: ev.check.result };
    }
    let next = { ...session, checkedIds: [...session.checkedIds, evidenceId] };
    next = spend(next, ev.check.minutes);
    return { ok: true, session: touch(next, now), value: ev.check.result };
}

/** 求：只生成一份「可改的草稿」，不发送、不扣分钟（发送由玩家自己点） */
export function requestEvidence(
    pkg: CasePackage,
    session: CaseSession,
    evidenceId: string,
    now: number = Date.now(),
): CaseResult<string> {
    const ev = findEvidence(pkg, evidenceId);
    if (!ev?.ask) return { ok: false, reason: "这份材料不能求", session };
    const draft = { evidenceId, text: ev.ask.draft, at: now, sent: false };
    const exists = session.drafts.some((d) => d.evidenceId === evidenceId && !d.sent);
    if (exists) return { ok: true, session, value: ev.ask.draft };
    return { ok: true, session: touch({ ...session, drafts: [...session.drafts, draft] }, now), value: ev.ask.draft };
}

export function updateDraft(
    session: CaseSession,
    evidenceId: string,
    text: string,
    now: number = Date.now(),
): CaseResult {
    const idx = session.drafts.findIndex((d) => d.evidenceId === evidenceId && !d.sent);
    if (idx < 0) return { ok: false, reason: "没有这份草稿", session };
    const drafts = session.drafts.map((d, i) => (i === idx ? { ...d, text } : d));
    return { ok: true, session: touch({ ...session, drafts }, now) };
}

/** 发送＝草稿进聊天室输入框；App 本身不对外发任何消息，这里只登记「已发」 */
export function markDraftSent(
    session: CaseSession,
    evidenceId: string,
    now: number = Date.now(),
): CaseResult<string> {
    const idx = session.drafts.findIndex((d) => d.evidenceId === evidenceId && !d.sent);
    if (idx < 0) return { ok: false, reason: "没有这份草稿", session };
    const target = session.drafts[idx];
    const text = target.text.trim();
    if (!text) return { ok: false, reason: "草稿是空的", session };
    const drafts = session.drafts.map((d, i) => (i === idx ? { ...d, sent: true } : d));
    const comms = [...session.comms, { from: session.identity, text, at: now, source: "delivery" as const }];
    const access = { ...session.access };
    if (access[evidenceId] === "locked") access[evidenceId] = "pending";
    return {
        ok: true,
        session: touch({ ...session, drafts, comms, access }, now),
        value: text,
    };
}

/** 剧情把材料递到手（由面板的「拿到」或剧情投递触发） */
export function receiveEvidence(
    session: CaseSession,
    evidenceId: string,
    now: number = Date.now(),
    unusual = false,
): CaseResult {
    const access = { ...session.access, [evidenceId]: unusual ? ("obtained" as CaseAccess) : ("granted" as CaseAccess) };
    const traces = unusual
        ? [...session.traces, { text: `非常规获得：${evidenceId}`, at: now, risk: 3 }]
        : session.traces;
    const risk = unusual ? session.risk + 3 : session.risk;
    return { ok: true, session: touch({ ...session, access, traces, risk }, now) };
}

/** 记：写一条观察（≤60 字），可挂材料；扣剧情分钟 */
export function recordObservation(
    session: CaseSession,
    text: string,
    evidenceId?: string,
    minutes?: number,
    now: number = Date.now(),
): CaseResult<string> {
    const clean = text.replace(/\s+/g, " ").trim().slice(0, OBS_MAX);
    if (!clean) return { ok: false, reason: "记的内容是空的", session };
    let next = {
        ...session,
        observations: [...session.observations, { evidenceId, text: clean, at: now, minutes }],
    };
    next = spend(next, minutes);
    return { ok: true, session: touch(next, now), value: clean };
}

/** 越界：案件与生活同一本账（痕迹 + 曝光 + 风险值） */
export function addTrace(
    session: CaseSession,
    text: string,
    risk = 1,
    now: number = Date.now(),
): CaseResult {
    const traces = [...session.traces, { text, at: now, risk }];
    return { ok: true, session: touch({ ...session, traces, risk: session.risk + risk }, now) };
}

/** 待办四格：看 → 求 → 核 → 记（按依赖排序，数字在左） */
export function computeTodos(
    pkg: CasePackage,
    session: CaseSession,
): { id: string; label: string; done: boolean }[] {
    const hasChecked = session.checkedIds.length > 0;
    const hasDraft = session.drafts.length > 0;
    const hasObs = session.observations.length > 0;
    const flags: Record<string, boolean> = {
        看: hasChecked || hasObs || session.todosDone.includes("看"),
        求: hasDraft,
        核: hasChecked,
        记: hasObs,
    };
    return pkg.openingTodos.map((label) => ({ id: label, label, done: flags[label] ?? false }));
}

/** 判法：只算结局 id，不写台词 */
export function computeEnding(pkg: CasePackage, session: CaseSession): string {
    const checked = new Set(session.checkedIds);
    const readable = (id: string) => canRead(accessOf(session, id));
    const semanticCovered = pkg.evidence.filter(
        (e) => e.pointsTo.includes("semantics") && readable(e.id) && checked.has(e.id),
    ).length;

    const citesRedHerring = session.observations.some((o) => {
        const ev = o.evidenceId ? findEvidence(pkg, o.evidenceId) : undefined;
        return !!ev?.redHerring;
    });

    // 引用了断链（前科、目击证言之类），语义层又没立起来 → 打回
    if (citesRedHerring && semanticCovered === 0) return "rejected";
    if (checked.has("E-03") && checked.has("E-06") && semanticCovered >= 2) return "filed";
    if (session.observations.length > 0 || session.comms.length > 0) return "noted";
    return "rejected";
}

/** 交材料（结算）：算出结局，写入 session */
export function submitCase(
    pkg: CasePackage,
    session: CaseSession,
    now: number = Date.now(),
): CaseResult<{ endingId: string; text: string }> {
    const endingId = computeEnding(pkg, session);
    const ending = pkg.endings.find((e) => e.id === endingId);
    const status = endingId === "rejected" ? "void" : "active";
    return {
        ok: true,
        session: touch(
            { ...session, submitted: true, endingId, status: endingId === "filed" ? "filed" : endingId === "noted" ? "noted" : status },
            now,
        ),
        value: { endingId, text: ending?.text ?? "" },
    };
}