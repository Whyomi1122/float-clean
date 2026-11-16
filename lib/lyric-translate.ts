/**
 * 歌词机翻（一起听 · 第 7 条）
 *
 * 网易云只对部分歌曲给官方中文翻译（`tlyric`），没有官翻的歌在播放器里就只有原文，
 * 中文用户看不懂也没法跟角色聊。这里在没有官翻时，用绑定的「思维链翻译 API」
 * （绑定 → AUXILIARY API，未设置时回退全局默认 API）把歌词机翻一遍。
 *
 * 约束（别改）：
 * - 只给**播放器显示**用：不进提示词、不进归档。机翻不保证准确，不能让角色拿它当事实。
 * - 按 songId 缓存进 localStorage（上限 80 首），同一首歌只花一次钱。
 * - 任何失败（没配 API / 超时 / 解析不出来）都静默返回原歌词，不打断播放、不弹错。
 */
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { simpleLLMCall } from "./api-helpers";

const LS_KEY = "ai_phone_lyric_mt_v1";
const CACHE_MAX = 80;
const TIMEOUT_MS = 45_000;

type Store = Record<string, { t: number; lrc: string }>;

function loadStore(): Store {
    if (typeof window === "undefined") return {};
    try {
        const raw = window.localStorage.getItem(LS_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? (parsed as Store) : {};
    } catch {
        return {};
    }
}

function saveStore(store: Store) {
    if (typeof window === "undefined") return;
    try {
        const keys = Object.keys(store);
        if (keys.length > CACHE_MAX) {
            keys.sort((a, b) => (store[a]?.t || 0) - (store[b]?.t || 0));
            for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete store[k];
        }
        window.localStorage.setItem(LS_KEY, JSON.stringify(store));
    } catch { /* 存不下就算了 */ }
}

/** 已机翻过的直接拿缓存（播放器同步渲染用，不触网） */
export function getCachedMachineLyrics(songId?: number): string {
    if (!songId) return "";
    return loadStore()[String(songId)]?.lrc || "";
}

/** 是否已经有中文（官方或机翻）：统一格式是「原文 ／ 译文」 */
function hasAnyTranslation(lrc: string): boolean {
    return lrc.includes(" ／ ");
}

const TIMED_LINE_RE = /^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/;
const CREDIT_RE = /^\s*(作词|作曲|编曲|制作人|监制|出品|发行|录音|混音|母带|吉他|贝斯|鼓|键盘|和声|弦乐|统筹|企划|lyrics?|words|composed|composer|arranged?|producer|mixed?|mastering)\b/i;

/** 抽出行号 → 待翻译正文（跳过制作信息行、纯符号行） */
function collectTranslatable(lrc: string): { lineIndex: number; text: string }[] {
    const out: { lineIndex: number; text: string }[] = [];
    const lines = lrc.split("\n");
    lines.forEach((raw, lineIndex) => {
        const m = raw.match(TIMED_LINE_RE);
        const text = (m ? m[3] : "").trim();
        if (!text || CREDIT_RE.test(text)) return;
        // 纯符号 / 纯标点 / 单字拟声词不值得翻
        if (!/[\p{L}]/u.test(text)) return;
        out.push({ lineIndex, text });
    });
    return out;
}

/** 判断到底需不需要机翻：主要看中文占比（韩语/日语/英语歌才翻） */
function needsTranslation(texts: string[]): boolean {
    const joined = texts.join("");
    if (!joined) return false;
    const han = (joined.match(/[\u4e00-\u9fff]/g) || []).length;
    const letters = (joined.match(/[\p{L}]/gu) || []).length || 1;
    return han / letters < 0.35;
}

function buildInstruction(): string {
    return [
        "你是歌词译者。把下面按行编号的歌词逐句翻译成自然、口语化的简体中文。",
        "",
        "铁律：",
        "- 逐句对应：输入的每一行都要有一条输出，编号必须与输入一致，不许合并、拆分、跳过或补写。",
        "- 只输出「编号. 译文」，不要任何解释、前言、标题或空行。",
        "- 原文已经是中文或用中文唱的行，原样输出。",
        "- 人名、品牌、拟声词照原样保留，不要硬译。",
        "- 不要押韵、不要润色成诗，意思对、读得顺即可。",
    ].join("\n");
}

/** 请求副 API 翻歌词，返回「行号 → 译文」 */
async function requestTranslation(texts: string[]): Promise<string[] | null> {
    const apiConfig = resolveAuxiliaryApiConfig("reasoningTranslateApiConfigId");
    if (!apiConfig) return null;

    const payload = texts.map((text, i) => `${i + 1}. ${text}`).join("\n");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const result = await simpleLLMCall(
            apiConfig,
            [{ role: "user", content: `${buildInstruction()}\n\n【歌词】\n${payload}` }],
            { temperature: 0.2, signal: controller.signal },
        );
        const content = (result.content || "").trim();
        if (!content) return null;
        const map = new Map<number, string>();
        for (const raw of content.split("\n")) {
            const m = raw.match(/^\s*(\d+)\s*[.．、):：]\s*(.+?)\s*$/);
            if (!m) continue;
            const idx = parseInt(m[1], 10);
            if (!Number.isFinite(idx) || idx < 1 || idx > texts.length) continue;
            const zh = m[2].trim();
            if (zh) map.set(idx, zh);
        }
        if (map.size < Math.max(1, Math.floor(texts.length * 0.6))) return null;
        return texts.map((_, i) => map.get(i + 1) || "");
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** 把译文按行号并回 LRC：同一行写成「原文 ／ 译文」 */
function mergeByLineIndex(lrc: string, entries: { lineIndex: number; zh: string }[]): string {
    const zhByLine = new Map<number, string>();
    for (const e of entries) if (e.zh) zhByLine.set(e.lineIndex, e.zh);
    const lines = lrc.split("\n");
    return lines
        .map((raw, i) => {
            const zh = zhByLine.get(i);
            if (!zh) return raw;
            const body = raw.replace(/\s+$/, "");
            return `${body} ／ ${zh}`;
        })
        .join("\n");
}

/**
 * 播放器用：拿到歌词后调这个，官翻缺失时自动机翻并缓存。
 * 失败一律返回原歌词（调用方不用 try/catch）。
 */
export async function withMachineLyrics(songId: number, lrc: string): Promise<string> {
    if (!songId || !lrc) return lrc;
    if (hasAnyTranslation(lrc)) return lrc;

    const cached = getCachedMachineLyrics(songId);
    if (cached) return cached;

    const targets = collectTranslatable(lrc);
    if (targets.length === 0) return lrc;
    if (!needsTranslation(targets.map(t => t.text))) return lrc;

    const translations = await requestTranslation(targets.map(t => t.text));
    if (!translations) return lrc;

    const merged = mergeByLineIndex(
        lrc,
        targets.map((t, i) => ({ lineIndex: t.lineIndex, zh: translations[i] || "" })),
    );
    if (!merged.includes(" ／ ")) return lrc;

    const store = loadStore();
    store[String(songId)] = { t: Date.now(), lrc: merged };
    saveStore(store);
    return merged;
}
