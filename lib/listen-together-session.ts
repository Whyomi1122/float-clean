// lib/listen-together-session.ts — 一起听的"会话状态"
//
// 2026-11-09 用户口径（重要）：
//   · 一起听不是另一个界面，也不是聊天室里的状态条 —— 只在悬浮球「音乐」面板里体现（一起听中 / 结束）。
//   · 结束**只由用户手动点**，切 App / 关页面都不会自动结束。
//   · 结束时把这场一起听写进**普通模式的记忆归档**（时间 + 时长 + 歌单），供日后聊天参考。

const STORAGE_KEY = "ai_phone_listen_session_v1";
const EVENT = "float:listen-session";

export type ListenTrackMark = {
    id: string;
    title: string;
    artist: string;
};

export type ListenSession = {
    characterId: string;
    /** 角色名（兜底匹配用：个别会话的 contactId 与角色 id 对不上时按名字认人） */
    characterName?: string;
    startedAt: string;
    /** 这场一起听期间放过的歌（按首次播放顺序去重，最多留 60 首） */
    tracks: ListenTrackMark[];
};

const MAX_TRACKS = 60;

function emit() {
    if (typeof window === "undefined") return;
    try { window.dispatchEvent(new Event(EVENT)); } catch { /* ignore */ }
}

function write(session: ListenSession) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(session)); } catch { /* ignore */ }
}

export function getListenSession(): ListenSession | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<ListenSession>;
        if (!parsed?.characterId) return null;
        const tracks = Array.isArray(parsed.tracks)
            ? parsed.tracks
                .filter((t): t is ListenTrackMark => Boolean(t && typeof t.title === "string"))
                .map(t => ({ id: String(t.id ?? ""), title: t.title, artist: String(t.artist ?? "") }))
            : [];
        return {
            characterId: parsed.characterId,
            characterName: typeof parsed.characterName === "string" ? parsed.characterName : undefined,
            startedAt: parsed.startedAt || new Date().toISOString(),
            tracks,
        };
    } catch {
        return null;
    }
}

export function startListenSession(characterId: string, characterName?: string): ListenSession {
    const session: ListenSession = {
        characterId,
        characterName: characterName?.trim() || undefined,
        startedAt: new Date().toISOString(),
        tracks: [],
    };
    write(session);
    emit();
    return session;
}

/** 记一首"这场一起听里放过的歌"（不广播事件，避免每切一首歌就重渲染面板）。 */
export function recordListenTrack(track: ListenTrackMark): void {
    const session = getListenSession();
    if (!session) return;
    if (!track?.title) return;
    const key = track.id || `${track.title}|${track.artist}`;
    if (session.tracks.some(t => (t.id || `${t.title}|${t.artist}`) === key)) return;
    if (session.tracks.length >= MAX_TRACKS) return;
    session.tracks.push({ id: track.id, title: track.title, artist: track.artist });
    write(session);
}

/** 结束一起听，返回刚落幕的那一场（不含写归档）。 */
export function endListenSession(): ListenSession | null {
    const session = getListenSession();
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    emit();
    return session;
}

/** 当前是否正在和这个角色一起听（同一时刻只跟一个人一起听）。 */
export function isListeningWith(characterId: string | null | undefined): boolean {
    if (!characterId) return false;
    return getListenSession()?.characterId === characterId;
}

export function subscribeListenSession(callback: () => void): () => void {
    if (typeof window === "undefined") return () => { /* noop */ };
    const handler = () => callback();
    window.addEventListener(EVENT, handler);
    window.addEventListener("storage", handler);
    return () => {
        window.removeEventListener(EVENT, handler);
        window.removeEventListener("storage", handler);
    };
}
