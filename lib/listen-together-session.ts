// lib/listen-together-session.ts — 一起听的"会话状态"
//
// 2026-11-09 用户口径（重要）：
//   一起听不是另一个界面，而是**聊天室里的一个状态**。开始后照常在这个聊天室聊天，
//   顶部多一条状态条（正在放的歌 + 上一首/播放/下一首 + 结束），聊的内容直接进主聊天记录。
//   结束**只由用户手动点**，切 App / 关页面都不会自动结束。

const STORAGE_KEY = "ai_phone_listen_session_v1";
const EVENT = "float:listen-session";

export type ListenSession = {
    characterId: string;
    startedAt: string;
};

function emit() {
    if (typeof window === "undefined") return;
    try { window.dispatchEvent(new Event(EVENT)); } catch { /* ignore */ }
}

export function getListenSession(): ListenSession | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<ListenSession>;
        if (!parsed?.characterId) return null;
        return {
            characterId: parsed.characterId,
            startedAt: parsed.startedAt || new Date().toISOString(),
        };
    } catch {
        return null;
    }
}

export function startListenSession(characterId: string): ListenSession {
    const session: ListenSession = { characterId, startedAt: new Date().toISOString() };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(session)); } catch { /* ignore */ }
    emit();
    return session;
}

export function endListenSession(): void {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    emit();
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
