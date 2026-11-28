// 剧情 → App 的单向投递：玩家求过的材料，剧情里真的递到手上才解锁。
//
// 三条口径，改之前先读：
// 1. 只有「求过且已发出」（draft.sent === true）的材料会被剧情解锁 —— 没求的永远不动，
//    所以 E-03 / E-06 不开口要就永远拿不到。
// 2. 只认草稿发出之后的那几条剧情回合；一句里必须同时出现材料名和一个"递"的动词，
//    带否定词（不能 / 不行 / 暂时 …）的一律当没给。
// 3. 纯函数，不碰存储、不调 AI。落盘与刷新由调用方负责。

import { accessOf, canRead, receiveEvidence } from "./engine";
import type { CaseEvidence, CasePackage, CaseSession } from "./types";

/** 材料名之外的叫法；剧情里更常用这些短词 */
function aliasesOf(ev: CaseEvidence): string[] {
    const list = (ev.aliases ?? []).filter(Boolean);
    if (list.length > 0) return list;
    return [ev.name.replace(/（[^）]*）/g, "").replace(/\([^)]*\)/g, "").trim()].filter(Boolean);
}

/** 表示"这份东西给你了"的动词 */
const DELIVER_VERB = /(给|递|调|传|发|送|拿|放|转|寄|交|批|同意|收到|到手|这份|一份|翻出|调出|递出|扣下)/;

/** 表示"没给"的词：出现就不解锁 */
const REFUSAL = /(不能|不行|没办法|暂[时且]|等[一几]?[天阵会]|驳回|不批|不批准|抱歉|不方便|再说|回头|以后|不给|没拿到|拿不到|要看|再说吧)/;

/** 承接上一句的指代（"这份""那个"） */
const REFER = /(这份|那一份|那份|这个|那个|一份)/;

const SENT_SPLIT = /[。！？!?\n]+/;

/** 去掉句首的「名字：」说话人前缀 */
function stripSpeaker(line: string): string {
    return line.replace(/^[\u4e00-\u9fa5]{2,4}[：:]\s*/, "").trim();
}

function toMs(ts: string | undefined): number {
    if (!ts) return 0;
    const t = Date.parse(ts);
    return Number.isFinite(t) ? t : 0;
}

export interface StoryDelivery {
    evidenceId: string;
    name: string;
    /** 剧情里那句话（元数据来源，只用于提示与通讯） */
    line: string;
    /** 谁递的：wolinyu / pi / kim / court，界面自己映射成名字 */
    from: string;
}

export interface StorySyncResult {
    session: CaseSession;
    deliveries: StoryDelivery[];
}

/**
 * 扫一遍剧情回合，把已求过的材料按剧情投递解锁。
 * @param turns 剧本的对话回合（只需要 content + timestamp）
 */
export function syncStoryDeliveries(
    pkg: CasePackage,
    session: CaseSession,
    turns: { content: string; timestamp?: string }[],
    now: number = Date.now(),
): StorySyncResult {
    const asked = session.drafts.filter((d) => d.sent);
    if (asked.length === 0 || turns.length === 0) return { session, deliveries: [] };

    let next = session;
    const deliveries: StoryDelivery[] = [];

    for (const draft of asked) {
        const ev = pkg.evidence.find((e) => e.id === draft.evidenceId);
        if (!ev) continue;
        if (canRead(accessOf(next, ev.id))) continue;

        const aliases = aliasesOf(ev);
        if (aliases.length === 0) continue;

        // 只看草稿发出之后的回合
        const later = turns.filter((t) => toMs(t.timestamp) > draft.at);
        let line = "";

        for (const turn of later) {
            const sentences = String(turn.content ?? "")
                .split(SENT_SPLIT)
                .map((s) => s.trim())
                .filter(Boolean);
            let aliasSeen = false;
            for (const raw of sentences) {
                const sentence = stripSpeaker(raw);
                if (!sentence) continue;
                const hasAlias = aliases.some((a) => sentence.includes(a));
                if (hasAlias) aliasSeen = true;
                if (REFUSAL.test(sentence)) continue;
                if (!hasAlias && !(aliasSeen && REFER.test(sentence))) continue;
                if (!DELIVER_VERB.test(sentence)) continue;
                line = sentence;
                break;
            }
            if (line) break;
        }

        if (!line) continue;

        const granted = receiveEvidence(next, ev.id, now);
        next = {
            ...granted.session,
            comms: [
                ...granted.session.comms,
                { from: ev.ask?.to ?? "court", text: line.slice(0, 80), at: now, source: "story" as const },
            ],
        };
        deliveries.push({ evidenceId: ev.id, name: ev.name, line: line.slice(0, 80), from: ev.ask?.to ?? "court" });
    }

    return { session: next, deliveries };
}
