// lib/case-engine/inject.ts
// 注入块（方案 §八 4 + 与主窗口对齐的 Q1/Q2/Q3）：
//   命中条件 = 剧本 id 等于绑定值 && 该剧本有未结案件；
//   每轮注入、与「现在轮到谁」无关；结案后返回空串；总开关可一键关。
// 铁律：真相绝不进注入；不写「岳霖玉说了什么」；不新增证据；不替玩家发声。

import { getCasePackage } from "./cases";
import { canRead, accessOf } from "./engine";
import { isCaseEnabledFor, listCaseSessionsForScript } from "./storage";
import { kvGet, kvSet } from "../kv-db";
import type { CaseSession } from "./types";

const BLOCK_CHAR_BUDGET = 600;
const INJECT_ENABLED_KEY = "case-app:inject-enabled";

/** 注入总开关（默认开）；关掉后只留面板，不再往 prompt 里塞东西 */
export function isInjectEnabled(): boolean {
    return kvGet(INJECT_ENABLED_KEY) !== "0";
}

export function setInjectEnabled(enabled: boolean): void {
    kvSet(INJECT_ENABLED_KEY, enabled ? "1" : "0");
}

function pickSession(sessions: CaseSession[]): CaseSession | null {
    if (!sessions.length) return null;
    return sessions.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

export function buildCasePromptBlock(ensembleScriptId: string | null | undefined): string {
    if (!ensembleScriptId) return "";
    if (!isInjectEnabled()) return "";
    if (!isCaseEnabledFor(ensembleScriptId)) return "";
    const sessions = listCaseSessionsForScript(ensembleScriptId).filter((s) => s.status === "active");
    const session = pickSession(sessions);
    if (!session) return "";

    const pkg = getCasePackage(session.caseId);
    if (!pkg) return "";

    const checked = pkg.evidence.filter((e) => session.checkedIds.includes(e.id));
    const names = (list: typeof pkg.evidence) => list.map((e) => `${e.id} ${e.name}`).join("、");
    const pending = pkg.evidence.filter((e) => e.ask && !canRead(accessOf(session, e.id)));
    const recent = session.observations.slice(-3);
    const act = pkg.acts.find((a) => a.id === session.actId);

    const lines: string[] = [];
    lines.push("【案件 App · 在场背景】（不是让你解说，是让你知道桌上有什么）");
    lines.push(
        `未结案件：${pkg.title}（${pkg.caseNo}）｜${act?.title ?? "庭审幕"}｜` +
            (session.minutesLeft === null ? "本幕不计时" : `剩余 ${session.minutesLeft} 分钟`),
    );
    if (checked.length) lines.push(`已核过：${names(checked)}`);
    if (recent.length) {
        lines.push(`她记下的：${recent.map((o) => o.text).join(" ／ ")}`);
    }
    if (pending.length) lines.push(`还没到手：${names(pending)}`);
    lines.push(
        "约束：① 岳霖玉是玩家，她的台词、动作、决定与心理一律不得由你书写，她的话只来自玩家输入；" +
            "② 吴世理听障，只用手语和写字板表达，不给他写引号对白；" +
            "③ 不得新增证据、不得改写材料内容、不得提前说破真相；" +
            "④ 玩家没拿到的材料，不得假设她已经看过。",
    );

    let block = lines.join("\n");
    if (block.length > BLOCK_CHAR_BUDGET) block = `${block.slice(0, BLOCK_CHAR_BUDGET - 1)}…`;
    return block;
}