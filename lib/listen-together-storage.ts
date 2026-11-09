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

// ── 队列归属:「这首是谁放的」 ──
// 只记归属，不另存队列本身——队列真源永远是 music-context。
export type ListenQueueMark = {
    trackId: string;
    /** user=你放的 / character=TA 排进来的 */
    by: "user" | "character";
    /** 角色放歌时顺带说的一句，显示在歌下面 */
    note?: string;
    addedAt: string;
};

const QUEUE_KEY_PREFIX = "ai_phone_listen_together_queue_v1_";

export function loadListenQueueMarks(characterId: string): ListenQueueMark[] {
    try {
        const raw = localStorage.getItem(QUEUE_KEY_PREFIX + characterId);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/** 同一首再次被放时覆盖旧的归属（后来的那次说了算） */
export function markListenQueueTrack(characterId: string, mark: ListenQueueMark): void {
    try {
        const list = loadListenQueueMarks(characterId).filter(item => item.trackId !== mark.trackId);
        list.push(mark);
        while (list.length > 80) list.shift();
        localStorage.setItem(QUEUE_KEY_PREFIX + characterId, JSON.stringify(list));
    } catch { /* ignore */ }
}

export function clearListenQueueMarks(characterId: string): void {
    try {
        localStorage.removeItem(QUEUE_KEY_PREFIX + characterId);
    } catch { /* ignore */ }
}

// ── 每天推歌上限（角色主动 [点歌]/[排队]） ──
// 用户口径：一天 8 首。调试期可在控制台设
//   localStorage.setItem("ai_phone_listen_push_limit", "30")
// 立刻生效；清掉这个键就回到默认 8。
export const LISTEN_DEFAULT_PUSH_LIMIT = 8;
const DAILY_KEY_PREFIX = "ai_phone_listen_together_daily_v1_";
const LIMIT_OVERRIDE_KEY = "ai_phone_listen_push_limit";

type DailyPush = { date: string; count: number };

function dayKey(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function getListenPushLimit(): number {
    try {
        const raw = localStorage.getItem(LIMIT_OVERRIDE_KEY);
        const n = raw ? Number(raw) : NaN;
        if (Number.isFinite(n) && n >= 0) return Math.floor(n);
    } catch { /* ignore */ }
    return LISTEN_DEFAULT_PUSH_LIMIT;
}

function loadDaily(characterId: string): DailyPush {
    try {
        const raw = localStorage.getItem(DAILY_KEY_PREFIX + characterId);
        if (!raw) return { date: dayKey(), count: 0 };
        const parsed = JSON.parse(raw) as DailyPush;
        if (!parsed || parsed.date !== dayKey()) return { date: dayKey(), count: 0 };
        return { date: parsed.date, count: Number(parsed.count) || 0 };
    } catch {
        return { date: dayKey(), count: 0 };
    }
}

export function getDailyPushCount(characterId: string): number {
    return loadDaily(characterId).count;
}

export function canPushToday(characterId: string): boolean {
    return getDailyPushCount(characterId) < getListenPushLimit();
}

/** 角色真的推了一首，记一笔 */
export function noteDailyPush(characterId: string): void {
    try {
        const cur = loadDaily(characterId);
        localStorage.setItem(
            DAILY_KEY_PREFIX + characterId,
            JSON.stringify({ date: dayKey(), count: cur.count + 1 } satisfies DailyPush),
        );
    } catch { /* ignore */ }
}

export function resetDailyPush(characterId: string): void {
    try {
        localStorage.removeItem(DAILY_KEY_PREFIX + characterId);
    } catch { /* ignore */ }
}
