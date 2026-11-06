// lib/call-text.ts — 通话/聊天共用的「台词 vs 旁白」判定与 TTS 取文
//
// 口径（2026-11-04 修订，血泪教训）：
//   旁白只能「正向识别」，不能「凡是不带前缀的都算旁白」。
//   实际对局里模型经常输出「뭐 하고 있긴, 너 생각하고 있었지.|还能在干嘛，当然是在想你啊。」
//   这种没有「角色名|」前缀的台词，旧逻辑会把整句当旁白：
//     · 气泡里正文被掏空 → 只剩一行淡字
//     · TTS 取文为空 → 角色完全不出声
//   因此规则改为：**整段至少有一行带「名|」前缀**（= 确实用了通话台词格式）时，
//   才把「无前缀、非括号、非引号开头」的行判为旁白；否则整段一律当正文。

import { splitBilingualText } from "./bilingual-text";

/** 台词行前缀：「名|台词」或「名：台词」 */
const SPEAKER_PREFIX = /^[^\s|：:]{1,12}[|：:]/;
/** 整段是否使用通话台词格式（至少一行带「名|」竖线前缀） */
const CALL_FORMAT = /^[^\s|：:]{1,12}\|/m;
/** 译本行（部分通道会带这层标记） */
const TRANSLATION_MARK = /^[(（]tr[:：]/i;

export function usesCallDialogueFormat(text: string): boolean {
    return CALL_FORMAT.test(text);
}

/**
 * 去掉模型自带的「[语音条: …]」外壳。真实输出（2026-11-05 实机）：
 *   [语音条:어디야는 무슨, 집 앞이니까 창밖 좀 봐봐.
 *   什么叫做在哪里，就在家门口呢，往窗外看一眼。]
 * 旧逻辑把「[」「语音条:」「]」当台词：界面上露符号、TTS 还念了个「[」。
 */
export function stripVoiceNoteWrapper(text: string): string {
    let out = (text || "").replace(/语音条\s*[:：]?/g, "");
    // 独占一行的纯括号残留
    out = out.split(/\r?\n/).filter(line => !/^[\s[\]【】]*$/.test(line)).join("\n");
    // 整段首尾游离的方括号
    out = out.replace(/^\s*[[【]\s*/, "").replace(/\s*[\]】]\s*$/, "");
    return out.trim();
}

/** 单行是否属于旁白（需配合 usesCallDialogueFormat 使用） */
export function isNarrationLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (TRANSLATION_MARK.test(trimmed)) return false;
    if (trimmed.startsWith("（") || trimmed.startsWith("(")) return false;
    if (/^["「『“]/.test(trimmed)) return false;
    if (SPEAKER_PREFIX.test(trimmed)) return false;
    return true;
}

/**
 * 把一段内容拆成「台词」与「旁白」。
 * 只有整段确实用了通话台词格式时才抽旁白，否则原样返回。
 */
export function splitNarration(text: string): { dialogue: string; narration?: string } {
    text = stripVoiceNoteWrapper(text);
    if (!usesCallDialogueFormat(text)) return { dialogue: text };
    const dialogue: string[] = [];
    const narration: string[] = [];
    for (const line of text.split("\n")) {
        if (isNarrationLine(line)) narration.push(line.trim());
        else dialogue.push(line);
    }
    const dialogueText = dialogue.join("\n").trim();
    const narrationText = narration.join("\n").trim();
    // 掏空正文 = 判定不可信，整段当正文（宁可多念一句，也不能让角色哑掉）
    if (!dialogueText) return { dialogue: text };
    return { dialogue: dialogueText, ...(narrationText ? { narration: narrationText } : {}) };
}

/** 去掉双语译本，只留原文（TTS 用） */
export function stripBilingualTranslation(text: string): string {
    return text
        .split("\n")
        .map((line) => splitBilingualText(line)?.original ?? line)
        .join("\n")
        .trim();
}

/**
 * TTS 取文：只念台词（剥旁白、剥译本）。
 * 任何一步剥成空串都会逐级回退，确保不会出现「空文本让角色哑掉」。
 */
export function speechTextForContent(content: string): string {
    content = stripVoiceNoteWrapper(content);
    const { dialogue } = splitNarration(content);
    const spoken = stripBilingualTranslation(dialogue);
    if (spoken) return spoken;
    const translated = stripBilingualTranslation(content);
    if (translated) return translated;
    return content.trim();
}

/**
 * 把一段回复切成适合分段合成的短句：先合成第一句就能开播，
 * 后面几句在播放的同时并行合成，首字出声延迟明显降低。
 */
export function splitSpeechChunks(text: string, maxLen = 40): string[] {
    const cleaned = text.replace(/\s+/g, " ").trim();
    if (!cleaned) return [];
    const pieces = cleaned.match(/[^。！？!?…；;\n]+[。！？!?…；;]?/g) || [cleaned];
    const chunks: string[] = [];
    let buffer = "";
    for (const raw of pieces) {
        const piece = raw.trim();
        if (!piece) continue;
        if (buffer && buffer.length + piece.length > maxLen) {
            chunks.push(buffer);
            buffer = piece;
        } else {
            buffer += piece;
        }
        if (buffer.length >= maxLen) {
            chunks.push(buffer);
            buffer = "";
        }
    }
    if (buffer.trim()) chunks.push(buffer.trim());
    return chunks.length ? chunks : [cleaned];
}

/** 只按句末标点切，不合并：给字幕分句显示用 */
function splitByPunctuation(text: string): string[] {
    const pieces = text.match(/[^。！？!?]+[。！？!?]*/g) || [];
    return pieces.map(p => p.trim()).filter(Boolean);
}

/**
 * 按「每段几句」切分合成文本：段数越少首字越快，段数越多请求越少。
 * 通话偏好的「语音分段」就是调这个值。
 */
export function splitSpeechBySentenceCount(text: string, perChunk = 1): string[] {
    const cleaned = stripVoiceNoteWrapper(text).replace(/\s+/g, " ").trim();
    if (!cleaned) return [];
    const pieces = cleaned.match(/[^。！？!?…；;\n]+[。！？!?…；;]?/g) || [cleaned];
    const size = Math.max(1, Math.floor(perChunk));
    const groups: string[] = [];
    for (let i = 0; i < pieces.length; i += size) {
        const piece = pieces.slice(i, i + size).join("").trim();
        if (piece) groups.push(piece);
    }
    return groups.length ? groups : [cleaned];
}

/**
 * 字幕分句：把一条长回复拆成逐句显示。
 * 双语行（「原文|译文」）必须成对切，两边句数对不上就整行不拆，
 * 否则会出现「半句韩文配整句中文」的错位。
 */
export function splitSentencesForDisplay(text: string): string[] {
    const trimmed = stripVoiceNoteWrapper(text).trim();
    if (!trimmed) return [];
    const lines = trimmed.split(/\n+/).map(l => l.trim()).filter(Boolean);
    const out: string[] = [];
    for (const line of lines) {
        const pipeIndex = line.indexOf("|");
        if (pipeIndex > 0) {
            const left = line.slice(0, pipeIndex);
            const right = line.slice(pipeIndex + 1);
            const leftParts = splitByPunctuation(left);
            const rightParts = splitByPunctuation(right);
            if (leftParts.length > 1 && leftParts.length === rightParts.length) {
                leftParts.forEach((part, index) => out.push(`${part}|${rightParts[index]}`));
            } else {
                out.push(line);
            }
            continue;
        }
        const parts = splitByPunctuation(line);
        if (parts.length > 1) out.push(...parts);
        else out.push(line);
    }
    return out.length ? out : [trimmed];
}
