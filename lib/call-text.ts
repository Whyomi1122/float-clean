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
    const { dialogue } = splitNarration(content);
    const spoken = stripBilingualTranslation(dialogue);
    if (spoken) return spoken;
    const translated = stripBilingualTranslation(content);
    if (translated) return translated;
    return content.trim();
}
