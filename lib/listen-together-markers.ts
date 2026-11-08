// lib/listen-together-markers.ts
//
// 一起听的 🎧 分隔线：把「开始 / 结束」写成一条系统消息存进聊天记录。
// 存记录而不是只画在界面上，是为了刷新、切回来之后还在——回看时能一眼认出
// 「这段话是听歌的时候说的」。渲染沿用系统消息那套居中灰字，不额外造样式。

import { loadChatContacts, loadChatSessions, createOrGetSession, pushChatMessage } from "./chat-storage";

function resolveSingleSession(characterId: string) {
    const contact = loadChatContacts().find(item => item.characterId === characterId);
    if (!contact) return null;
    const sessions = loadChatSessions().filter(item => item.contactId === contact.id && !item.isGroup);
    if (sessions.length === 0) return createOrGetSession(contact.id);
    // 多会话时挂到最近活跃的那个
    return sessions.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))[0];
}

/** kind: start=开始听，end=结束。找不到会话就静默跳过，绝不影响播放 */
export function appendListenMarker(characterId: string, kind: "start" | "end"): void {
    if (typeof window === "undefined" || !characterId) return;
    try {
        const session = resolveSingleSession(characterId);
        if (!session) return;
        const now = new Date();
        const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
        const content = kind === "start" ? `🎧 一起听 · ${time} 开始` : `🎧 一起听结束 · ${time}`;
        // 借用 music_notify：装配链里已明确跳过它，不会污染 AI 上下文；
        // 渲染走系统消息那套居中灰字，也不用新增样式分支。
        pushChatMessage({ sessionId: session.id, role: "system", content, mediaType: "music_notify" });
        window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId: session.id } }));
    } catch (err) {
        console.warn("[ListenMarker] 写入分隔线失败:", err);
    }
}
