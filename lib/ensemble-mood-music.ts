// 他的心情音乐 —— 群像剧情室专用
// 流程：用户写一句指令 → 模型把最近剧情总结成 ≤200 字梗概 + 情绪词 + 搜索词
//        → 网易云搜歌 → 最多 4 首预览 → 存成一条记录卡（可重听 / 换一批）

import { simpleLLMCall } from "@/lib/api-helpers";
import type { ApiConfig } from "@/lib/settings-types";
import { searchNetease, type NeteaseSearchResult } from "@/lib/music-service";
import type { MusicTrack } from "@/lib/music-storage";

export type MoodMusicTrack = {
    trackId: string;
    title: string;
    artist: string;
    album?: string;
    coverUrl?: string;
    durationMs?: number;
};

export type MoodMusicStatus = "running" | "done" | "failed";

export type MoodMusicRecord = {
    id: string;
    scriptId: string;
    scriptTitle?: string;
    instruction: string;
    summary: string;
    mood: string;
    tracks: MoodMusicTrack[];
    status: MoodMusicStatus;
    error?: string;
    createdAt: string;
};

const KEY_PREFIX = "ai_phone_mood_music_v1_";
const MAX_RECORDS = 20;
export const MOOD_TRACK_LIMIT = 4;

// ── 存储 ──

export function loadMoodRecords(scriptId: string): MoodMusicRecord[] {
    if (typeof window === "undefined" || !scriptId) return [];
    try {
        const raw = window.localStorage.getItem(KEY_PREFIX + scriptId);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as MoodMusicRecord[]) : [];
    } catch {
        return [];
    }
}

function saveMoodRecords(scriptId: string, records: MoodMusicRecord[]): void {
    if (typeof window === "undefined" || !scriptId) return;
    try {
        window.localStorage.setItem(KEY_PREFIX + scriptId, JSON.stringify(records.slice(0, MAX_RECORDS)));
    } catch (err) {
        console.warn("[MoodMusic] 保存失败:", err);
    }
}

function updateMoodRecord(scriptId: string, id: string, patch: Partial<MoodMusicRecord>): void {
    const list = loadMoodRecords(scriptId);
    const next = list.map(item => (item.id === id ? { ...item, ...patch } : item));
    saveMoodRecords(scriptId, next);
    emit(scriptId);
}

export function removeMoodRecord(scriptId: string, id: string): void {
    const next = loadMoodRecords(scriptId).filter(item => item.id !== id);
    saveMoodRecords(scriptId, next);
    emit(scriptId);
}

export function setMoodRecordTracks(scriptId: string, id: string, tracks: MoodMusicTrack[]): void {
    updateMoodRecord(scriptId, id, { tracks: tracks.slice(0, MOOD_TRACK_LIMIT) });
}

// ── 订阅（生成在后台跑完时刷新界面） ──

const listeners = new Set<(scriptId: string) => void>();

export function subscribeMoodMusic(listener: (scriptId: string) => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

function emit(scriptId: string): void {
    listeners.forEach(listener => {
        try { listener(scriptId); } catch { /* ignore */ }
    });
}

// ── 工具 ──

function toMoodTrack(result: NeteaseSearchResult): MoodMusicTrack {
    return {
        trackId: `netease_${result.id}`,
        title: result.name,
        artist: result.artists || "未知歌手",
        album: result.album,
        coverUrl: result.coverUrl,
        durationMs: result.duration,
    };
}

export function moodTrackToMusicTrack(track: MoodMusicTrack): MusicTrack {
    return {
        id: track.trackId,
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration: (track.durationMs ?? 0) / 1000,
        coverUrl: track.coverUrl,
        liked: false,
        addedAt: new Date().toISOString(),
    };
}

/** 把最近剧情拼成一段文字（从最新往前取，够了就停） */
export function buildPlotText(
    turns: Array<{ senderName?: string; content?: string }>,
    maxChars = 4000,
): string {
    const lines: string[] = [];
    let total = 0;
    for (let i = turns.length - 1; i >= 0; i--) {
        const turn = turns[i];
        const text = (turn.content ?? "").trim();
        if (!text) continue;
        const line = turn.senderName ? `${turn.senderName}：${text}` : text;
        if (total + line.length > maxChars && lines.length > 0) break;
        lines.unshift(line);
        total += line.length;
    }
    return lines.join("\n");
}

// ── 第一步：让模型给梗概 + 情绪 + 搜索词 ──

const PLAN_SYSTEM = `你是配乐编辑,要为一个角色的「此刻心情」配 4 首歌。
根据给出的剧情片段和用户指令,输出 JSON(只输出 JSON,不要 markdown 代码块,不要解释):
{"summary":"200字以内的这段剧情梗概","mood":"2-4个情绪词,用顿号分隔","queries":["搜索词1","搜索词2","搜索词3","搜索词4","搜索词5","搜索词6"]}

要求:
- summary 用第三人称概括剧情发生了什么、角色此刻的状态,不超过 200 字。
- queries 是给网易云音乐搜索用的词,每条不超过 14 个字;
- queries 里至少 1 条写「歌手 + 歌名」的具体歌,其余写「风格 + 语种」或「情绪 + 风格」;
- 风格要有变化但整体贴合情绪,不要全是一个歌手的歌;
- 不要写"推荐""歌单"这类无意义词。`;

type MoodPlan = { summary: string; mood: string; queries: string[] };

function parsePlan(raw: string): MoodPlan | null {
    const text = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
        const obj = JSON.parse(text.slice(start, end + 1));
        const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
        const mood = typeof obj.mood === "string" ? obj.mood.trim() : "";
        const queries = Array.isArray(obj.queries)
            ? obj.queries.map((q: unknown) => String(q ?? "").trim()).filter(Boolean).slice(0, 8)
            : [];
        if (!queries.length) return null;
        return { summary: summary.slice(0, 220), mood, queries };
    } catch {
        return null;
    }
}

async function requestMoodPlan(
    config: ApiConfig,
    plotText: string,
    instruction: string,
): Promise<MoodPlan | null> {
    const userContent = [
        instruction.trim() ? `用户指令：${instruction.trim()}` : "用户指令：根据这段剧情给他配一组心情音乐",
        "",
        "剧情片段：",
        plotText || "（暂无剧情内容，请按用户指令自由发挥）",
    ].join("\n");

    const res = await simpleLLMCall(
        config,
        [
            { role: "system", content: PLAN_SYSTEM },
            { role: "user", content: userContent },
        ],
        { max_tokens: 900, temperature: 0.8, label: "心情音乐" },
    );
    if (!res.content) return null;
    return parsePlan(res.content);
}

// ── 第二步：搜歌 ──

async function searchMoodTracks(
    queries: string[],
    excludeIds: Set<string>,
    need: number,
): Promise<MoodMusicTrack[]> {
    const out: MoodMusicTrack[] = [];
    for (const query of queries) {
        if (out.length >= need) break;
        try {
            const results = await searchNetease(query, 6);
            for (const result of results) {
                const track = toMoodTrack(result);
                if (excludeIds.has(track.trackId)) continue;
                if (out.some(item => item.trackId === track.trackId)) continue;
                out.push(track);
                break; // 一个搜索词只取一首，保证风格有变化
            }
        } catch (err) {
            console.warn("[MoodMusic] 搜索失败:", query, err);
        }
    }
    return out;
}

// ── 生成任务（离开页面也会继续跑完） ──

export type StartMoodMusicParams = {
    scriptId: string;
    scriptTitle?: string;
    config: ApiConfig;
    plotText: string;
    instruction: string;
};

export function startMoodMusicJob(params: StartMoodMusicParams): MoodMusicRecord {
    const record: MoodMusicRecord = {
        id: `mood_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        scriptId: params.scriptId,
        scriptTitle: params.scriptTitle,
        instruction: params.instruction,
        summary: "",
        mood: "",
        tracks: [],
        status: "running",
        createdAt: new Date().toISOString(),
    };
    saveMoodRecords(params.scriptId, [record, ...loadMoodRecords(params.scriptId)]);
    emit(params.scriptId);

    void (async () => {
        try {
            const plan = await requestMoodPlan(params.config, params.plotText, params.instruction);
            if (!plan) {
                updateMoodRecord(params.scriptId, record.id, {
                    status: "failed",
                    error: "模型没有返回可用的配乐方案",
                });
                return;
            }
            const tracks = await searchMoodTracks(plan.queries, new Set(), MOOD_TRACK_LIMIT);
            updateMoodRecord(params.scriptId, record.id, {
                status: tracks.length ? "done" : "failed",
                summary: plan.summary,
                mood: plan.mood,
                tracks,
                error: tracks.length ? undefined : "没搜到能用的歌，换个说法再试一次",
            });
        } catch (err) {
            console.warn("[MoodMusic] 生成失败:", err);
            updateMoodRecord(params.scriptId, record.id, {
                status: "failed",
                error: err instanceof Error ? err.message : "生成失败",
            });
        }
    })();

    return record;
}

/** 「换一批」：保留梗概和情绪，只重新搜歌；总数始终不超过 4 首 */
export async function refreshMoodRecord(record: MoodMusicRecord, config: ApiConfig): Promise<void> {
    updateMoodRecord(record.scriptId, record.id, { status: "running", error: undefined, tracks: [] });
    try {
        const plan = record.summary
            ? { summary: record.summary, mood: record.mood, queries: [] as string[] }
            : null;
        const queries = plan?.queries.length
            ? plan.queries
            : await (async () => {
                const fresh = await requestMoodPlan(config, record.summary, record.instruction);
                return fresh?.queries ?? [];
            })();
        const keepIds = new Set(record.tracks.map(item => item.trackId));
        const tracks = await searchMoodTracks(queries, keepIds, MOOD_TRACK_LIMIT);
        updateMoodRecord(record.scriptId, record.id, {
            status: tracks.length ? "done" : "failed",
            tracks,
            error: tracks.length ? undefined : "没搜到别的歌了",
        });
    } catch (err) {
        updateMoodRecord(record.scriptId, record.id, {
            status: "failed",
            error: err instanceof Error ? err.message : "换一批失败",
        });
    }
}

/** 删掉一首后补到 4 首（只会补到 4，不会更多） */
export async function refillMoodRecord(record: MoodMusicRecord, config: ApiConfig): Promise<void> {
    if (record.tracks.length >= MOOD_TRACK_LIMIT) return;
    try {
        const plan = await requestMoodPlan(config, record.summary, record.instruction);
        if (!plan) return;
        const exclude = new Set(record.tracks.map(item => item.trackId));
        const extra = await searchMoodTracks(plan.queries, exclude, MOOD_TRACK_LIMIT - record.tracks.length);
        if (!extra.length) return;
        const latest = loadMoodRecords(record.scriptId).find(item => item.id === record.id);
        const base = latest?.tracks ?? record.tracks;
        const merged = [...base, ...extra.filter(e => !base.some(b => b.trackId === e.trackId))]
            .slice(0, MOOD_TRACK_LIMIT);
        updateMoodRecord(record.scriptId, record.id, { tracks: merged, status: "done" });
    } catch (err) {
        console.warn("[MoodMusic] 补歌失败:", err);
    }
}
