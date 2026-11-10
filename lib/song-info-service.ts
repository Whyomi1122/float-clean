// 歌曲资料（联网检索）
//
// 起因：一起听放韩语歌时，角色只能看到歌词原文，凭歌名猜主题经常跑偏
// （例：Zico《Actually》其实是「从一开始就不想只做朋友 / 你的良缘绝不是他」的对锤歌）。
//
// 做法：复用聊天工具箱里的「搜索」工具（Tavily）的 API Key，在切歌时后台搜一次
// 「歌手 + 歌名 + 歌词含义/背景」，把答案摘要缓存到本地，之后每轮注入给角色。
// 没有 Key、网络失败、超时都静默跳过——绝不阻塞聊天。

import { loadRestTools } from "./tool-storage";
import { kvGet, kvSet } from "./kv-db";

const CACHE_KEY = "ai_phone_song_info_v1";
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;   // 资料 30 天内复用
const FAIL_BACKOFF = 60 * 60 * 1000;        // 失败后 1 小时内不再重试
const SUMMARY_LIMIT = 700;

interface SongInfoRecord {
    summary: string;
    fetchedAt: number;
    failedAt?: number;
}

type SongInfoCache = Record<string, SongInfoRecord>;

function readCache(): SongInfoCache {
    if (typeof window === "undefined") return {};
    try {
        const raw = kvGet(CACHE_KEY);
        return raw ? (JSON.parse(raw) as SongInfoCache) : {};
    } catch {
        return {};
    }
}

function writeCache(cache: SongInfoCache): void {
    if (typeof window === "undefined") return;
    try {
        kvSet(CACHE_KEY, JSON.stringify(cache));
    } catch { /* 配额满就算了 */ }
}

function cacheKeyOf(title: string, artist: string): string {
    return `${(title || "").trim().toLowerCase()}|${(artist || "").trim().toLowerCase()}`;
}

/** 从聊天工具箱的「搜索」工具里取 Tavily Key（没配就返回空串）。 */
function resolveSearchApiKey(): string {
    try {
        const tools = loadRestTools();
        const search = tools.find(t => t.endpoint.includes("tavily.com"))
            || tools.find(t => t.id === "builtin_search");
        const key = (search?.fixedParams?.api_key || "").trim();
        return key;
    } catch {
        return "";
    }
}

/** 已缓存的歌曲资料（同步，供提示词注入用）。 */
export function getSongInfo(title: string, artist: string): string {
    if (!title) return "";
    const hit = readCache()[cacheKeyOf(title, artist)];
    return hit?.summary || "";
}

function buildSummary(payload: unknown): string {
    if (!payload || typeof payload !== "object") return "";
    const data = payload as { answer?: string; results?: Array<{ title?: string; content?: string }> };
    const parts: string[] = [];
    const answer = (data.answer || "").trim();
    if (answer) parts.push(answer);
    for (const item of (data.results || []).slice(0, 3)) {
        const content = (item.content || "").trim();
        if (!content) continue;
        // 跳过和答案高度重复的片段
        if (answer && answer.includes(content.slice(0, 40))) continue;
        parts.push(content.slice(0, 240));
    }
    const merged = parts.join("\n").trim();
    return merged.length > SUMMARY_LIMIT ? `${merged.slice(0, SUMMARY_LIMIT)}…` : merged;
}

/**
 * 确保这首歌的资料已缓存（有缓存直接返回；没有就联网搜一次）。
 * 返回资料摘要，拿不到就返回空串。
 */
export async function ensureSongInfo(title: string, artist: string): Promise<string> {
    if (!title) return "";
    const key = cacheKeyOf(title, artist);
    const cache = readCache();
    const hit = cache[key];
    const now = Date.now();
    if (hit?.summary && now - hit.fetchedAt < MAX_AGE) return hit.summary;
    if (hit?.failedAt && now - hit.failedAt < FAIL_BACKOFF) return hit.summary || "";

    const apiKey = resolveSearchApiKey();
    if (!apiKey) return hit?.summary || "";

    const query = `${artist} ${title} 这首歌 歌词含义 主题 背景`;
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const resp = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                api_key: apiKey,
                query,
                search_depth: "basic",
                include_answer: true,
                max_results: 3,
            }),
            signal: controller.signal,
        }).finally(() => clearTimeout(timer));
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        const summary = buildSummary(data);
        if (!summary) throw new Error("empty summary");
        cache[key] = { summary, fetchedAt: now };
        writeCache(cache);
        return summary;
    } catch {
        cache[key] = { summary: hit?.summary || "", fetchedAt: hit?.fetchedAt || 0, failedAt: now };
        writeCache(cache);
        return hit?.summary || "";
    }
}
