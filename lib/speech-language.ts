// 语音朗读语言控制（2026-11-07）
// 背景：反80 三人的克隆音色是按韩语训练的，读中文台词会非常怪；但他们的剧情文本
// 必须保持原样（中文为主），所以只在「朗读层」强制韩语，不碰正文生成。
// 姜志焕则相反：文本本身就该是韩语（人设 99% 韩语），靠 textKorean 在聊天提示里钉住。
import { simpleLLMCall } from "./api-helpers";
import type { SimpleLLMMessage } from "./api-helpers";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { resolveVoiceConfig } from "./tts-service";

const HANGUL_RE = /[\uAC00-\uD7A3\u1100-\u11FF\u3131-\u318E]/;
const HAN_RE = /[\u4E00-\u9FFF]/;

export type SpeechLanguageMode = "auto" | "korean";

export function hasHangul(text: string): boolean {
    return HANGUL_RE.test(text);
}

/** 该角色是否在朗读层强制韩语（语音条 + 通话） */
export function resolveSpeechLanguageMode(characterId: string): SpeechLanguageMode {
    try {
        const cfg = resolveVoiceConfig(characterId);
        return cfg?.forceSpeechLanguage === "korean" ? "korean" : "auto";
    } catch {
        return "auto";
    }
}

/** 该角色台词是否必须韩语（文本层，如姜志焕） */
export function isKoreanTextCharacter(characterId: string): boolean {
    try {
        return resolveVoiceConfig(characterId)?.textKorean === true;
    } catch {
        return false;
    }
}

/** 该角色语音条是否需要把中文转写韩语再朗读（朗读层，如反80 两人） */
export function isKoreanSpeechCharacter(characterId: string): boolean {
    return resolveSpeechLanguageMode(characterId) === "korean";
}

const KOREAN_SPEECH_SYSTEM = [
    "你是韩语台词转写器。把用户给的一句中文台词，改写成同一个角色会说出来的自然韩语口语。",
    "只输出两行：第一行韩语台词；第二行它的简体中文译文。",
    "保留原本的语气强弱、称呼方式、停顿感。不解释、不加引号、不加书名号、不加任何标注。",
].join("\n");

// 同一条文本只转一次：预转写与点击播放共用缓存，避免重复请求（也避免重复扣额度）
const pairCache = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();

function parseKoreanPair(content: string): string | null {
    const lines = content
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.replace(/^[「『"]|[」』"]$/g, "").trim());
    const korean = lines.find((line) => HANGUL_RE.test(line));
    if (!korean) return null;
    const chinese = lines.find((line) => line !== korean && HAN_RE.test(line));
    if (!chinese) return korean;
    return `「${korean}」\n（${chinese}）`;
}

/**
 * 中文台词 → 「韩语台词」\n（中文译文）。已经含韩语的原样返回。
 * 失败返回 null（调用方退回原文，宁可读中文也不出错）。
 */
export async function toKoreanSpeechPair(text: string): Promise<string | null> {
    const source = text.trim();
    if (!source) return null;
    if (HANGUL_RE.test(source)) return source;
    if (!HAN_RE.test(source)) return source;
    const cached = pairCache.get(source);
    if (cached !== undefined) return cached;
    const inflight = pending.get(source);
    if (inflight) return inflight;
    const task = (async () => {
        const config = resolveAuxiliaryApiConfig("reasoningTranslateApiConfigId");
        if (!config) return null;
        const messages: SimpleLLMMessage[] = [
            { role: "system", content: KOREAN_SPEECH_SYSTEM },
            { role: "user", content: source },
        ];
        try {
            // 转写是短任务：限 token + 低温，避免走进长思考把播放拖到十几秒
            const result = await simpleLLMCall(config, messages, {
                max_tokens: 220,
                temperature: 0.3,
                label: "韩语台词转写",
            });
            const content = (result.content ?? "").trim();
            return content ? parseKoreanPair(content) : null;
        } catch {
            return null;
        }
    })();
    pending.set(source, task);
    const result = await task;
    pending.delete(source);
    pairCache.set(source, result);
    return result;
}

/** 只取朗读用的韩语文本（去掉译文行） */
export async function toKoreanSpeechText(text: string): Promise<string | null> {
    const pair = await toKoreanSpeechPair(text);
    if (!pair) return null;
    if (pair === text.trim()) return pair;
    const koreanLine = pair.split("\n").find((line) => HANGUL_RE.test(line)) ?? "";
    const cleaned = koreanLine.replace(/^「|」$/g, "").trim();
    return cleaned || null;
}
