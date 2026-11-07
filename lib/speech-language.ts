// 语音朗读语言控制（2026-11-07）
// 背景：反80 三人的克隆音色是按韩语训练的，读中文台词会非常怪；但他们的剧情文本
// 必须保持原样（中文为主），所以只在「朗读层」强制韩语，不碰正文生成。
// 姜志焕则保持 auto：他说什么就读什么（99% 是他自己的韩语台词）。
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

const KOREAN_SPEECH_SYSTEM = [
    "你是韩语台词转写器。把用户给的一句中文台词，改写成同一个角色会说出来的自然韩语口语。",
    "要求：只输出一行韩语；保留原本的语气强弱、称呼方式、停顿感；不解释、不加引号、不加中文译文。",
].join("\n");

/**
 * 把中文台词转成韩语用于朗读。
 * 已经含韩语 → 原样返回；没有可用模型/失败 → 返回 null（调用方退回原文，宁可读中文也不出错）。
 */
export async function toKoreanSpeechText(text: string): Promise<string | null> {
    const source = text.trim();
    if (!source) return null;
    if (hasHangul(source)) return source;
    if (!HAN_RE.test(source)) return source;
    const config = resolveAuxiliaryApiConfig("reasoningTranslateApiConfigId");
    if (!config) return null;
    const messages: SimpleLLMMessage[] = [
        { role: "system", content: KOREAN_SPEECH_SYSTEM },
        { role: "user", content: source },
    ];
    try {
        const result = await simpleLLMCall(config, messages);
        const content = (result.content ?? "").trim();
        if (!content) return null;
        const firstLine = content.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
        const cleaned = firstLine
            .replace(/^[「『"]|[」』"]$/g, "")
            .replace(/[（(][^（）()]*[）)]/g, "")
            .trim();
        return hasHangul(cleaned) ? cleaned : null;
    } catch {
        return null;
    }
}
