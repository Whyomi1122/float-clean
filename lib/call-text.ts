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

import { splitBilingualText, splitQuotedBilingualText, stripQuotedTranslation } from "./bilingual-text";

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
    // 「韩语」（中文译文）配对写法：只剥挂在引号后面的括号译文，其余原样保留
    const quoted = stripQuotedTranslation(text);
    if (quoted !== text) return quoted.trim();
    return text
        .split("\n")
        .map((line) => splitBilingualText(line)?.original ?? line)
        .join("\n")
        .trim();
}

/** 韩文字母范围（含兼容字母） */
const HANGUL_CHAR = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/;
/** 汉字范围 */
const HAN_CHAR = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
/** 装饰性包裹符号：模型爱用《》«»「」把台词括起来，TTS 会当字符念出来 */
const DECORATION_CHARS = /[《》«»‹›「」『』〈〉〖〗【】｜|]/g;

export type SpeechCleanOptions = {
    /**
     * 该角色是否「韩语主导」：只有韩语主导的角色，纯中文行才被当作译文丢掉。
     * 混说/中文主导的角色（如中文社交+偶尔韩语）中文就是正常台词，不能删。
     */
    dropTranslation?: boolean;
};

/**
 * 只留「该念的语言」：
 *   · 韩语主导角色的纯中文行＝译文行，丢弃；韩文行里夹的汉字片段删掉；
 *   · 其他角色原样返回，只保留装饰符清洗（在 cleanSpeechFragment 里做）。
 * 实机事故（2026-11-07）：译文另起一行、没有竖线分隔时，最后一句中文被念一遍。
 */
export function stripSpokenScript(raw: string, options?: SpeechCleanOptions): string {
    const text = raw || "";
    if (!options?.dropTranslation) return text;
    // 不能因为「整段没韩文」就提前返回：分句后单块可能只剩译文（如「(明明就起不来。)」），
    // 那种碎片正是 2026-11-08 实机"还在念译文"的罪魁。
    const kept: string[] = [];
    for (const line of text.split(/\r?\n/)) {
        // 引号包裹的中文行＝角色真的说了中文（如被要求说中文），照念，不当译文删
        if (/^\s*「[^「」]*」\s*$/.test(line) && HAN_CHAR.test(line) && !HANGUL_CHAR.test(line)) {
            kept.push(line.trim());
            continue;
        }
        if (!HANGUL_CHAR.test(line)) {
            // 纯符号/拉丁/数字行（标签、语气符）保留；含汉字的就是译文行
            if (!HAN_CHAR.test(line)) kept.push(line);
            continue;
        }
        kept.push(
            line
                .replace(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+[，、。！？…；：""''（）()·—\s]*/g, " ")
                .replace(/[ \t]{2,}/g, " ")
                .trim(),
        );
    }
    return kept.join("\n").replace(/\n{2,}/g, "\n").trim();
}

/**
 * TTS 取文清洗（单句/整段通用）：剥外壳 → 剥译本 → 去掉不该念的文字 → 去装饰符号。
 */
export function cleanSpeechFragment(raw: string, options?: SpeechCleanOptions): string {
    if (!raw) return "";
    let text = stripVoiceNoteWrapper(raw);
    // 语气标记 [情绪:happy] 是给朗读参数用的，任何情况下都不能被念出来（含没写完的半截）
    text = text.replace(/[[【]\s*情绪\s*[:：][^\]】\n]*[\]】]?/g, "");
    text = stripBilingualTranslation(text);
    text = stripSpokenScript(text, options);
    text = text.replace(DECORATION_CHARS, " ");
    // 括号被掏空后剩下的孤立半括号（念出来就是「念符号」），按行配对后清掉落单的
    text = text
        .split("\n")
        .map((line) => stripOrphanBrackets(line))
        .join("\n");
    text = text.replace(/\s{2,}/g, " ").replace(/^[ \t]+|[ \t]+$/gm, "").trim();
    return text;
}

/** 只删掉落单的括号，成对的（笑）保持原样，避免把正常括号内容吃掉 */
function stripOrphanBrackets(line: string): string {
    const chars = Array.from(line);
    const openStack: number[] = [];
    const drop = new Set<number>();
    chars.forEach((ch, index) => {
        if (ch === "（" || ch === "(") openStack.push(index);
        else if (ch === "）" || ch === ")") {
            if (openStack.length) openStack.pop();
            else drop.add(index);
        }
    });
    openStack.forEach((index) => drop.add(index));
    if (!drop.size) return line;
    return chars.filter((_, index) => !drop.has(index)).join("");
}

/**
 * TTS 取文：只念台词（剥旁白、剥译本）。
 * 任何一步剥成空串都会逐级回退，确保不会出现「空文本让角色哑掉」。
 */
export function speechTextForContent(content: string, options?: SpeechCleanOptions): string {
    const unwrapped = stripVoiceNoteWrapper(content);
    const { dialogue } = splitNarration(unwrapped);
    const spoken = cleanSpeechFragment(dialogue, options);
    if (spoken) return spoken;
    const fallback = cleanSpeechFragment(unwrapped, options);
    if (fallback) return fallback;
    return unwrapped.trim();
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
/**
 * 剥掉 MiniMax 的「声音表现力标签」，只用于上屏与入库：
 *   · <#0.3#> 停顿
 *   · (breath) (sighs) (laughs) (clears throat) 等英文括号动作
 * TTS 取文走的是另一条链路（保留标签），所以剥掉不影响朗读。
 * 注意只认英文括号短词，中文旁白「（叹气）」不受影响。
 */
const PERFORMANCE_SPEED_TAG = /<#\s*[0-9.]+\s*#>/g;
const PERFORMANCE_PAREN_TAG =
    /[（(]\s*(?:breath(?:e|es|ing)?|sigh(?:s|ing)?|laugh(?:s|ing)?|chuckle|giggle|cry(?:ing)?|sob(?:bing)?|cough(?:s|ing)?|sneez(?:e|es|ing)|gasp(?:s|ing)?|yawn(?:s|ing)?|sniff(?:s|ing)?|groan(?:s|ing)?|hum(?:ming)?|whistl(?:e|es|ing)|clears?\s+throat|tsk+|scream(?:s|ing)?|exhal(?:e|es|ing)|inhal(?:e|es|ing)|pause|silence|shaky|trembling)\s*[)）]/gi;

export function stripPerformanceTags(text: string): string {
    if (!text) return "";
    return text
        .replace(PERFORMANCE_SPEED_TAG, "")
        .replace(PERFORMANCE_PAREN_TAG, "")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/^[ \t]+/gm, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

export function splitSentencesForDisplay(text: string): string[] {
    const trimmed = stripVoiceNoteWrapper(text).trim();
    if (!trimmed) return [];
    const lines = trimmed.split(/\n+/).map(l => l.trim()).filter(Boolean);
    const out: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        // 「韩语」（中文译文）成对写法：整对作为一帧，不按句末标点硬切，
        // 否则「폰 떨어져서 얼굴 맞았어?」+（手机掉下来砸到脸了?）会被切成碎片、引号括号悬空。
        const pair = splitQuotedBilingualText(line)
            ?? splitQuotedBilingualText(`${line}\n${lines[index + 1] ?? ""}`);
        if (pair) {
            const pairedOnNextLine = !splitQuotedBilingualText(line);
            out.push(`${pair.original}（${pair.translated}）`);
            if (pairedOnNextLine) index += 1;
            continue;
        }
        const quotedOnly = line.match(/^「([^「」]+)」$/);
        if (quotedOnly) {
            const innerParts = splitByPunctuation(quotedOnly[1].trim());
            if (innerParts.length > 1) out.push(...innerParts.map(p => `「${p}」`));
            else out.push(`「${quotedOnly[1].trim()}」`);
            continue;
        }
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
        // 整行就是一个括号译文：（记得啊，……看日出吗。我都答应……吧？）
        // 按句号切开后要逐句补回括号，否则末尾孤立的「）」会自己成一帧（2026-11-08 实机）。
        const parenOnly = line.match(/^[（(]([^（）()]+)[）)]$/);
        if (parenOnly) {
            const innerParts = splitByPunctuation(parenOnly[1].trim());
            if (innerParts.length > 1) out.push(...innerParts.map(part => `（${part}）`));
            else out.push(line);
            continue;
        }
        const parts = splitByPunctuation(line);
        if (parts.length > 1) out.push(...parts);
        else out.push(line);
    }
    return out.length ? out : [trimmed];
}
