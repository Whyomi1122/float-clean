"use client";

// 通话 / 回放台词统一渲染：原文（角色语言）在上，中文译文在下，左对齐。
// 不走 BilingualTextBlock（那个带折叠开关，通话里不合适，且顺序受主题样式影响），
// 这里用固定结构，保证「和聊天室一致：上原文、下译文」永远成立。

import { splitBilingualText } from "@/lib/bilingual-text";

/** 去掉只有标点/符号的残留行（模型偶尔会在开头吐一个 "." 或 "。"） */
function cleanLines(text: string): string {
    const kept = text
        .split("\n")
        .filter((line) => line.replace(/[\p{P}\p{S}\s]/gu, "").length > 0);
    const result = kept.join("\n").trim();
    return result || text.trim();
}

export function SubtitleText({ text }: { text: string }) {
    const safe = cleanLines(text);
    const split = splitBilingualText(safe);
    if (!split) {
        return <span className="call-sub-original">{safe}</span>;
    }
    return (
        <>
            <span className="call-sub-original">{split.original}</span>
            <span className="call-sub-translated">{split.translated}</span>
        </>
    );
}
