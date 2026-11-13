// lib/story-clock.ts — 剧情时钟（2026-11-12，用户拍板「全局都用剧情时间」）
//
// 背景：群像剧情走到 07-19 晚，但普通聊天、归档全按现实时间（11-12）走，
// 归档把群像的锚点喂进去之后，日期还是对不上，等于白喂。
//
// 做法：不改任何已有时间戳，只加一个**偏移量**。
//   · 剧情时间 = 真实时间 + offsetMs
//   · 历史消息仍存真实时间戳，显示和 AI 上下文统一用 toStoryDate()/getStoryNow() 换算
//   · 没设置过 offset 时为 0，行为和以前完全一样（不会影响老用户）
//
// 用这个模块的地方（逐步接入）：
//   · 归档：标题日期、系统事实里的「本轮起止」
//   · AI 上下文：注入给模型的「现在是几点」
//   · 聊天界面：消息气泡时间、日期分隔

const STORAGE_KEY = "ai_phone_story_clock_v1";
const EVENT = "float:story-clock";

export interface StoryClock {
    /** 剧情时间 = 真实时间 + offsetMs（毫秒，可为负=剧情在过去） */
    offsetMs: number;
    updatedAt: string;
}

const EMPTY: StoryClock = { offsetMs: 0, updatedAt: "" };

export function getStoryClock(): StoryClock {
    if (typeof window === "undefined") return EMPTY;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return EMPTY;
        const parsed = JSON.parse(raw) as Partial<StoryClock>;
        if (typeof parsed?.offsetMs !== "number" || !Number.isFinite(parsed.offsetMs)) return EMPTY;
        return { offsetMs: parsed.offsetMs, updatedAt: parsed.updatedAt || "" };
    } catch {
        return EMPTY;
    }
}

export function getStoryOffset(): number {
    return getStoryClock().offsetMs;
}

/** 是否启用剧情时钟（offset 非 0） */
export function isStoryClockActive(): boolean {
    return getStoryOffset() !== 0;
}

/** 当前剧情时间 */
export function getStoryNow(): Date {
    return new Date(Date.now() + getStoryOffset());
}

/** 把任意真实时间戳（消息 createdAt 等）换算成剧情时间 */
export function toStoryDate(value: number | string | Date | undefined | null): Date {
    const base = value instanceof Date
        ? value.getTime()
        : typeof value === "number"
            ? value
            : value
                ? new Date(value).getTime()
                : Date.now();
    return new Date((Number.isFinite(base) ? base : Date.now()) + getStoryOffset());
}

function emit() {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(EVENT));
}

/** 把剧情时钟拨到「剧情里现在是 target」 */
export function setStoryNow(target: Date) {
    if (typeof window === "undefined") return;
    const offsetMs = target.getTime() - Date.now();
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ offsetMs, updatedAt: new Date().toISOString() } satisfies StoryClock));
    } catch { /* ignore */ }
    emit();
}

/** 直接设定偏移（毫秒），0 = 回到现实时间 */
export function setStoryOffset(offsetMs: number) {
    if (typeof window === "undefined") return;
    if (!Number.isFinite(offsetMs)) return;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ offsetMs, updatedAt: new Date().toISOString() } satisfies StoryClock));
    } catch { /* ignore */ }
    emit();
}

export function clearStoryClock() {
    if (typeof window === "undefined") return;
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    emit();
}

export function subscribeStoryClock(handler: () => void): () => void {
    if (typeof window === "undefined") return () => { /* noop */ };
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
}

/** 从群像「当前锚点」文本里解析剧情日期时间（如 `当前锚点 · 07-19晚`），返回 null 表示解析不到 */
export function parseAnchorStoryTime(anchorText: string, now: Date = new Date()): Date | null {
    if (!anchorText) return null;
    // 形如 07-19晚 / 07-19 晚 21:30 / 7/19 中午 / 07-19 白天
    const m = anchorText.match(/(\d{1,2})[-/月](\d{1,2})日?\s*(早|上午|中午|下午|傍晚|晚|晚上|夜里|凌晨|白天)?\s*(?:(\d{1,2})[:：](\d{2}))?/);
    if (!m) return null;
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;

    let hour = m[4] !== undefined ? Number(m[4]) : NaN;
    let minute = m[5] !== undefined ? Number(m[5]) : 0;
    if (!Number.isFinite(hour)) {
        const part = m[3] || "";
        if (part === "早" || part === "上午") hour = 9;
        else if (part === "中午") hour = 12;
        else if (part === "下午") hour = 15;
        else if (part === "傍晚") hour = 18;
        else if (part === "晚" || part === "晚上" || part === "夜里") hour = 20;
        else if (part === "凌晨") hour = 2;
        else hour = 20; // 白天/未指明：默认按晚上处理（剧情锚点常是傍晚之后）
    }
    if (hour >= 12 && (m[3] === "下午" || m[3] === "晚" || m[3] === "晚上" || m[3] === "夜里") && hour < 12) hour += 12;

    const year = now.getFullYear();
    const result = new Date(year, month - 1, day, hour, minute, 0, 0);
    // 剧情日期通常离现在不远；若解析出的日期比现在晚 3 个月以上，当成去年
    if (result.getTime() - now.getTime() > 90 * 24 * 3600 * 1000) {
        result.setFullYear(year - 1);
    }
    return result;
}
