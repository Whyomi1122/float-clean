// lib/case-engine/storage.ts
// 案件 App 的本地存储。全部走 kv-db（IndexedDB），键名严格按方案：
//   caseSession:<ensembleScriptId>:<caseId>:<identity>
//   case-app:bound-script
// 两条边界（已与群像侧对齐）：案件侧只写以上两类键；删剧本/删番外都不清 caseSession，
// 孤儿 key 由这边读取时判定为「剧本已删除」并提供手动清空。

import { kvGet, kvKeysWithPrefix, kvRemove, kvSet } from "../kv-db";
import type { CaseBoundScript, CaseIdentity, CaseSession } from "./types";

const BOUND_KEY = "case-app:bound-script";
const SESSION_PREFIX = "caseSession:";

export function caseSessionKey(
    ensembleScriptId: string,
    caseId: string,
    identity: CaseIdentity,
): string {
    return `${SESSION_PREFIX}${ensembleScriptId}:${caseId}:${identity}`;
}

// ── 绑定的剧本（全局设置页选一次；默认空＝全站无入口、无注入） ──
export function getBoundScript(): CaseBoundScript | null {
    const raw = kvGet(BOUND_KEY);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<CaseBoundScript>;
        if (!parsed || typeof parsed.id !== "string" || !parsed.id) return null;
        return { id: parsed.id, title: typeof parsed.title === "string" ? parsed.title : "" };
    } catch {
        return null;
    }
}

export function setBoundScript(script: CaseBoundScript): void {
    kvSet(BOUND_KEY, JSON.stringify({ id: script.id, title: script.title || "" }));
}

export function clearBoundScript(): void {
    kvRemove(BOUND_KEY);
}

/** 白名单＝绑定值；比对只认 id */
export function isCaseEnabledFor(ensembleScriptId: string | null | undefined): boolean {
    if (!ensembleScriptId) return false;
    const bound = getBoundScript();
    return !!bound && bound.id === ensembleScriptId;
}

// ── 案件局（一人一台手机＝三人各一份账本） ──
function normalize(raw: unknown): CaseSession | null {
    if (!raw || typeof raw !== "object") return null;
    const s = raw as Partial<CaseSession>;
    if (!s.id || !s.ensembleScriptId || !s.caseId || !s.identity) return null;
    return {
        id: s.id,
        ensembleScriptId: s.ensembleScriptId,
        caseId: s.caseId,
        identity: s.identity,
        actId: s.actId ?? "trial",
        status: s.status ?? "active",
        access: s.access && typeof s.access === "object" ? s.access : {},
        checkedIds: Array.isArray(s.checkedIds) ? s.checkedIds : [],
        minutesLeft: typeof s.minutesLeft === "number" ? s.minutesLeft : null,
        observations: Array.isArray(s.observations) ? s.observations : [],
        comms: Array.isArray(s.comms) ? s.comms : [],
        drafts: Array.isArray(s.drafts) ? s.drafts : [],
        traces: Array.isArray(s.traces) ? s.traces : [],
        risk: typeof s.risk === "number" ? s.risk : 0,
        todosDone: Array.isArray(s.todosDone) ? s.todosDone : [],
        submitted: !!s.submitted,
        endingId: s.endingId ?? null,
        createdAt: typeof s.createdAt === "number" ? s.createdAt : 0,
        updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : 0,
    };
}

export function loadCaseSession(
    ensembleScriptId: string,
    caseId: string,
    identity: CaseIdentity,
): CaseSession | null {
    const raw = kvGet(caseSessionKey(ensembleScriptId, caseId, identity));
    if (!raw) return null;
    try {
        return normalize(JSON.parse(raw));
    } catch {
        return null;
    }
}

export function saveCaseSession(session: CaseSession): void {
    kvSet(caseSessionKey(session.ensembleScriptId, session.caseId, session.identity), JSON.stringify(session));
}

export function clearCaseSession(
    ensembleScriptId: string,
    caseId: string,
    identity: CaseIdentity,
): void {
    kvRemove(caseSessionKey(ensembleScriptId, caseId, identity));
}

/** 该剧本下所有案件局（不分身份）——注入与「有没有未结案件」都靠它 */
export function listCaseSessionsForScript(ensembleScriptId: string): CaseSession[] {
    const prefix = `${SESSION_PREFIX}${ensembleScriptId}:`;
    const out: CaseSession[] = [];
    for (const key of kvKeysWithPrefix(prefix)) {
        const raw = kvGet(key);
        if (!raw) continue;
        try {
            const s = normalize(JSON.parse(raw));
            if (s) out.push(s);
        } catch {
            // 坏数据当作不存在，不删（留给用户手动清）
        }
    }
    return out;
}

/** 清掉「剧本已不存在」的孤儿存档；返回清掉的条数。由面板的「清空本案存档」按钮调用。 */
export function clearOrphanSessions(existingScriptIds: string[]): number {
    const alive = new Set(existingScriptIds);
    let removed = 0;
    for (const key of kvKeysWithPrefix(SESSION_PREFIX)) {
        const parts = key.slice(SESSION_PREFIX.length).split(":");
        const scriptId = parts[0];
        if (!scriptId || !alive.has(scriptId)) {
            kvRemove(key);
            removed += 1;
        }
    }
    return removed;
}