export function containsChinese(text: string): boolean {
    return /[\u3400-\u9fff]/.test(text);
}

export function normalizeBilingualTextInput(text: string): string {
    return text.replace(/\\r\\n|\\n|\\r/g, "\n");
}

function splitSegmentedBilingualLine(line: string): { original: string; translated: string } | null {
    const parts = line.split("|").map(part => part.trim());
    if (parts.length < 2 || parts.some(part => !part)) return null;

    if (parts.length === 3) {
        const [originalLabel, mixedLabelAndOriginal, translatedValue] = parts;
        const colonIndex = mixedLabelAndOriginal.search(/[:：]/);
        if (colonIndex > 0 && containsChinese(translatedValue) && !containsChinese(originalLabel)) {
            const translatedLabel = mixedLabelAndOriginal.slice(0, colonIndex + 1).trim();
            const originalValue = mixedLabelAndOriginal.slice(colonIndex + 1).trim();
            if (translatedLabel && originalValue && containsChinese(translatedLabel)) {
                return {
                    original: `${originalLabel}: ${originalValue}`,
                    translated: `${translatedLabel} ${translatedValue}`,
                };
            }
        }
    }

    if (parts.length % 2 !== 0) return null;

    const originalParts: string[] = [];
    const translatedParts: string[] = [];
    let hasNonChineseOriginal = false;

    for (let index = 0; index < parts.length; index += 2) {
        const original = parts[index];
        const translated = parts[index + 1];
        if (!translated || !containsChinese(translated)) return null;
        if (!containsChinese(original)) hasNonChineseOriginal = true;
        originalParts.push(original);
        translatedParts.push(translated);
    }

    if (!hasNonChineseOriginal) return null;
    return {
        original: originalParts.join(" | "),
        translated: translatedParts.join(" | "),
    };
}

// ── 「韩语」（中文译文）配对格式 ────────────────────────────────
// 姜志焕 / 反80 的角色文风规则要求：一句韩语对白后紧跟一行括号中文译文，
// 例如「폰 떨어져서 얼굴 맞았어? 」\n（手机掉下来砸到脸了?）
// 或同行写「밥 먹었어?」（吃饭了吗？）。这类文本没有竖线，旧逻辑判不出双语，
// 会被当成普通正文，字幕还会按句末标点把「」和（）切碎。
// 这里只做「严格配对」：必须整行是「…」，紧跟整行/同行是（…），
// 括号内是中文、引号内不含中文，才算一对——避免误吃时间戳（14:05（首尔15:05））。

const FULL_QUOTE_RE = /^「([^「」]+)」$/;
const FULL_PAREN_RE = /^[（(]([^（）()]+)[）)]$/;
const QUOTE_PAREN_RE = /^「([^「」]+)」\s*[（(]([^（）()]*)[）)]$/;
// 叙述在前、台词在后的同一行写法：他把杯子一放：「밥 먹었어?」（吃饭了吗？）
const PREFIX_QUOTE_PAREN_RE = /^(.*?)「([^「」]+)」\s*[（(]([^（）()]+)[）)]$/;

function isQuotePair(quote: string, paren: string): boolean {
    if (!quote || !paren) return false;
    if (!containsChinese(paren)) return false;
    if (containsChinese(quote)) return false;
    return true;
}

/** 「韩语」（中文）配对：返回双语两段，配对不上返回 null（交回竖线逻辑） */
export function splitQuotedBilingualText(text: string): { original: string; translated: string } | null {
    const trimmed = normalizeBilingualTextInput(text).trim();
    if (!trimmed || !trimmed.includes("「")) return null;
    const lines = trimmed.split("\n");
    const originalLines: string[] = [];
    const translatedLines: string[] = [];
    let pairCount = 0;
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (!line) {
            originalLines.push("");
            translatedLines.push("");
            continue;
        }
        const inline = line.match(QUOTE_PAREN_RE);
        if (inline && isQuotePair(inline[1].trim(), inline[2].trim())) {
            originalLines.push(inline[1].trim());
            translatedLines.push(inline[2].trim());
            pairCount += 1;
            continue;
        }
        const prefixed = line.match(PREFIX_QUOTE_PAREN_RE);
        if (prefixed && isQuotePair(prefixed[2].trim(), prefixed[3].trim())) {
            originalLines.push(`${prefixed[1].trimEnd()}「${prefixed[2].trim()}」`);
            translatedLines.push(prefixed[3].trim());
            pairCount += 1;
            continue;
        }
        const quote = line.match(FULL_QUOTE_RE);
        if (quote && !containsChinese(quote[1])) {
            const paren = (lines[index + 1] ?? "").trim().match(FULL_PAREN_RE);
            if (paren && isQuotePair(quote[1].trim(), paren[1].trim())) {
                originalLines.push(quote[1].trim());
                translatedLines.push(paren[1].trim());
                pairCount += 1;
                index += 1;
                continue;
            }
        }
        originalLines.push(line);
        translatedLines.push(line);
    }
    if (pairCount === 0) return null;
    const original = originalLines.join("\n").trim();
    const translated = translatedLines.join("\n").trim();
    if (!original || !translated || !containsChinese(translated)) return null;
    return { original, translated };
}

/** 只剥「挂在「」后面的中文括号译文」，其余文本（含纯中文台词）原样保留 */
export function stripQuotedTranslation(text: string): string {
    const normalized = normalizeBilingualTextInput(text);
    if (!normalized.includes("「")) return text;
    const lines = normalized.split("\n");
    const out: string[] = [];
    let removed = false;
    for (let index = 0; index < lines.length; index += 1) {
        const rawLine = lines[index];
        const line = rawLine.trim();
        if (!line) {
            out.push(rawLine);
            continue;
        }
        const inline = line.match(QUOTE_PAREN_RE);
        if (inline && isQuotePair(inline[1].trim(), inline[2].trim())) {
            out.push(`「${inline[1].trim()}」`);
            removed = true;
            continue;
        }
        const prefixed = line.match(PREFIX_QUOTE_PAREN_RE);
        if (prefixed && isQuotePair(prefixed[2].trim(), prefixed[3].trim())) {
            out.push(`${prefixed[1].trimEnd()}「${prefixed[2].trim()}」`);
            removed = true;
            continue;
        }
        const quote = line.match(FULL_QUOTE_RE);
        if (quote && !containsChinese(quote[1])) {
            const paren = (lines[index + 1] ?? "").trim().match(FULL_PAREN_RE);
            if (paren && isQuotePair(quote[1].trim(), paren[1].trim())) {
                out.push(line);
                removed = true;
                index += 1;
                continue;
            }
        }
        out.push(rawLine);
    }
    return removed ? out.join("\n") : text;
}

export function splitBilingualText(text: string): { original: string; translated: string } | null {
    const trimmed = normalizeBilingualTextInput(text).trim();
    if (!trimmed || trimmed.includes("```") || /<script\b|<style\b/i.test(trimmed)) return null;
    // 无竖线时先试「韩语」（中文）配对格式
    if (!trimmed.includes("|")) {
        const quoted = splitQuotedBilingualText(trimmed);
        if (quoted) return quoted;
    }
    const firstPipe = trimmed.indexOf("|");
    if (firstPipe <= 0) return null;
    if (firstPipe === trimmed.lastIndexOf("|")) {
        const original = trimmed.slice(0, firstPipe).trim();
        const translated = trimmed.slice(firstPipe + 1).trim();
        if (!original || !translated) return null;
        if (!containsChinese(translated)) return null;
        return { original, translated };
    }
    if (trimmed.includes("\n")) {
        const originalLines: string[] = [];
        const translatedLines: string[] = [];
        let bilingualLineCount = 0;

        for (const rawLine of trimmed.split("\n")) {
            const line = rawLine.trim();
            if (!line) {
                originalLines.push("");
                translatedLines.push("");
                continue;
            }

            const linePipe = line.indexOf("|");
            if (linePipe > 0 && linePipe === line.lastIndexOf("|")) {
                const lineOriginal = line.slice(0, linePipe).trim();
                const lineTranslated = line.slice(linePipe + 1).trim();
                if (!lineOriginal || !lineTranslated || !containsChinese(lineTranslated)) return null;
                originalLines.push(lineOriginal);
                translatedLines.push(lineTranslated);
                bilingualLineCount += 1;
                continue;
            }

            if (line.includes("|")) {
                const segmented = splitSegmentedBilingualLine(line);
                if (!segmented) return null;
                originalLines.push(segmented.original);
                translatedLines.push(segmented.translated);
                bilingualLineCount += 1;
                continue;
            }

            originalLines.push(line);
            translatedLines.push(line);
        }

        if (bilingualLineCount === 0) return null;
        const original = originalLines.join("\n").trim();
        const translated = translatedLines.join("\n").trim();
        if (!original || !translated || !containsChinese(translated)) return null;
        return { original, translated };
    }
    const segmented = splitSegmentedBilingualLine(trimmed);
    if (segmented) return segmented;
    return null;
}
