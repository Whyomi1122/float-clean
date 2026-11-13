"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Sparkles, Trash2, Check, X } from "lucide-react";
import { loadChatMessages, type ChatMessage } from "@/lib/chat-storage";
import { loadMemoryEntriesByType } from "@/lib/memory-storage";
import { commitArchive, deleteArchive, updateArchiveEntry } from "@/lib/memory-service";
import { simpleLLMCall } from "@/lib/api-helpers";
import { resolveAuxiliaryApiConfig, resolveUserIdentity } from "@/lib/settings-storage";
import { buildArchiveContextPack } from "@/lib/archive-context-pack";
import { getStoryNow } from "@/lib/story-clock";
import type { MemoryEntry } from "@/lib/memory-types";

const DRAFT_STORE_PREFIX = "ai_phone_chat_archive_draft_";

function loadArchiveDraft(characterId: string): string {
    try { return localStorage.getItem(DRAFT_STORE_PREFIX + characterId) || ""; } catch { return ""; }
}
function saveArchiveDraft(characterId: string, text: string): void {
    try {
        if (text) localStorage.setItem(DRAFT_STORE_PREFIX + characterId, text);
        else localStorage.removeItem(DRAFT_STORE_PREFIX + characterId);
    } catch { /* ignore */ }
}

/** 归档提炼用的一条消息文本：语音条/图片/音乐分享的文字在 mediaData.label 里，content 常为空。 */
function messageTranscriptText(m: ChatMessage): string {
    const text = (m.content || "").trim();
    const label = (m.mediaData?.label || "").trim();
    if (m.mediaType === "audio") {
        const spoken = label || text;
        return spoken ? `[语音] ${spoken}` : "[语音]";
    }
    if (m.mediaType === "image") {
        const caption = text || label;
        return caption ? `[图片] ${caption}` : "[图片]";
    }
    // 其他富媒体（红包/转账/位置/礼物/名片/音乐分享/贴纸…）：尽量留下「发生过什么」，别整行丢掉
    if (m.mediaType || m.mediaData) {
        const media = m.mediaData as
            | { type?: string; musicTitle?: string; musicArtist?: string; musicId?: string | number; amount?: string | number; place?: string }
            | undefined;
        const kind = media?.type || "";
        // 音乐分享卡：mediaType 就是 "music_share"，歌名在 mediaData.musicTitle
        if (m.mediaType === "music_share" || kind === "music_share") {
            const title = media?.musicTitle || text || label || "";
            const artist = media?.musicArtist ? ` - ${media.musicArtist}` : "";
            return title ? `[音乐分享] ${title}${artist}` : "[音乐分享]";
        }
        const tag =
            m.mediaType === "red_packet" || kind === "red_packet" || kind === "transfer" ? "[红包]" :
                m.mediaType === "location" || kind === "location" ? "[位置]" :
                    m.mediaType === "voice_call" || kind === "voice_call" ? "[通话]" :
                        m.mediaType === "sticker" || kind === "sticker" ? "[贴纸]" :
                            m.mediaType === "gift" || kind === "gift" ? "[礼物]" :
                                m.mediaType === "contact_card" || m.mediaType === "app_card" || kind === "contact_card" || kind === "app_card" ? "[卡片]" :
                                    kind === "quote" ? "[引用]" :
                                        m.mediaType === "video" ? "[视频]" : "";
        const body = text || label;
        if (tag) return body ? `${tag} ${body}` : tag;
    }
    return text || label;
}

const WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const pad2 = (n: number) => String(n).padStart(2, "0");
const fmtClock = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const fmtDate = (d: Date) => `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;

/** 归档头行：和群像归档同一套写法（带星期与时刻）。 */
function buildArchiveHeader(now: Date): string {
    return `─────  归档 · 普通模式 · 至 ${fmtDate(now)} ${WEEKDAY_CN[now.getDay()]} ${fmtClock(now)}  ─────`;
}

/**
 * 拆旧归档：头行丢掉，正文与【关键锚点】分开。
 * 归档是「单条滚动」的：老正文必须原样保留，只有锚点整块重写。
 */
function splitArchiveDoc(text: string): { body: string; anchors: string } {
    const raw = (text || "").trim();
    if (!raw) return { body: "", anchors: "" };
    const lines = raw.split("\n");
    // 丢掉最前面的头行（───── … ─────）和紧随其后的空行
    let start = 0;
    while (start < lines.length && (lines[start].trim().startsWith("─────") || !lines[start].trim())) start += 1;
    const rest = lines.slice(start).join("\n").trim();
    const cutAt = Math.min(
        ...[rest.indexOf("【关键锚点】"), rest.indexOf("【当前锚点】")].filter(idx => idx >= 0),
    );
    if (!Number.isFinite(cutAt)) return { body: rest, anchors: "" };
    return {
        body: rest.slice(0, cutAt).trim(),
        anchors: rest.slice(cutAt).trim(),
    };
}

/** 从模型输出里拆出「本轮新增段落」和「关键锚点」两块。 */
function splitNewParts(text: string): { body: string; anchors: string } {
    let rest = (text || "").trim();
    rest = rest.replace(/^【新增段落】\s*/, "");
    const idx = rest.indexOf("【关键锚点】");
    if (idx < 0) return { body: rest.trim(), anchors: "" };
    return { body: rest.slice(0, idx).trim(), anchors: rest.slice(idx).trim() };
}

// ─────────────────────────────────────────────────────────────
// 归档硬校验：以下几条不靠模型自觉，生成后用代码查、代码改
// ─────────────────────────────────────────────────────────────

/** 正文台词引用上限（超过就是照抄记录，不是叙述） */
const QUOTE_LIMIT = 10;

/** 隔着手机聊天时不可能存在的描写；记录里真出现过的字眼不算（见 hasCueInTranscript） */
const BODY_FABRICATION_CUES = [
    "床头柜", "床沿", "耳边", "窗外", "霓虹", "睫毛", "镜片", "闷响", "指间", "喉结",
    "抬头", "低头", "转身", "放下手机", "推过来", "递过去", "屏幕转向", "飘着", "细雨", "雨声",
    "蓝光", "气息", "肩膀", "指尖", "掌心",
];

/** 锚点里不许出现：记录外的概念、聊天话题、互相的看法 */
const ANCHOR_FORBIDDEN_CUES = [
    "权限", "授权", "敏感话题", "邀约", "依赖性", "非对称", "未授权", "认为", "看法", "态度",
    "不解", "评价", "推测", "认知差异", "可能性", "情绪不稳定",
];

const ANCHOR_CATEGORIES = ["物品与状态", "认知与事实澄清", "违规隐患", "关系变化", "待兑现"];
const ANCHOR_DEFAULT = "【关键锚点】\n" + ANCHOR_CATEGORIES.map(k => `· ${k}：无变化`).join("\n");

const hasHangul = (s: string) => /[\uAC00-\uD7A3\u1100-\u11FF]/.test(s);

/** 正文引号数（「…」和 “…” 都算一处台词引用） */
function countQuoteSpans(text: string): number {
    return (text.match(/「[^」\n]{1,80}」/g) || []).length + (text.match(/“[^”\n]{1,80}”/g) || []).length;
}

export type ArchiveIssue = { detail: string };

/**
 * 代码硬校验：返回不合规清单（空数组=通过）。
 * 只查四件最要命的事：照抄记录行 / 引号超标 / 编造动作细节 / 锚点跑偏。
 */
export function auditArchivePart(body: string, anchors: string, transcript: string): ArchiveIssue[] {
    const issues: ArchiveIssue[] = [];
    const push = (detail: string) => { if (issues.length < 8) issues.push({ detail }); };

    // 1) 照抄记录行（「17:02 金成帝：…」原样搬进正文）
    const copied = body.match(/^\s*\d{1,2}:\d{2}\s+[^：:\n]{1,12}[：:]\s*\S/m);
    if (copied) push(`正文里还在照抄记录行：${copied[0].trim().slice(0, 40)}`);

    // 2) 引号超标
    const quotes = countQuoteSpans(body);
    if (quotes > QUOTE_LIMIT) {
        push(`正文有 ${quotes} 处引号（上限 ${QUOTE_LIMIT}）：只保留最能代表这一轮的几句原话，其余改成转述、不带引号`);
    }

    // 3) 隔着手机却写肢体动作 / 环境细节
    for (const sentence of body.split(/(?<=[。！？\n])/)) {
        const cues = BODY_FABRICATION_CUES.filter(cue => sentence.includes(cue) && !transcript.includes(cue));
        if (cues.length > 0) push(`这句写了记录里没有的肢体/环境（${cues.join("、")}）：${sentence.trim().slice(0, 36)}`);
    }

    // 4) 段落标题缺日期
    for (const line of body.split("\n")) {
        const m = line.match(/^【([^】]+)】\s*$/);
        if (!m) continue;
        const inner = m[1].trim();
        if (/\d{1,2}:\d{2}/.test(inner) && !/^\d{1,2}-\d{1,2}/.test(inner)) {
            push(`段落标题缺日期：${line.trim()}（要写成【MM-DD 周X HH:MM - HH:MM】）`);
        }
    }

    // 5) 「用韩语」却写中文，或同一句韩语反复括注
    for (const m of body.matchAll(/(韩语)[^「\n]{0,10}「([^」]*)」/g)) {
        if (!hasHangul(m[2])) push(`写了「用韩语」，引号里却是中文：${m[0].slice(0, 30)}`);
    }
    const annotated = [...body.matchAll(/「([^」]*[\uAC00-\uD7A3][^」]*)」（[^）\n]{1,20}）/g)].map(m => m[1]);
    const dupAnnotated = annotated.filter((q, i) => annotated.indexOf(q) !== i);
    if (dupAnnotated.length > 0) push(`韩语台词重复括注：${dupAnnotated[0].slice(0, 20)}（只在首次出现时注中文）`);

    // 6) 锚点跑偏
    for (const line of anchors.split("\n")) {
        const m = line.match(/^\s*[·•\-*]\s*(物品与状态|认知与事实澄清|违规隐患|关系变化|待兑现)\s*[：:]\s*(.*)$/);
        if (!m) continue;
        const content = m[2].trim();
        const bad = ANCHOR_FORBIDDEN_CUES.filter(c => content.includes(c));
        const fake = BODY_FABRICATION_CUES.filter(c => content.includes(c) && !transcript.includes(c));
        const badWords = [...bad, ...fake];
        if (badWords.length > 0) {
            push(`锚点「${m[1]}」写了${badWords.join("、")}——这不是本轮的状态或约定，删掉后写真实状态，没有就写「无变化」`);
        }
    }
    return issues;
}

/** 段落标题补日期：模型常只写【16:57 - 17:18】，日期取记录里的日期分隔行 */
function fixParagraphHeaders(body: string, transcript: string, now: Date): string {
    const sep = transcript.match(/——\s*(\d{1,2})月(\d{1,2})日\s*(周[一二三四五六日天])?\s*——/);
    const datePrefix = sep
        ? `${pad2(Number(sep[1]))}-${pad2(Number(sep[2]))}${sep[3] ? " " + sep[3] : ""}`
        : `${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${WEEKDAY_CN[now.getDay()]}`;
    return body.split("\n").map(line => {
        const m = line.match(/^(\s*)【([^】]+)】\s*$/);
        if (!m) return line;
        const inner = m[2].trim();
        if (/^\d{1,2}-\d{1,2}/.test(inner)) return line;
        if (!/\d{1,2}:\d{2}/.test(inner)) return line;
        return `${m[1]}【${datePrefix} ${inner}】`;
    }).join("\n");
}

/** 引号超限：保留前 N 处原话，其余去掉引号（读起来是转述，不再是逐句照搬） */
function trimExcessQuotes(body: string, limit: number): string {
    let kept = 0;
    return body
        .replace(/「[^」\n]{1,80}」/g, m => (++kept <= limit ? m : m.slice(1, -1)))
        .replace(/“[^”\n]{1,80}”/g, m => (++kept <= limit ? m : m.slice(1, -1)));
}

/** 兜底删句：记录里没有的肢体/环境分句，直接从句子里剪掉 */
function dropFabricatedClauses(body: string, transcript: string): string {
    const cues = BODY_FABRICATION_CUES.filter(c => !transcript.includes(c));
    if (cues.length === 0) return body;
    const pattern = new RegExp(`[^。，；！？\\n]*(${cues.join("|")})[^。，；！？\\n]*[，；]?`, "g");
    return body.split("\n").map(line => {
        if (/^\s*【[^】]+】\s*$/.test(line)) return line; // 标题不动
        let next = line.replace(pattern, "");
        next = next.replace(/^[，；、]+/, "").replace(/[，；]{2,}/g, "，").replace(/，。/g, "。").trim();
        if (!next.trim()) return line; // 整句删空就留给人工看，不做静默清空
        return next;
    }).join("\n");
}

/** 锚点兜底清洗：命中禁用词/编造细节的类别直接写「无变化」，五类补齐 */
function sanitizeAnchors(anchors: string, transcript: string): string {
    const found = new Map<string, string>();
    for (const line of (anchors || "").split("\n")) {
        const m = line.match(/^\s*[·•\-*]\s*(物品与状态|认知与事实澄清|违规隐患|关系变化|待兑现)\s*[：:]\s*(.*)$/);
        if (!m || found.has(m[1])) continue;
        found.set(m[1], m[2].trim());
    }
    const lines = ANCHOR_CATEGORIES.map(key => {
        const content = found.get(key) || "";
        const bad =
            ANCHOR_FORBIDDEN_CUES.some(c => content.includes(c)) ||
            BODY_FABRICATION_CUES.some(c => content.includes(c) && !transcript.includes(c));
        return `· ${key}：${!content || bad ? "无变化" : content}`;
    });
    return "【关键锚点】\n" + lines.join("\n");
}

/** 归档弹窗：把聊天记录提炼成一份可编辑的长文档，确认后写入角色记忆（世界书级）。 */
export function ChatArchivePanel({
    characterId,
    characterName,
    sessionId,
    onClose,
}: {
    characterId: string;
    characterName: string;
    sessionId?: string;
    onClose: () => void;
}) {
    const [archives, setArchives] = useState<MemoryEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [summarizing, setSummarizing] = useState(false);
    const [draft, setDraft] = useState("");
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editText, setEditText] = useState("");
    const [saving, setSaving] = useState(false);
    const [notice, setNotice] = useState("");
    const noticeTimer = useRef<number | null>(null);
    const onNotice = useCallback((msg: string) => {
        setNotice(msg);
        if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
        noticeTimer.current = window.setTimeout(() => setNotice(""), 2200);
    }, []);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const list = await loadMemoryEntriesByType(characterId, "archive");
            // 只显示本聊天室的普通模式归档；群像/剧情模式归档走群像那条线，不串到这里
            setArchives(
                list
                    .filter(entry => entry.sourceApp === "chat")
                    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
            );
        } catch {
            setArchives([]);
        } finally {
            setLoading(false);
        }
    }, [characterId]);

    // 进入时：恢复上次未确认的草稿（避免退出后丢失编辑）
    useEffect(() => {
        setDraft(loadArchiveDraft(characterId));
    }, [characterId]);

    useEffect(() => { void load(); }, [load]);

    // 草稿变化即持久化
    useEffect(() => { saveArchiveDraft(characterId, draft); }, [characterId, draft]);

    const collectTranscript = useCallback((): string => {
        if (!sessionId) return "";
        // 用用户在本角色下的称呼（拿不到就「用户」），避免模型把「我」写进归档正文
        const userName = resolveUserIdentity(characterId, "chat")?.name?.trim() || "用户";
        const msgs: ChatMessage[] = loadChatMessages(sessionId);
        const lines: string[] = [];
        let lastDayKey = "";
        const dayKeyOf = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        for (const m of msgs) {
            if (m.isRetracted) continue;
            // 剧情模式（群像投递进来的那几段）归群像剧本自己的归档，这里只吃普通聊天
            if (m.deliverySessionId) continue;
            // 系统事件行（「正在加入播放列表…」「已加入播放列表，共 1 首」）照单收：
            // 「加进去了」这类含糊台词全靠它才不会被误读成「加了好友」
            if (m.role === "system") {
                const sys = (m.content || m.mediaData?.label || "").trim();
                if (sys) lines.push(`[系统] ${sys}`);
                continue;
            }
            const role = m.role === "user" ? userName : m.role === "assistant" ? characterName : null;
            if (!role) continue;
            const text = messageTranscriptText(m);
            if (!text) continue;
            // 每行带「日期 + 时刻」：模型必须靠这个判断跨天与「隔了多久才回」，不许自己猜
            const when = m.createdAt ? new Date(m.createdAt) : null;
            const dayKey = when ? dayKeyOf(when) : "";
            if (when && dayKey !== lastDayKey) {
                lines.push(`—— ${when.getMonth() + 1}月${when.getDate()}日 ${WEEKDAY_CN[when.getDay()]} ——`);
                lastDayKey = dayKey;
            }
            const stamp = when ? fmtClock(when) : "";
            lines.push(stamp ? `${stamp} ${role}：${text}` : `${role}：${text}`);
        }
        return lines.join("\n").trim();
    }, [sessionId, characterName, characterId]);

    /** 本轮系统事实（代码算，不让模型猜）：本轮时间范围 + 一起听的歌单。 */
    const collectSessionFacts = useCallback(async (): Promise<string> => {
        const facts: string[] = [];
        try {
            const msgs = await loadChatMessages(sessionId || characterId);
            const normal = msgs.filter(m => !m.deliverySessionId && !m.isRetracted && (m.role === "user" || m.role === "assistant"));
            const times = normal.map(m => m.createdAt).filter(Boolean).sort((a, b) => String(a).localeCompare(String(b)));
            if (times.length > 0) {
                const first = new Date(times[0]);
                const last = new Date(times[times.length - 1]);
                facts.push(
                    `· 本轮聊天时间：${first.getMonth() + 1}-${pad2(first.getDate())} ${WEEKDAY_CN[first.getDay()]} ` +
                    `${fmtClock(first)} 至 ${last.getMonth() + 1}-${pad2(last.getDate())} ${WEEKDAY_CN[last.getDay()]} ${fmtClock(last)}` +
                    `（共 ${normal.length} 条消息）。段落标题的日期与星期以这行为准。`,
                );
            }
        } catch { /* 读不到就算了 */ }
        try {
            // 一起听事实：优先取「进行中」的会话；已结束的从记忆库里最近那条歌单记录读（带日期门槛）
            const { getListenSession } = await import("@/lib/listen-together-session");
            const session = getListenSession();
            if (session && (session.tracks?.length || 0) > 0) {
                const start = new Date(session.startedAt);
                const songs = session.tracks
                    .map(t => (t.artist ? `${t.title} - ${t.artist}` : t.title))
                    .filter(Boolean);
                const minute = Math.max(1, Math.round((Date.now() - new Date(session.startedAt).getTime()) / 60000));
                facts.push(
                    `· 一起听（刚结束/进行中）：${start.getMonth() + 1}-${pad2(start.getDate())} ${fmtClock(start)} 起，` +
                    `两人隔着手机一起听歌 ${minute} 分钟，放了 ${songs.length} 首：\n` +
                    songs.map(s => `  - ${s}`).join("\n") +
                    `\n  这件事要写成叙述进正文（谁放了什么、对方怎么接的）；**不要**自己写【一起听：…】这一行，系统会在末尾自动加。`,
                );
            } else {
                // 已结束：读「最近结束的一场」（48 小时内的本地存档，不再走记忆库歌单记录）
                const { getLastListenSession } = await import("@/lib/listen-together-session");
                const last = getLastListenSession();
                const matches = last && (!last.characterId || last.characterId === characterId || last.characterName === characterName);
                if (last && matches) {
                    const start = new Date(last.startedAt);
                    const end = new Date(last.endedAt);
                    const songs = last.tracks
                        .map(t => (t.artist ? `${t.title} - ${t.artist}` : t.title))
                        .filter(Boolean);
                    if (songs.length > 0) {
                        const minute = Math.max(1, Math.round((end.getTime() - start.getTime()) / 60000));
                        facts.push(
                            `· 一起听（本场已结束）：${start.getMonth() + 1}-${pad2(start.getDate())} ${fmtClock(start)}–${fmtClock(end)}，` +
                            `两人隔着手机一起听歌 ${minute} 分钟，放了 ${songs.length} 首：\n` +
                            songs.map(s => `  - ${s}`).join("\n") +
                            `\n  这件事要写成叙述进正文（谁放了什么、对方怎么接的）；**不要**自己写【一起听：…】这一行，系统会在末尾自动加。`,
                        );
                    }
                }
            }
        } catch { /* 一起听状态读不到就算了 */ }
        return facts.length > 0 ? "【本轮系统事实（代码生成，直接可信，以此为准）】\n" + facts.join("\n") + "\n\n" : "";
    }, [sessionId, characterId]);

    /** 一起听 footer（代码兜底，模型漏了也补）：进行中取会话，已结束取「最近结束的一场」本地存档。 */
    const collectListenFootnote = useCallback(async (): Promise<string> => {
        try {
            const { getListenSession, getLastListenSession } = await import("@/lib/listen-together-session");
            const session = getListenSession();
            if (session && (session.tracks?.length || 0) > 0) {
                const start = new Date(session.startedAt);
                const end = new Date();
                return `【一起听：${start.getMonth() + 1}月${start.getDate()}日 ${fmtClock(start)}–${fmtClock(end)}，${session.tracks.length} 首】`;
            }
            const last = getLastListenSession();
            if (!last || (last.characterId && last.characterId !== characterId && last.characterName !== characterName)) return "";
            if (!last.tracks?.length) return "";
            const start = new Date(last.startedAt);
            const end = new Date(last.endedAt);
            return `【一起听：${start.getMonth() + 1}月${start.getDate()}日 ${fmtClock(start)}–${fmtClock(end)}，${last.tracks.length} 首】`;
        } catch {
            return "";
        }
    }, [characterId, characterName]);

    const handleSummarize = useCallback(async () => {
        const transcript = collectTranscript();
        if (!transcript.trim()) {
            onNotice("暂无可提炼的聊天记录");
            return;
        }
        setSummarizing(true);
        try {
            const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
            if (!apiConfig || !apiConfig.apiKey) {
                onNotice("未配置记忆总结模型（设置 → 辅助模型）");
                return;
            }
            // 剧情时钟（2026-11-12）：归档的日期与时刻按剧情时间走，和群像当前锚点对齐
            const now = getStoryNow();
            const header = buildArchiveHeader(now);
            const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
                Promise.race([
                    p,
                    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("请求超时（60秒无响应）")), ms)),
                ]);
            // 背景包：人设 + 世界书 + 长期记忆（归档上一版单独喂，见下）
            const pack = await buildArchiveContextPack(characterId);
            const factsText = await collectSessionFacts();
            const settingsText = pack.settings
                ? "【角色设定与世界书（只用来判断双方各自在哪、什么关系，不得据此编造本轮记录之外的情节）】\n" +
                pack.settings + "\n\n"
                : "";
            const memoriesText = pack.memories
                ? "【长期记忆（只当已知背景，不要复述，也不要当成这一轮发生的事）】\n" +
                pack.memories + "\n\n"
                : "";
            const sceneText = pack.scene
                ? "【当前场景（空间以此为准：若两人同处一室，就写「在旁边」「同一间屋里」，"
                + "绝不许想当然写成「隔着手机」「隔着屏幕」；只有场景确实是异地才写隔着手机）】\n" +
                pack.scene + "\n\n"
                : "";
            // 上一版归档：归档是「单条滚动」的——老正文原样保留，只往后追加新段落
            const existingArchives = (await loadMemoryEntriesByType(characterId, "archive"))
                .filter(entry => entry.sourceApp !== "ensemble" && !entry.metadata?.listenRecord)
                .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
            const previous = existingArchives[0]?.content?.trim() || "";
            const previousParts = splitArchiveDoc(previous);
            const previousText = previous
                ? "【上一版归档（只作为上文与已知状态，不要重写、不要压缩、不要复述）】\n" + previous + "\n\n"
                : "";
            const res = await withTimeout(simpleLLMCall(
                apiConfig,
                [
                    {
                        role: "system",
                        content:
                            "你是记忆归档助手。任务：把「这一轮」新发生的事，追加进这个角色的归档文档。\n" +
                            "老内容一个字都不要改写、不要压缩、不要总结、不要写版本号——你只负责写本轮新增的部分。\n\n" +
                            "【只输出下面两块，纯文本，不要 Markdown 符号（** # ` >），不要解释】\n\n" +
                            "【新增段落】\n" +
                            "【11-11 周二 20:35 - 21:10】\n" +
                            "（本轮发生的事，小说式叙述，按时间推进；换时段或换场景就再起一段【…】）\n\n" +
                            "【关键锚点】\n" +
                            "· 物品与状态：…\n" +
                            "· 认知与事实澄清：…\n" +
                            "· 违规隐患：…\n" +
                            "· 关系变化：…\n" +
                            "· 待兑现：…\n\n" +
                            "【最重要的规矩：正文是叙述，不是抄记录】\n" +
                            "禁止把「HH:MM 名字：内容」这种记录行原样搬进正文。记录是给你看的素材，正文要把它" +
                            "化成第三人称叙述：合并同一话题的来回、只保留关键台词、写清楚谁放了歌谁接了话。\n" +
                            "正确示例（基于 5 条记录的写法）：\n" +
                            "  记录——17:02 金成帝：니가 뭘 알아。/ 17:02 金成帝：我不懂，你最懂。/ 17:02 岳霖玉：切跟你说你也不懂\n" +
                            "  正文——聊到泰版流星花园，她说他看不懂，他回了句韩语「니가 뭘 알아」（你懂什么），又补了句「我不懂，你最懂」，语气不像真生气。\n" +
                            "错误示例（这就是照抄，禁止）：\n" +
                            "  17:02 金成帝：니가 뭘 알아。\n  17:02 金成帝：我不懂，你最懂。\n  17:02 岳霖玉：切跟你说你也不懂\n\n" +
                            "【写法要求】\n" +
                            "1. 只写这一轮记录里真实发生的内容。这一轮是「隔着手机聊天」：双方各自在各自所在地，" +
                            "记录里只有打字、发语音、发图片这些动作——除此之外的一切肢体动作" +
                            "（放下手机、贴在耳边、倒扣在床头柜、指着窗外、抬头、转身、走到谁身边）" +
                            "都是记录里不存在的，一个都不许写。可以写「他说」「她发来」「隔着屏幕」，仅此而已。\n" +
                            "2. 可以写语气与判断（「像是赌气」「听起来不高兴」），但必须有记录依据；" +
                            "不许凭空补对白、不许补结尾、不许加记录里没有的环境细节（雨声、霓虹灯、床头柜）。\n" +
                            "3. 引用台词有度：正文是叙述，只在关键转折处引原话（全文带引号的原话最多 10 句，这是硬上限，" +
                            "代码会数），其余用转述（「他让她别盯着屏幕太久」）；不要每一句都带引号。\n" +
                            "4. 一律第三人称，用记录里的名字称呼双方（角色名 / 用户的名字），全篇不得出现「我」。" +
                            "一句只写一个主语，分不清谁做、谁说的，宁可不写这句。\n" +
                            "5. 「语气带着不耐烦」这类笼统标签一次都不许用：每写一处语气，必须落到他/她的具体用词上" +
                            "（例：「他连回三条都是短句，是真的烦了」），说不出具体依据就不写语气。\n" +
                            "6. 空间按设定来：除非记录里明确写到两人见面、同处一室，否则一律写成各自在各自所在地、" +
                            "隔着手机——不写任何需要共享物理空间的动作（「歪头看向手机屏幕」「把手机推过来」「递过去」之类），" +
                            "也不要把任何一方搬到对方的城市；设定里没写的地方就写「那边」「国内」「首尔」。\n" +
                            "7. 段落标题用真实日期与时刻「【11-11 周二 16:57 - 17:18】」：" +
                            "日期与星期从记录的日期分隔行和【本轮系统事实】里取，时刻取每行前面的 HH:MM。" +
                            "标题里不要写人名。跨天、跨时段就分段。\n" +
                            "8. 「[语音]」是角色说出口的话，可原话引用；「[图片]/[红包]/[位置]/[音乐分享]/[通话]」" +
                            "这类是真实发生过的动作，要写清楚发生了什么、对方怎么接的。「[系统]」行是手机系统的动作" +
                            "（如「正在加入播放列表」「已加入播放列表」），照实写成「把歌加进了一起听的播放列表」——" +
                            "不是加了好友、不是联系方式，不许引申。\n" +
                            "9. 台词必须保持记录里的原语言，禁止翻译或改写：记录里是中文就引中文，" +
                            "记录里是韩语（角色偶尔用韩语回）才引韩语。绝对禁止把中文台词自行翻成韩语再写进归档，" +
                            "也禁止给没说过的话配外语版本；写了「用韩语」就必须真是韩语原文。" +
                            "韩语台词首次出现时可在括号里注中文意思，此后直接用原句、不再括注。\n" +
                            "10. 【关键锚点】整块重写：在上一版锚点的基础上更新，五类都写，" +
                            "某一类确实没有变化就写「无变化」。每条锚点要写成一句带状态的话" +
                            "（例：「他嗓子哑着，两天没好」「约了周三视频，钟点没定」），" +
                            "不许是名词罗列（例：「耳机、手机、手腕酸」这种直接打回重写）。" +
                            "锚点只写「状态、约定、悬而未决的事」，不写聊天里的话题和互相的看法" +
                            "（「他对泰版流星花园表示不解」是话题，不是锚点）；" +
                            "锚点里禁止出现记录中不存在的概念（如「权限」「授权」「邀约」这类记录里没提过的词）。\n" +
                            "11. 上一版归档只用来判断双方状态、避免重复叙述，不要把旧内容再写一遍。\n" +
                            "12. 篇幅：每段 200–900 字，把事情写透；不设总字数上限。\n\n" +
                            settingsText +
                            sceneText +
                            "【输出前的自检】每写一段，回查本轮记录：这条信息是哪句话/哪个媒体给的？" +
                            "找不到依据的句子直接删掉；每段开头若还是「HH:MM 名字：」，整段重写成叙述。",
                    },
                    {
                        role: "user",
                        content:
                            memoriesText +
                            factsText +
                            previousText +
                            "【本轮聊天记录（每行前面是发送时间 HH:MM，跨天会插日期分隔行）】\n" + transcript,
                    },
                ],
                { temperature: 0.3, label: "chat-archive" },
            ), 60000);
            if (!res.content) {
                onNotice(res.error || "提炼失败");
                return;
            }
            // 模型只出「新增段落 + 新锚点」，老正文由代码原样拼回去（绝不压缩、绝不被模型改写）
            let added = splitNewParts(res.content);
            if (!added.body) {
                onNotice("提炼结果为空，请重试");
                return;
            }
            // 第二轮自检：只核对新增部分，逐句回查本轮记录
            try {
                const checked = await withTimeout(simpleLLMCall(
                    apiConfig,
                    [
                        {
                            role: "system",
                            content:
                                "你是归档审校员。给你本轮聊天记录和一段新增归档，逐句核对：\n" +
                                "【第一优先：是不是照抄】正文里出现「HH:MM 名字：内容」格式的行，就是照抄记录，" +
                                "必须改写成第三人称叙述（合并来回、只留关键台词），一段都不许留这种行。\n" +
                                "【第二优先：编造】每一句都必须能在这轮记录里找到依据。\n" +
                                "1. 这一轮是隔着手机聊天：记录里没有的肢体动作（放下手机、贴在耳边、倒扣在床头柜、" +
                                "指着窗外、抬头、转身），编造的韩语/外语台词，编造的对白与结尾，全部删掉。\n" +
                                "2. 台词保持原语言：中文台词不许被翻成韩语。\n" +
                                "3. 把写成同一空间、共享物理空间的句子，改写成各自在各自所在地、隔着手机。\n" +
                                "4. 段落标题必须是「【MM-DD 周X HH:MM - HH:MM】」格式，不带人名；" +
                                "日期星期以【本轮系统事实】为准。\n" +
                                "5. 锚点必须是带状态的一句话；名词罗列（「耳机、手机、手腕酸」）改写成句子；" +
                                "锚点只写状态、约定、悬而未决的事，聊天话题（「他对某剧表示不解」）和互相的看法删掉；" +
                                "记录里不存在的概念（「权限」「授权」「敏感话题」等）删掉。\n" +
                                "6. 语气标签（「语气不耐烦」「语气带着责备」）若没有具体用词支撑就删掉；" +
                                "同一句式在全文出现两次以上就改写。\n" +
                                "7. 除上述修改外不要新增内容，不要改格式，不要写解释或修订说明。\n" +
                                "8. 原样输出这两块：【新增段落】…【关键锚点】…（五类都保留）。",
                        },
                        {
                            role: "user",
                            content:
                                factsText +
                                settingsText +
                                sceneText +
                                "【本轮聊天记录】\n" + transcript +
                                "\n\n【待审校的新增部分】\n【新增段落】\n" + added.body +
                                "\n\n" + (added.anchors || "【关键锚点】\n· 物品与状态：无变化\n· 认知与事实澄清：无变化\n· 违规隐患：无变化\n· 关系变化：无变化\n· 待兑现：无变化"),
                        },
                    ],
                    { temperature: 0.1, label: "chat-archive-check" },
                ), 60000);
                const checkedText = checked.content?.trim();
                if (checkedText && checkedText.includes("【关键锚点】")) {
                    const revised = splitNewParts(checkedText);
                    if (revised.body) added = { body: revised.body, anchors: revised.anchors || added.anchors };
                }
            } catch { /* 自检失败就用第一版 */ }

            // 第三轮：代码硬校验（照抄 / 引号超标 / 编造动作 / 锚点跑偏 / 标题缺日期），查出问题先定点返修一次
            let issues = auditArchivePart(added.body, added.anchors, transcript);
            if (issues.length > 0) {
                try {
                    const repaired = await withTimeout(simpleLLMCall(
                        apiConfig,
                        [
                            {
                                role: "system",
                                content:
                                    "你是归档修订员。下面这份新增归档经程序校验有几处不合规，只改这几处，其余原样保留。\n" +
                                    "【必须修的问题】\n" +
                                    issues.map((it, i) => `${i + 1}. ${it.detail}`).join("\n") + "\n\n" +
                                    "修法：\n" +
                                    "· 引号超标：只保留最能代表这一轮的 10 句原话（带引号），其余改成转述、不再带引号。\n" +
                                    "· 写了记录里没有的肢体动作/环境：删掉该分句，或改写成隔着手机的表达（「他发来」「她隔着屏幕问」）。\n" +
                                    "· 锚点跑偏：只写状态、约定、悬而未决的事；记录里没有的概念、聊天话题、互相的看法一律删掉，" +
                                    "没得写就写「无变化」。\n" +
                                    "· 段落标题必须是「【MM-DD 周X HH:MM - HH:MM】」，日期星期以【本轮系统事实】为准。\n" +
                                    "· 写了「用韩语」就必须是韩语原文；韩语台词只在首次出现时括注中文。\n" +
                                    "除这几处外不得改动，不许新增情节，不许压缩。只输出两块：【新增段落】…【关键锚点】…（五类齐全）。",
                            },
                            {
                                role: "user",
                                content:
                                    factsText + settingsText + sceneText +
                                    "【本轮聊天记录】\n" + transcript +
                                    "\n\n【待修订的新增部分】\n【新增段落】\n" + added.body +
                                    "\n\n" + (added.anchors || ANCHOR_DEFAULT),
                            },
                        ],
                        { temperature: 0.1, label: "chat-archive-fix" },
                    ), 60000);
                    const fixedText = repaired.content?.trim();
                    if (fixedText && fixedText.includes("【新增段落】")) {
                        const revised = splitNewParts(fixedText);
                        if (revised.body) added = { body: revised.body, anchors: revised.anchors || added.anchors };
                    }
                } catch { /* 返修失败就交给下面的代码兜底 */ }
            }

            // 代码兜底：模型没改干净的由程序直接改——补日期、剪掉编造分句、引号限量、锚点写「无变化」
            added = {
                body: trimExcessQuotes(
                    dropFabricatedClauses(fixParagraphHeaders(added.body, transcript, now), transcript),
                    QUOTE_LIMIT,
                ),
                anchors: added.anchors ? sanitizeAnchors(added.anchors, transcript) : ANCHOR_DEFAULT,
            };
            issues = auditArchivePart(added.body, added.anchors, transcript);
            if (issues.length > 0) {
                onNotice(`归档还有 ${issues.length} 处要你看一眼：${issues[0].detail}`);
            }

            // 一起听 footer 由代码统一生成：先把模型自己写的那些【…一起听：…】行清掉（格式乱七八糟、还会重复），再在末尾补一行标准的
            const factsFootnote = await collectListenFootnote();
            added = {
                body: added.body.replace(/^[ \t]*【[^】]*一起听：[^】]*】[ \t]*$/gm, "").replace(/\n{3,}/g, "\n\n").trim(),
                anchors: added.anchors,
            };
            const bodyParts = [previousParts.body, added.body].filter(Boolean).join("\n\n");
            const anchorPart = added.anchors || previousParts.anchors;
            setDraft([header, bodyParts, factsFootnote, anchorPart].filter(Boolean).join("\n\n"));
        } catch (e) {
            onNotice(e instanceof Error ? e.message : "提炼失败");
        } finally {
            setSummarizing(false);
        }
    }, [collectTranscript, collectSessionFacts, collectListenFootnote, characterId, characterName, onNotice]);

    const handleConfirmArchive = useCallback(async () => {
        const text = draft.trim();
        if (!text) { onNotice("内容为空"); return; }
        setSaving(true);
        try {
            // 归档是「单条滚动」的：已有归档就原地增量更新，不新建、不删旧
            const list = await loadMemoryEntriesByType(characterId, "archive");
            const target = list
                .filter(entry => entry.sourceApp !== "ensemble" && !entry.metadata?.listenRecord)
                .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))[0];
            const res = target
                ? await updateArchiveEntry(characterId, target.id, text)
                : await commitArchive(characterId, text, "chat");
            if (res.success) {
                onNotice(target ? "已追加进归档，写入角色记忆" : "已归档，写入角色记忆");
                setDraft("");
                await load();
            } else {
                onNotice(res.error || "归档失败");
            }
        } finally {
            setSaving(false);
        }
    }, [draft, characterId, onNotice, load]);

    const handleSaveEdit = useCallback(async (entry: MemoryEntry) => {
        const text = editText.trim();
        if (!text) { onNotice("内容为空"); return; }
        setSaving(true);
        try {
            // 普通聊天归档原地改，不删除（删除会写防污染墓碑，还会丢 id）
            const res = entry.sourceApp === "ensemble"
                ? await (async () => {
                    await deleteArchive(characterId, entry.id);
                    return commitArchive(characterId, text, entry.sourceApp);
                })()
                : await updateArchiveEntry(characterId, entry.id, text);
            if (res.success) {
                onNotice("已保存"); setEditingId(null); await load();
            }
            else onNotice(res.error || "保存失败");
        } finally {
            setSaving(false);
        }
    }, [editText, characterId, onNotice, load]);

    const handleDelete = useCallback(async (entry: MemoryEntry) => {
        await deleteArchive(characterId, entry.id);
        setArchives(prev => prev.filter(e => e.id !== entry.id));
        onNotice("已删除（并加入防污染墓碑）");
    }, [characterId, onNotice]);

    const hasTranscript = useMemo(() => (sessionId ? loadChatMessages(sessionId).length > 0 : false), [sessionId]);

    return (
        <div className="modal-overlay" style={{ zIndex: 210 }} onClick={onClose} data-ens-ui="1">
            <div
                className="modal-dialog-archive"
                onClick={e => e.stopPropagation()}
                style={{
                    width: "92%", maxWidth: 560, maxHeight: "86vh", display: "flex", flexDirection: "column",
                    background: "var(--c-panel, #fff)", borderRadius: 16, overflow: "hidden",
                    boxShadow: "0 12px 36px rgba(0,0,0,0.2)",
                    animation: "modalSoftRise 0.3s cubic-bezier(0.16, 1, 0.3, 1)",
                }}
            >
                {/* 头部 */}
                <div className="flex items-center justify-between px-4 py-3 shrink-0" style={{ borderBottom: "1px solid var(--border-subtle, rgba(0,0,0,0.06))" }}>
                    <div>
                        <div className="ts-16 font-medium">归档</div>
                        <div className="ts-11 text-secondary mt-0.5">{characterName} · 人工确认的长档案，权重等同世界书</div>
                    </div>
                    <button className="rounded-full p-1.5" style={{ background: "var(--surface-2, rgba(0,0,0,0.05))" }} onClick={onClose} aria-label="关闭">
                        <X size={16} />
                    </button>
                </div>

                {/* 内容 */}
                <div className="flex-1 overflow-y-auto px-4 py-3">
                    <div className="rounded-2xl p-3 mb-4" style={{ background: "var(--surface-2, rgba(0,0,0,0.03))" }}>
                        <div className="flex items-center justify-between mb-2">
                            <span className="ts-13 font-medium">从聊天记录提炼</span>
                            <button
                                className="rounded-xl px-3 py-1.5 ts-12 flex items-center gap-1"
                                style={{ background: "#BDD4E3", color: "#2b3a44", opacity: hasTranscript && !summarizing ? 1 : 0.5 }}
                                disabled={!hasTranscript || summarizing}
                                onClick={handleSummarize}
                            >
                                {summarizing ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                                {summarizing ? "提炼中…" : (draft ? "重新提炼" : "提炼")}
                            </button>
                        </div>
                        {!hasTranscript && <p className="ts-11 text-secondary">当前会话暂无记录可提炼。</p>}
                        {draft && (
                            <>
                                <textarea
                                    value={draft}
                                    onChange={e => setDraft(e.target.value)}
                                    rows={10}
                                    className="w-full rounded-xl p-2 ts-13 mt-1"
                                    style={{ background: "var(--c-panel, #fff)", border: "1px solid var(--border-subtle, rgba(0,0,0,0.1))", resize: "vertical", lineHeight: 1.6 }}
                                />
                                <div className="flex gap-2 mt-2">
                                    <button
                                        className="flex-1 rounded-xl py-2 ts-13 flex items-center justify-center gap-1"
                                        style={{ background: "#BDD4E3", color: "#2b3a44", opacity: saving ? 0.6 : 1 }}
                                        disabled={saving}
                                        onClick={handleConfirmArchive}
                                    >
                                        <Check size={14} /> {saving ? "写入中…" : "确认归档"}
                                    </button>
                                    <button
                                        className="rounded-xl py-2 px-3 ts-13"
                                        style={{ background: "var(--c-panel, #fff)", border: "1px solid var(--border-subtle, rgba(0,0,0,0.1))" }}
                                        onClick={() => setDraft("")}
                                    >
                                        放弃
                                    </button>
                                </div>
                            </>
                        )}
                    </div>

                    <div className="ts-13 font-medium mb-2">已归档（{archives.length}）</div>
                    {loading ? (
                        <p className="ts-12 text-secondary text-center py-6">加载中…</p>
                    ) : archives.length === 0 ? (
                        <p className="ts-12 text-secondary text-center py-6">暂无归档。</p>
                    ) : (
                        <div className="flex flex-col gap-3">
                            {archives.map(entry => {
                                const isEditing = editingId === entry.id;
                                return (
                                    <div key={entry.id} className="rounded-2xl p-3" style={{ background: "var(--surface-2, rgba(0,0,0,0.03))", border: "1px solid var(--border-subtle, rgba(0,0,0,0.06))" }}>
                                        <div className="flex items-center justify-between mb-2">
                                            <span className="ts-11 text-secondary">{new Date(entry.createdAt).toLocaleString("zh-CN")}</span>
                                            <div className="flex gap-2 items-center">
                                                {isEditing ? (
                                                    <>
                                                        <button className="ts-12" style={{ color: "var(--accent, #6c5ce7)" }} disabled={saving} onClick={() => handleSaveEdit(entry)}>保存</button>
                                                        <button className="ts-12 text-secondary" onClick={() => setEditingId(null)}>取消</button>
                                                    </>
                                                ) : (
                                                    <>
                                                        <button className="ts-12" style={{ color: "var(--accent, #6c5ce7)" }} onClick={() => { setEditingId(entry.id); setEditText(entry.content); }}>编辑</button>
                                                        <button className="ts-12" style={{ color: "var(--danger, #e74c3c)" }} onClick={() => handleDelete(entry)}><Trash2 size={12} /></button>
                                                    </>
                                                )}
                                            </div>
                                        </div>
                                        {isEditing ? (
                                            <textarea
                                                value={editText}
                                                onChange={e => setEditText(e.target.value)}
                                                rows={8}
                                                className="w-full rounded-xl p-2 ts-13"
                                                style={{ background: "var(--c-panel, #fff)", border: "1px solid var(--border-subtle, rgba(0,0,0,0.1))", resize: "vertical", lineHeight: 1.6 }}
                                            />
                                        ) : (
                                            <p className="ts-13 whitespace-pre-wrap" style={{ lineHeight: 1.7 }}>{entry.content}</p>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {notice && (
                    <div className="absolute left-1/2 -translate-x-1/2 bottom-6 z-[220] rounded-full px-4 py-2 ts-13"
                        style={{ background: "rgba(0,0,0,0.78)", color: "#fff" }}>{notice}</div>
                )}
            </div>
        </div>
    );
}
