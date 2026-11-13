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

function defaultHourForScope(scope: string): number {
    if (scope === "凌晨") return 2;
    if (scope === "早上" || scope === "早晨" || scope === "早") return 8;
    if (scope === "上午") return 9;
    if (scope === "中午") return 12;
    if (scope === "午后" || scope === "下午") return 15;
    if (scope === "傍晚") return 18;
    if (scope === "白天") return 14;
    if (scope === "晚" || scope === "晚上" || scope === "夜里" || scope === "夜") return 20;
    return NaN;
}

/**
 * 从群像「当前锚点」文本里解析剧情日期时间，解析不到返回 null。
 * 2026-11-13 重写：实机锚点长这样，老正则只认 `07-19晚`，一律解析失败——
 *   当前锚点·2024-08-11 11:40后 ————
 *   时间：08-11周日上午11:40后。
 * 现在支持：完整日期（2024-08-11 / 2024年8月11日 / 2024/8/11）、MM-DD、MM月DD日、
 * 时段词（凌晨/早上/上午/中午/午后/下午/傍晚/晚上/夜里/白天）、`11:40后` 这类时刻。
 */
export function parseAnchorStoryTime(anchorText: string, now: Date = new Date()): Date | null {
    if (!anchorText) return null;

    let year: number | null = null;
    let month: number | null = null;
    let day: number | null = null;
    let rest = anchorText;

    const fullDate = anchorText.match(/(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})\s*日?/);
    if (fullDate) {
        year = Number(fullDate[1]);
        month = Number(fullDate[2]);
        day = Number(fullDate[3]);
        rest = anchorText.slice((fullDate.index || 0) + fullDate[0].length);
    } else {
        const monthDay = anchorText.match(/(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?/);
        if (!monthDay) return null;
        month = Number(monthDay[1]);
        day = Number(monthDay[2]);
        rest = anchorText.slice((monthDay.index || 0) + monthDay[0].length);
    }
    if (month === null || day === null) return null;
    if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;

    const clock = rest.match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
    const scopePattern = /(凌晨|早上|早晨|上午|中午|午后|下午|傍晚|晚上|夜里|白天|晚|早|夜)/;
    const beforeClock = clock ? rest.slice(0, clock.index || 0) : rest;
    const afterClock = clock ? rest.slice((clock.index || 0) + clock[0].length) : "";
    const scope = (beforeClock.match(scopePattern) || afterClock.match(scopePattern))?.[1] || "";

    let hour: number;
    let minute = 0;
    if (clock) {
        hour = Number(clock[1]);
        minute = Number(clock[2]);
        if (hour < 12 && (scope === "午后" || scope === "下午" || scope === "傍晚" || scope === "晚上" || scope === "夜里" || scope === "夜")) {
            hour += 12;
        } else if (hour === 12 && (scope === "凌晨" || scope === "夜" || scope === "夜里")) {
            hour = 0;
        }
    } else {
        const scoped = defaultHourForScope(scope);
        if (Number.isFinite(scoped)) {
            hour = scoped;
        } else {
            // 锚点只写了日期：保持当前的时刻，只把日期挪过去
            hour = now.getHours();
            minute = now.getMinutes();
        }
    }

    const result = new Date(year ?? now.getFullYear(), month - 1, day, hour, minute, 0, 0);
    // 没写年份时：剧情日期通常离现在不远，比现在晚 3 个月以上就当成去年
    if (year === null && result.getTime() - now.getTime() > 90 * 24 * 3600 * 1000) {
        result.setFullYear(result.getFullYear() - 1);
    }
    return Number.isNaN(result.getTime()) ? null : result;
}
