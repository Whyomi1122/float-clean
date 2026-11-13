// lib/story-clock.ts — 剧情时钟（2026-11-12 起，2026-11-13 升级为「按剧本分组」）
//
// 背景：群像剧情走到 07-19 晚（或 2024-08-11），但普通聊天、归档全按现实时间走，
// 归档把群像的锚点喂进去之后日期还是对不上，等于白喂。
//
// 做法：不改任何已有时间戳，只存**偏移量**。
//   · 剧情时间 = 真实时间 + offsetMs
//   · 历史消息仍存真实时间戳，显示和 AI 上下文统一用 toStoryDate()/getStoryNow() 换算
//   · 没设置过 offset 时为 0，行为和以前完全一样
//
// 2026-11-13 升级（用户提的「按剧本分组」）：
//   同一剧本的角色共享同一条时间线（同一场戏里不可能一个人 07-19、另一个人 11-13），
//   真正需要分开的是**不同剧本**。所以存储从「一条偏移」变成：
//     { default: 偏移, byScript: { [scriptId]: 偏移 } }
//   角色 → 剧本 的映射由 lib/story-scope.ts 从群像归档的 metadata 里同步过来。
export const STORAGE_KEY = "ai_phone_story_clock_v2";
/** 老版本（只有一条全局偏移）的 key，读到就迁移成 default */
export const LEGACY_STORAGE_KEY = "ai_phone_story_clock_v1";
const EVENT = "float:story-clock";

export interface StoryClock {
    /** 剧情时间 = 真实时间 + offsetMs（毫秒，可为负=剧情在过去） */
    offsetMs: number;
    updatedAt: string;
}

/** null = 默认时间线（不属于任何剧本的角色、群聊兜底） */
export type StoryScope = string | null;

interface StoryClockState {
    default: StoryClock;
    byScript: Record<string, StoryClock>;
}

const EMPTY_CLOCK: StoryClock = { offsetMs: 0, updatedAt: "" };
const EMPTY_STATE: StoryClockState = { default: EMPTY_CLOCK, byScript: {} };

function normalizeClock(value: Partial<StoryClock> | null | undefined): StoryClock {
    const offsetMs = typeof value?.offsetMs === "number" && Number.isFinite(value.offsetMs) ? value.offsetMs : 0;
    return { offsetMs, updatedAt: String(value?.updatedAt || "") };
}

function readState(): StoryClockState {
    if (typeof window === "undefined") return EMPTY_STATE;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as Partial<StoryClockState> & Partial<StoryClock>;
            // 兼容「直接把 { offsetMs } 存在 v2 key 上」的早期形态
            const inline = typeof parsed?.offsetMs === "number" ? normalizeClock(parsed as StoryClock) : null;
            const def = inline ?? normalizeClock((parsed as StoryClockState).default);
            const byScript: Record<string, StoryClock> = {};
            const rawByScript = (parsed as StoryClockState).byScript;
            if (rawByScript && typeof rawByScript === "object") {
                Object.entries(rawByScript).forEach(([key, value]) => {
                    if (!key) return;
                    const clock = normalizeClock(value as StoryClock);
                    if (clock.offsetMs !== 0) byScript[key] = clock;
                });
            }
            return { default: def, byScript };
        }
        const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (legacyRaw) {
            const parsed = JSON.parse(legacyRaw) as Partial<StoryClock>;
            return { default: normalizeClock(parsed), byScript: {} };
        }
    } catch {
        /* ignore */
    }
    return EMPTY_STATE;
}

// 读取很频繁（聊天列表每一行都会换算时间），缓存一份，写入时更新
let cachedState: StoryClockState | null = null;

function getState(): StoryClockState {
    if (!cachedState) cachedState = readState();
    return cachedState;
}

function writeState(state: StoryClockState) {
    cachedState = state;
    if (typeof window !== "undefined") {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch {
            /* ignore */
        }
    }
    emit();
}

// ── 当前生效的剧本 scope ─────────────────────────────────────────────
// 生成回复 / 归档这类「一次性长流程」里，很多换算点拿不到 characterId，
// 就在流程入口 setActiveStoryScope() 一次，内部统一走它。
let activeScope: StoryScope = null;

export function setActiveStoryScope(scope: StoryScope) {
    activeScope = scope;
}

export function getActiveStoryScope(): StoryScope {
    return activeScope;
}

export function withStoryScope<T>(scope: StoryScope, run: () => T): T {
    const previous = activeScope;
    activeScope = scope;
    try {
        return run();
    } finally {
        activeScope = previous;
    }
}

function resolveScope(scope?: StoryScope): StoryScope {
    return scope === undefined ? activeScope : scope;
}

// ── 读取 ─────────────────────────────────────────────────────────────

export function getStoryClock(scope?: StoryScope): StoryClock {
    const state = getState();
    const key = resolveScope(scope);
    if (key && state.byScript[key]) return state.byScript[key];
    return state.default;
}

export function getStoryOffset(scope?: StoryScope): number {
    return getStoryClock(scope).offsetMs;
}

/** 是否启用剧情时钟（offset 非 0） */
export function isStoryClockActive(scope?: StoryScope): boolean {
    return getStoryOffset(scope) !== 0;
}

/** 当前剧情时间 */
export function getStoryNow(scope?: StoryScope): Date {
    return new Date(Date.now() + getStoryOffset(scope));
}

/** 把任意真实时间戳（消息 createdAt 等）换算成剧情时间 */
export function toStoryDate(value: number | string | Date | undefined | null, scope?: StoryScope): Date {
    const base = value instanceof Date
        ? value.getTime()
        : typeof value === "number"
            ? value
            : value
                ? new Date(value).getTime()
                : Date.now();
    return new Date((Number.isFinite(base) ? base : Date.now()) + getStoryOffset(scope));
}

/** 列出所有已设置的时间线：第一项一定是默认线（scope = null） */
export function listStoryClockScopes(): { scope: StoryScope; offsetMs: number }[] {
    const state = getState();
    return [
        { scope: null, offsetMs: state.default.offsetMs },
        ...Object.keys(state.byScript).map(key => ({ scope: key, offsetMs: state.byScript[key].offsetMs })),
    ];
}

// ── 写入 ─────────────────────────────────────────────────────────────

function emit() {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(EVENT));
}

/** 直接设定某条时间线的偏移（毫秒），0 = 这条线回到现实时间 */
export function setStoryOffset(offsetMs: number, scope?: StoryScope) {
    if (typeof window === "undefined" || !Number.isFinite(offsetMs)) return;
    const state = getState();
    const key = resolveScope(scope);
    const clock: StoryClock = { offsetMs, updatedAt: new Date().toISOString() };
    if (!key) {
        writeState({ default: clock, byScript: { ...state.byScript } });
        return;
    }
    const byScript = { ...state.byScript };
    if (offsetMs === 0) delete byScript[key];
    else byScript[key] = clock;
    writeState({ default: state.default, byScript });
}

/** 把某条时间线拨到「剧情里现在是 target」 */
export function setStoryNow(target: Date, scope?: StoryScope) {
    if (!(target instanceof Date) || Number.isNaN(target.getTime())) return;
    setStoryOffset(target.getTime() - Date.now(), scope);
}

/** 清掉某条时间线（scope 省略/null = 默认线；传了剧本 id 只清那条剧本） */
export function clearStoryClock(scope?: StoryScope) {
    setStoryOffset(0, resolveScope(scope));
}

/** 清掉全部时间线（默认 + 所有剧本） */
export function clearAllStoryClocks() {
    if (typeof window === "undefined") return;
    try {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
        /* ignore */
    }
    cachedState = null;
    emit();
}

export function subscribeStoryClock(handler: () => void): () => void {
    if (typeof window === "undefined") return () => { /* noop */ };
    // 别的标签页/老的 v1 写入后，让缓存失效
    const wrapped = () => {
        cachedState = readState();
        handler();
    };
    window.addEventListener(EVENT, wrapped);
    return () => window.removeEventListener(EVENT, wrapped);
}

// ── 群像「当前锚点」文本解析 ─────────────────────────────────────────

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
