// lib/listen-together-storage.ts — 一起听会话存储(轻量独立,不进 chat App 列表)
//
// 每个角色一份消息历史(localStorage),记录"我们的听歌日记":
// 角色对歌的短评、用户的回复、(二期)角色排的歌卡。

export type ListenMessage = {
    id: string;
    /** "user" | "char" */
    role: "user" | "char";
    text: string;
    /** 角色消息附带的歌卡(TA 排的歌/推荐的歌) */
    songCard?: { title: string; artist: string; note?: string };
    createdAt: string;
};

const KEY_PREFIX = "ai_phone_listen_together_msgs_v1_";

export function loadListenMessages(characterId: string): ListenMessage[] {
    try {
        const raw = localStorage.getItem(KEY_PREFIX + characterId);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export function appendListenMessage(characterId: string, msg: ListenMessage): void {
    try {
        const list = loadListenMessages(characterId);
        list.push(msg);
        // 上限 300 条,防止无限膨胀
        if (list.length > 300) list.splice(0, list.length - 300);
        localStorage.setItem(KEY_PREFIX + characterId, JSON.stringify(list));
    } catch { /* ignore */ }
}

export function clearListenMessages(characterId: string): void {
    try {
        localStorage.removeItem(KEY_PREFIX + characterId);
    } catch { /* ignore */ }
}

export function genListenMsgId(): string {
    return `lt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
