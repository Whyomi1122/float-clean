// 他的心情音乐 —— 群像剧情室专用
// 流程：用户写一句指令 → 模型把最近剧情总结成 ≤200 字梗概 + 情绪词 + 搜索词
//        → 网易云搜歌 → 最多 4 首预览 → 存成一条记录卡（可重听 / 换一批）

import { simpleLLMCall } from "@/lib/api-helpers";
import type { ApiConfig } from "@/lib/settings-types";
import { loadBindingConfig, resolveAuxiliaryApiConfig } from "@/lib/settings-storage";
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
- 先根据剧情定 2-4 个情绪词(mood),queries 必须由这些情绪词推导出来。
- queries 是给网易云音乐搜索用的词,每条不超过 14 个字;
- queries 里至少 2 条写「歌手 + 歌名」的具体歌,其余写「风格 + 语种」或「情绪 + 风格」;
- 具体歌名必须是**真实存在**的歌,不许编;选知名度和曲风都稳的歌(抒情/独立/影视原声一类);
- **贴的是此刻的场景与处境,不是歌词的字面主题**:海边度假就别推「离别」「被抛弃」「怀念亡者」那类苦情歌,除非剧情本身正在讲这件事;
- **先自检一遍再交**:当下是「松弛、被守护、默契」就别出「两清」「撕心裂肺」「分手」这种情绪相反的歌,宁可换一首更平的同调歌;
- **剧情是韩国语境时**(韩语人名、韩语台词、韩国地名)具体歌优先给**韩国歌手原曲**,不要拿中文流行歌凑;
- **韩国语境时 queries 里至少 3 条直接写韩文**(韩文歌名或韩国歌手名,如「아이유」,网易云支持韩文搜索),不要全用中文词搜韩语歌;
- 每首具体歌都要能对上 mood 里的某个情绪词、或剧情里的一个具体细节;给不出对应关系的歌不要选(2026-11-19 实机:「轻松默契被守护」的海边剧情配了「平凡之路」「安和桥」,都是怀旧漂泊主题,不算贴);
- 不要游戏原声、厂牌歌手(如「网易游戏」)、纯音乐合集;
- 不要古风、网络热歌、DJ remix、纯音乐合集、「100首伤感情歌」这种拼盘;
- 语种跟着剧情走:剧情主要是韩语就多给韩语歌,中文就多给中文歌,不要混成随机大杂烩;
- 风格要有变化但整体贴合同一层情绪,不要全是一个歌手的歌;
- 不要写"推荐""歌单"这类无意义词。`;

type MoodPlan = { summary: string; mood: string; queries: string[] };

/** 剧情里韩文占比高就优先韩语歌（用户的群像剧本大量是韩语语境） */
function detectLanguageHint(plotText: string): string {
    const hangul = (plotText.match(/[\uAC00-\uD7AF]/g) || []).length;
    const han = (plotText.match(/[\u4E00-\u9FFF]/g) || []).length;
    if (hangul > 0 && hangul * 2 >= han) return "韩语为主";
    // 2026-11-19 实机：剧情梗概常常是中文写的（如「江原道海边别庄」），韩文人名/地名/公司名出现也算韩国语境，
    // 否则会被误判成「中文为主」、歌单全变华语。
    const koreanContext = /首尔|釜山|江原道|济州|仁川|大邱|光州|韩国|韩语|韩文|K-?pop|Korean|KTX|弘大|江南|清潭|狎鸥亭/i.test(plotText);
    if (koreanContext) return "韩国语境（剧情背景在韩国、角色是韩国人）：必须优先韩国歌手原曲";
    if (han > 0) return "中文为主";
    return "";
}

function parsePlan(raw: string): MoodPlan | null {
    const text = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
    // 兼容：整体数组 / {data:{...}} / queries 写成字符串
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    const candidate = start >= 0 && end > start ? text.slice(start, end + 1) : text;
    let obj: Record<string, unknown> | null = null;
    try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            obj = parsed as Record<string, unknown>;
            const nested = obj.data ?? obj.result ?? obj.plan;
            if (nested && typeof nested === "object" && !Array.isArray(nested)) {
                obj = nested as Record<string, unknown>;
            }
        }
    } catch {
        obj = null;
    }

    const summary = obj && typeof obj.summary === "string" ? obj.summary.trim() : "";
    const mood = obj && typeof obj.mood === "string" ? obj.mood.trim() : "";

    let queries: string[] = [];
    const rawQueries = obj?.queries ?? obj?.songs ?? obj?.keywords;
    if (Array.isArray(rawQueries)) {
        queries = rawQueries.map((q: unknown) => String(q ?? "").trim()).filter(Boolean);
    } else if (typeof rawQueries === "string") {
        // 模型有时给「A、B、C」或「A, B, C」
        queries = rawQueries.split(/[、,，;；/\n]+/).map(s => s.trim()).filter(Boolean);
    }
    if (queries.length === 0) {
        // 最后兜底：从「queries」字段之后抓所有引号内容
        const tail = text.slice(Math.max(0, text.indexOf("queries")));
        const quoted = tail.match(/["“]([^"”\n]{2,20})["”]/g) || [];
        queries = quoted
            .map(q => q.replace(/["“”]/g, "").trim())
            .filter(q => q && q !== "queries" && !/^[:：,，]$/.test(q));
    }
    queries = queries.slice(0, 8);
    if (!queries.length) return null;
    return { summary: summary.slice(0, 220), mood, queries };
}

/**
 * 配乐用哪个模型：绑定页「心情音乐 API」配了就优先用它（可以挑便宜的），
 * 没配就沿用群像剧本自己的模型 —— 与以前行为一致。
 */
function resolveMoodConfig(fallback: ApiConfig): ApiConfig {
    try {
        if (!loadBindingConfig().moodMusicApiConfigId) return fallback;
        return resolveAuxiliaryApiConfig("moodMusicApiConfigId") ?? fallback;
    } catch {
        return fallback;
    }
}

async function requestMoodPlan(
    config: ApiConfig,
    plotText: string,
    instruction: string,
): Promise<MoodPlan | null> {
    config = resolveMoodConfig(config);
    const langHint = detectLanguageHint(plotText);
    const userContent = [
        instruction.trim() ? `用户指令：${instruction.trim()}` : "用户指令：根据这段剧情给他配一组心情音乐",
        langHint ? `剧情语种判定：${langHint}。选歌、搜索词的语种都跟着这个走，违者整单作废。` : "",
        "",
        "剧情片段：",
        plotText || "（暂无剧情内容，请按用户指令自由发挥）",
    ].filter(Boolean).join("\n");

    // 有些模型（带思维链的）会把 max_tokens 全花在思考上，content 直接为空；
    // 所以给足额度，并在解析失败时再要一次（明确要求「不要思考过程」）。
    const ask = async (strict: boolean) => {
        const res = await simpleLLMCall(
            config,
            [
                { role: "system", content: strict ? `${PLAN_SYSTEM}\n\n再次强调：直接输出 JSON 本体，不要任何思考过程或说明文字。` : PLAN_SYSTEM },
                { role: "user", content: userContent },
            ],
            { max_tokens: 1600, temperature: strict ? 0.6 : 0.8, label: "心情音乐" },
        );
        return res.content ?? "";
    };

    const first = parsePlan(await ask(false));
    if (first) return first;
    try {
        return parsePlan(await ask(true));
    } catch (err) {
        console.warn("[MoodMusic] 重试仍失败:", err);
        return null;
    }
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
            // 搜索词里带了歌名/歌手时，别被同名翻唱或翻唱歌单骗走：
            // 优先挑「歌名或歌手出现在搜索词里」的那条，都对不上才退回第一条。
            const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
            const q = norm(query);
            const scored = results
                .map((r, idx) => {
                    const title = norm(r.name || "");
                    const artist = norm(r.artists || "");
                    let score = 0;
                    if (title && q.includes(title)) score += 3;
                    if (artist && q.includes(artist)) score += 3;
                    if (title && title.length >= 2 && q.includes(title.replace(/[（）()\-—]/g, ""))) score += 1;
                    return { r, score, idx };
                })
                .sort((a, b) => (b.score - a.score) || (a.idx - b.idx));

            for (const candidate of scored) {
                const track = toMoodTrack(candidate.r);
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
