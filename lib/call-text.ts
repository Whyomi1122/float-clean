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
    // 情绪/语气标签（`[情绪:happy]`）只给 TTS 用，绝不上屏。
    // 2026-11-15 实机：流式预览里露出「情绪:happy]」——下面那段「剥开头游离 [ 」把左括号吃掉了一半。
    out = out.replace(/[[【]\s*(?:情绪|语气|emotion)\s*[:：][^\]】\r\n]*[\]】]?/gi, "");
    // 独占一行的纯括号残留
    out = out.split(/\r?\n/).filter(line => !/^[\s[\]【】]*$/.test(line)).join("\n");
    // 整段首尾游离的方括号。
    // 注意（2026-11-15 实机）：旁白暗号 `[旁白] …` 也是以 `[` 开头，以前这里会把左括号吃掉，
    // 结果正文显示成「旁白] 手机贴在耳边…」。暗号开头就交给后面的暗号处理，别动它。
    if (!/^\s*[[【]\s*(?:旁白|心理|叙述|动作|内心|韩语|中文|英语|日语|日文|情绪|语气)/.test(out)) {
        out = out.replace(/^\s*[[【]\s*/, "").replace(/\s*[\]】]\s*$/, "");
    }
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
 * 模型偶尔会自己加语言/心理标签（`[韩语]` / `[内心]` / `[中文]` …）。
 * 这些是给模型看的标记，绝不能上屏，也不能念出来（2026-11-15 实机：聊天室折叠区里出现过「[内心]…」）。
 * 注意只剥标签本身，标签后面的内容保留。
 */
const CHAT_LABEL_MARKER = /[[【]\s*(?:韩语|中文|英语|日语|日文|内心)\s*[\]】][:：]?\s*/g;
/** 对白类暗号（群像剧本常带 `[对白]`）：聊天室里没有意义，直接摘掉，别让暗号上屏（2026-11-19 对照测试发现） */
const CHAT_DIALOGUE_MARKER = /[[【]\s*(?:对白|台词|对话|独白)\s*[\]】][:：]?\s*/g;
/** 情绪标签（`[情绪:happy]`）只给 TTS 用，任何地方都不该上屏（2026-11-15 实机） */
const EMOTION_LABEL_MARKER = /[[【]\s*(?:情绪|语气|emotion)\s*[:：][^\]】\r\n]*[\]】]?/gi;

export function stripChatMarkers(text: string): string {
    if (!text) return "";
    return String(text)
        .replace(EMOTION_LABEL_MARKER, "")
        .replace(CHAT_LABEL_MARKER, "")
        .replace(CHAT_DIALOGUE_MARKER, "")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/^[ \t]+/gm, "")
        .trim();
}

/**
 * 整条内容都是旁白（没有台词）——用于聊天室「不套气泡、走居中灰色斜体」。
 */
export function isNarrationOnlyContent(text: string): boolean {
    if (!text || !text.trim()) return false;
    const { dialogue, narration } = splitNarration(text);
    return !!narration && !!narration.trim() && !dialogue.trim();
}

/**
 * 把一段内容拆成「台词」与「旁白」。
 * ① 先认行首旁白暗号（正向识别，最可靠）；② 剩下的再走旧启发式。
 */
export function splitNarration(text: string): { dialogue: string; narration?: string; narrationBlocks?: string[] } {
    text = normalizeParenthesisNarration(normalizeNarrationMarker(stripChatMarkers(stripVoiceNoteWrapper(text))));
    const marked: string[] = [];
    const kept: string[] = [];
    for (const line of text.split("\n")) {
        if (NARRATION_MARKER.test(line)) {
            const inner = line.replace(NARRATION_MARKER, "").trim();
            if (inner) marked.push(inner);
        } else {
            kept.push(line);
        }
    }
    if (!marked.length) return splitNarrationHeuristic(text);
    const restText = kept.join("\n").trim();
    // 整段全是旁白：台词留空、旁白照实带出去，由调用方用「居中淡字」渲染。
    // （2026-11-15 实机：以前这里把原文塞回 dialogue，结果气泡里直接露出「[旁白] 门一开…」）
    if (!restText) return { dialogue: "", narration: marked.join("\n"), narrationBlocks: marked };
    const rest = splitNarrationHeuristic(restText);
    const narrationText = [rest.narration, ...marked].filter(Boolean).join("\n").trim();
    return { dialogue: rest.dialogue, ...(narrationText ? { narration: narrationText, narrationBlocks: toNarrationBlocks(narrationText) } : {}) };
}

/** 旁白按行切成独立的小块（2026-11-19：旁白 / 心理各占一句，不挤成一段） */
function toNarrationBlocks(narrationText: string): string[] {
    return String(narrationText || "")
        .split(/\n+/)
        .map(line => line.trim())
        .filter(Boolean);
}

/**
 * 旧的旁白启发式：只有整段确实用了通话台词格式时才抽旁白，否则原样返回。
 */
function splitNarrationHeuristic(text: string): { dialogue: string; narration?: string } {
    if (!usesCallDialogueFormat(text)) {
        // 没有暗号、也不是「名|台词」格式：再用引号兜底（2026-11-15 实机「旁白和对白混在一起」）
        return splitNarrationByQuotes(text) ?? { dialogue: text };
    }
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

/**
 * 旁白暗号（2026-11-14，全局启用）：要写动作 / 环境 / 心理时，行首打 `[旁白]`
 *（和群像同一套口径，另外兼容 `【旁白】` / `[心理]` / `[叙述]` / `[动作]`）。
 * 带暗号的行**一律**判旁白 —— 正向识别，不再靠「没前缀就算旁白」猜，猜错会把正文掏空。
 */
const NARRATION_MARKER = /^[\s>*\-•·]*[[【]\s*(?:旁白|心理|叙述|动作)\s*[\]】][:：]?\s*/;

/** 这段文字里有没有行首旁白暗号 */
export function hasNarrationMarker(text: string): boolean {
    return normalizeNarrationMarker(String(text || ""))
        .split(/\r?\n/)
        .some(line => NARRATION_MARKER.test(line));
}

/**
 * 模型常把暗号写在句子中间（「…没事。[旁白] 他走到窗边。」），行首规则就漏了。
 * 先把行内暗号统一搬到行首，后面继续走行判定（2026-11-15 实机：旁白只剥掉左括号、残留「旁白]」）。
 */
function normalizeNarrationMarker(text: string): string {
    return String(text || "")
        .replace(/([^\n])[ \t]*[[【]\s*(?:旁白|心理|叙述|动作)\s*[\]】][:：]?\s*/g, "$1\n[旁白] ")
        .replace(/^[ \t]*[[【]\s*(?:旁白|心理|叙述|动作)\s*[\]】][:：]?\s*/gm, "[旁白] ");
}

/**
 * 括号动作兜底（2026-11-19 实机）：模型不写 `[旁白]` 时爱把动作塞进 `（…）`，
 * 结果整段留在气泡里（「动作还是没分开」）。这里把括号块转成 `[旁白]` 行：
 *   · 整行被括号包住：`（他关掉投影，走过走廊。）`
 *   · 括号单独起行、跨行到 `）` 收尾
 * 例外：紧跟在韩语/日语/英语台词后面的 `（中文）` 是**译文**，不能当旁白。
 */
const PAREN_SINGLE_LINE = /^[（(]\s*([^（()）]*?)\s*[）)]$/;
const PAREN_OPEN_LINE = /^[（(]\s*$/;
const PAREN_CLOSE_END = /[）)]\s*$/;
const FOREIGN_SCRIPT = /[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F\u3040-\u30FF\uFF66-\uFF9F]|[A-Za-z]{2,}/;
const CJK_CHAR = /[\u4E00-\u9FFF]/;

function normalizeParenthesisNarration(text: string): string {
    const src = String(text || "");
    if (!/[（(]/.test(src)) return src;
    const lines = src.split("\n");
    const out: string[] = [];
    let pending: string[] | null = null;
    for (const raw of lines) {
        const line = raw.trim();
        if (!line) {
            if (!pending) out.push(raw);
            continue;
        }
        if (pending) {
            pending.push(line);
            if (PAREN_CLOSE_END.test(line)) {
                const merged = pending.join(" ").replace(/^[（(]\s*/, "").replace(/[）)]\s*$/, "").trim();
                if (merged) out.push(`[旁白] ${merged}`);
                pending = null;
            }
            continue;
        }
        if (PAREN_OPEN_LINE.test(line)) { pending = [line]; continue; }
        const m = line.match(PAREN_SINGLE_LINE);
        if (m) {
            const inner = (m[1] || "").trim();
            const prev = [...out].reverse().find(l => l.trim()) || "";
            const isTranslation = !!inner && CJK_CHAR.test(inner) && FOREIGN_SCRIPT.test(prev);
            if (inner && !isTranslation) {
                out.push(`[旁白] ${inner}`);
                continue;
            }
        }
        out.push(raw);
    }
    // 括号没收到尾就结束了：原样吐回去，别把台词吞掉
    if (pending) out.push(...pending);
    return out.join("\n");
}

/**
 * 引号兜底（2026-11-15）：一段里既有带引号的台词、又有不带引号的部分 → 那些裸文字判旁白。
 * 支持两种写法：
 *   · 分行的：第一行旁白、第二行「台词」
 *   · 同行的：`在补觉，正好有功夫配合她。「뭐 테스트야.」`（模型最爱这么写，旧逻辑拆不开）
 * 两边任意一边为空就不拆（宁可多留一句，也不能把角色说哑）。
 */
function splitNarrationByQuotes(text: string): { dialogue: string; narration?: string } | null {
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!lines.length) return null;

    const QUOTE = /[「『“"]|」|』|”|[|｜]/;
    const QUOTE_OPEN = /[「『“"]/;
    const dialogue: string[] = [];
    const narration: string[] = [];

    for (const line of lines) {
        if (!QUOTE.test(line)) {
            narration.push(line);
            continue;
        }
        // 同一行里引号前面还有话 → 那截是旁白，剩下是台词
        const openAt = line.search(QUOTE_OPEN);
        if (openAt > 0) {
            const prefix = line.slice(0, openAt).trim();
            if (prefix && !SPEAKER_PREFIX.test(prefix)) {
                narration.push(prefix);
                const rest = line.slice(openAt).trim();
                if (rest) dialogue.push(rest);
                continue;
            }
        }
        dialogue.push(line);
    }

    if (!dialogue.length || !narration.length) return null;
    return { dialogue: dialogue.join("\n"), narration: narration.join("\n") };
}

/** 去掉行首旁白暗号，只留正文（展示/TTS 兜底用） */
export function stripNarrationMarker(text: string): string {
    return String(text || "")
        .split("\n")
        .map(line => line.replace(NARRATION_MARKER, ""))
        .join("\n");
}

/**
 * 旁白标记提示词（2026-11-14 起全局注入，见 `lib/chat-engine.ts`）。
 * 只要求「标记」，不规定语气和篇幅，尽量不动人设。
 */
export const CHAT_NARRATION_INSTRUCTION = [
    "【旁白与心理 · 写法与比例】",
    "聊天室以「说话」为主，旁白只是点缀，不是主戏。写多了就变成剧情小说，必须克制。",
    "① 没说出口的内容要单独起一行、行首打暗号：",
    "   动作 / 神态 / 环境 → [旁白] 他把伞往你那边偏了偏，半边肩膀露在雨里。",
    "   角色心里的念头 → [心理] 她到底什么时候才肯说。",
    "② 比例：一条回复里旁白 + 心理合计最多 2 行、总数不超过 40 字，并且明显少于台词字数；能不放就不放。",
    "③ 心理只写一句当下的真念头（20 字以内），不许复述台词、不许长篇抒情；旁白和心理各占一行，不许挤在同一行。",
    "④ 连续两条回复不要都带旁白。如果你上一条已经写过，这一条就只说话。",
    "⑤ 只有「你在做事 / 说不出话」时，才允许整条都是旁白，且一次最多 2 行，下一条必须回到台词。",
    "⑥ 禁止用别的写法代替：不许用 *星号*、不许用（括号动作）、不许把动作混进台词里描述。括号（…）只放台词的中文译文。",
    "⑦ 每条回复发出去前自查一遍：旁白是不是太多？能不能删掉一半？能删就删。",
].join("\n");

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
    // 台词是空的（整段旁白）→ 兜底念正文：先摘掉暗号，别把「[旁白]」念出来
    const fallback = cleanSpeechFragment(stripNarrationMarker(unwrapped), options);
    if (fallback) return fallback;
    return unwrapped.trim();
}

const HANGUL_RE = /[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/;
const HAN_RE = /[\u4E00-\u9FFF]/;

/** 这一段是不是「纯中文」的一句（去掉括号标点后只剩汉字） */
function looksLikeChineseLine(text: string): boolean {
    const core = text.replace(/[（(【[]/g, "").replace(/[)\s）】\]]/g, "").replace(/[。，、！？…；：,.!?;:]/g, "");
    if (!core) return false;
    return HAN_RE.test(core) && !HANGUL_RE.test(core) && !/[A-Za-z]{4,}/.test(core);
}

/**
 * 模型常把译文单独写一段（有时带括号），通话里会被切成两个气泡，看着像两句台词。
 * 这里把「紧跟在韩语后面的纯中文段」并回上一条，还原成「韩语 +（中文）」一个气泡。
 * 2026-11-15 实机：图 1 的 `지금 갈게, 문 열어둬.` /`（我现在过去，门留着。）` 分成了两条。
 */
export function mergeTranslationParts<T extends { content: string }>(parts: T[]): T[] {
    const merged: T[] = [];
    for (const part of parts) {
        const prev = merged[merged.length - 1];
        const following = !!prev && HANGUL_RE.test(prev.content) && !looksLikeChineseLine(prev.content);
        if (prev && following && looksLikeChineseLine(part.content)) {
            const raw = part.content.trim();
            const addition = /^[（(]/.test(raw) ? raw : `（${raw}）`;
            merged[merged.length - 1] = { ...prev, content: `${prev.content.trim()}\n${addition}` };
            continue;
        }
        merged.push(part);
    }
    return merged;
}

/**
 * 台词气泡里的「双语句式」统一成：韩语一行 +（中文）一行。
 * 模型有时把译文直接写成裸的下一行（没有括号），有时带括号，界面看着两种格式（2026-11-15 实机图 3）。
 */
export function normalizeBilingualLayout(text: string): string {
    const lines = String(text || "").split(/\r?\n/);
    const out: string[] = [];
    for (const rawLine of lines) {
        const line = fixBilingualBrackets(rawLine);
        const prev = out[out.length - 1];
        const isTranslation = !!line.trim() && looksLikeChineseLine(line) && !/^\s*[（(]/.test(line);
        if (prev && HANGUL_RE.test(prev) && !looksLikeChineseLine(prev) && isTranslation) {
            out.push(`（${line.trim()}）`);
            continue;
        }
        out.push(line);
    }
    return out.join("\n").trim();
}

/**
 * 清理双语句式里的括号残渣（2026-11-16 实机图 2）：
 * `韩语】（中文）`、`（中文]`、`韩语】（` 都是同一类问题——模型用 `【】` 包台词、
 * 又用 `（）` 包译文，剥标签时只剥掉了开头那个。
 * 只动「行内/行尾的孤立括号」，不动行首的 `【旁白】` 这类暗号。
 */
export function fixBilingualBrackets(line: string): string {
    if (!line) return line;
    let out = String(line);
    // 译文前的孤立 】
    out = out.replace(/[ \t]*】[ \t]*(?=[（(])/g, " ");
    // 行尾孤立的 】
    out = out.replace(/[ \t]*】[ \t]*$/g, "");
    // 只剩半个 】
    out = out.replace(/[ \t]*】/g, "");
    // 混用括号：（中文] / [中文）
    out = out.replace(/（([^（）()\]]*)\]/g, "（$1）");
    out = out.replace(/\[([^（）()\[\]]*)）/g, "（$1）");
    return out.replace(/[ \t]{2,}/g, " ").trimEnd();
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
            // 单独一行的中文译文：并回上一条韩语，做成「韩语 +（中文）」一个气泡
            // （2026-11-15 实机：通话页每个译文各自成气泡，看着像多说了好几句）
            const prev = out[out.length - 1];
            if (prev && !/[（(]/.test(prev) && HANGUL_RE.test(prev) && !looksLikeChineseLine(prev)) {
                out[out.length - 1] = `${prev}\n（${parenOnly[1].trim()}）`;
                continue;
            }
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
