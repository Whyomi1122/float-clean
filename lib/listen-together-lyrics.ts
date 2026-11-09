// 一起听 · 歌词评论配额
// 规则（用户口径）：
//   · 一首歌的「歌词评论」最多 3 句，其他闲聊不限；
//   · 同一首歌第二次听，先引用上次聊过的 3 句，新配额减半（1 句）；
//   · 已聊过的歌词行不再重复，也不在窗口里重复喂给模型。
// 判定方式：回复里出现了当前歌词窗口中的某一行（去标点后比对），记为聊了一句歌词。

import { getNowPlayingLyricLines, getNowPlayingSnapshot } from "@/lib/music-now-playing";

export type LyricTalkEntry = {
    trackId: string;
    title: string;
    lines: string[];
    updatedAt: string;
};

const KEY_PREFIX = "ai_phone_listen_lyric_talk_v1_";
const BASE_QUOTA = 3;
const MAX_SONGS = 60;
const MAX_LINES = 12;

function loadAll(characterId: string): Record<string, LyricTalkEntry> {
    if (typeof window === "undefined" || !characterId) return {};
    try {
        const raw = window.localStorage.getItem(KEY_PREFIX + characterId);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? (parsed as Record<string, LyricTalkEntry>) : {};
    } catch {
        return {};
    }
}

function saveAll(characterId: string, data: Record<string, LyricTalkEntry>): void {
    if (typeof window === "undefined" || !characterId) return;
    try {
        const entries = Object.entries(data)
            .sort((a, b) => (a[1].updatedAt < b[1].updatedAt ? 1 : -1))
            .slice(0, MAX_SONGS);
        window.localStorage.setItem(KEY_PREFIX + characterId, JSON.stringify(Object.fromEntries(entries)));
    } catch (err) {
        console.warn("[ListenLyrics] 保存失败:", err);
    }
}

function normalize(text: string): string {
    return text
        .toLowerCase()
        .replace(/[\s,.!?;:'"“”‘’()（）【】\[\]…—\-~、，。！？：；]/g, "");
}

export function getLyricQuota(characterId: string, trackId: string): { used: number; quota: number; lines: string[] } {
    const entry = loadAll(characterId)[trackId];
    if (!entry) return { used: 0, quota: BASE_QUOTA, lines: [] };
    const quota = Math.max(1, Math.floor(BASE_QUOTA / 2));
    return { used: entry.lines.length, quota, lines: entry.lines };
}

/** 生成给模型看的「歌词配额」提示；返回空串表示本轮不需要 */
export function buildLyricQuotaNote(characterId: string): string {
    if (!characterId) return "";
    const snapshot = getNowPlayingSnapshot();
    if (!snapshot) return "";
    const lines = getNowPlayingLyricLines();
    if (lines.length === 0) return "";

    const quota = getLyricQuota(characterId, snapshot.trackId);
    if (quota.used >= quota.quota) {
        return `【歌词】《${snapshot.title}》的歌词你已经聊到上限了,这一轮别再评论歌词——可以说说别的,或者干脆跟着哼一句。`;
    }
    if (quota.lines.length > 0) {
        const quoted = quota.lines.slice(-3).map(line => `「${line}」`).join("");
        return `【歌词】《${snapshot.title}》你之前聊过这几句:${quoted}。这次最多再聊 ${quota.quota - quota.used} 句歌词,而且不要重复上面这几句。`;
    }
    return `【歌词】《${snapshot.title}》的歌词最多聊 3 句,同一句别重复说。`;
}

/** 回复发完后调用：找出这轮真正聊到的歌词行并记账 */
export function recordLyricTalkFromReply(characterId: string, replyText: string): void {
    if (!characterId || !replyText.trim()) return;
    const snapshot = getNowPlayingSnapshot();
    if (!snapshot) return;
    const lines = getNowPlayingLyricLines();
    if (lines.length === 0) return;

    const normalizedReply = normalize(replyText);
    const matched = lines.filter(line => {
        const normalizedLine = normalize(line);
        return normalizedLine.length >= 4 && normalizedReply.includes(normalizedLine);
    });
    if (matched.length === 0) return;

    const all = loadAll(characterId);
    const prev = all[snapshot.trackId];
    const merged = [...(prev?.lines ?? [])];
    for (const line of matched) {
        if (!merged.includes(line)) merged.push(line);
    }
    all[snapshot.trackId] = {
        trackId: snapshot.trackId,
        title: snapshot.title,
        lines: merged.slice(-MAX_LINES),
        updatedAt: new Date().toISOString(),
    };
    saveAll(characterId, all);
}

export function resetLyricTalk(characterId: string, trackId?: string): void {
    if (typeof window === "undefined" || !characterId) return;
    if (!trackId) {
        try { window.localStorage.removeItem(KEY_PREFIX + characterId); } catch { /* ignore */ }
        return;
    }
    const all = loadAll(characterId);
    delete all[trackId];
    saveAll(characterId, all);
}
