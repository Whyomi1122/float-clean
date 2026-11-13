import { getStoryNow, toStoryDate, type StoryScope } from "./story-clock";

const WEEKDAY_NAMES = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

function padTwo(n: number): string {
    return n < 10 ? `0${n}` : `${n}`;
}

/**
 * 聊天界面时间文案。
 * scope = 该聊天所属剧本（2026-11-13 起按剧本分线；不传则用当前生效的时间线）
 */
export function formatChatUiTime(dateStr: string, scope?: StoryScope): string {
    // 剧情时钟（2026-11-12）：界面时间一律按剧情时间显示；没设置过偏移时与以前完全一致
    const date = toStoryDate(new Date(dateStr), scope);
    if (Number.isNaN(date.getTime())) return "";

    const now = getStoryNow(scope);
    const hhmm = `${padTwo(date.getHours())}:${padTwo(date.getMinutes())}`;

    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterdayStart = new Date(todayStart.getTime() - 86400000);

    if (date.getTime() >= todayStart.getTime()) {
        return hhmm;
    }
    if (date.getTime() >= yesterdayStart.getTime()) {
        return `昨天 ${hhmm}`;
    }

    const sevenDaysAgo = new Date(todayStart.getTime() - 6 * 86400000);
    if (date.getTime() >= sevenDaysAgo.getTime()) {
        return `${WEEKDAY_NAMES[date.getDay()]} ${hhmm}`;
    }

    if (date.getFullYear() === now.getFullYear()) {
        return `${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`;
    }

    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`;
}
