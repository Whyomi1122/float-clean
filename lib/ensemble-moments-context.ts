/**
 * 朋友圈配图 · 剧情对齐上下文（2026-11-02）
 *
 * 朋友圈的「当下」以群像主线为准（群像是 90% 的剧情来源）：
 * 配图/文案生成时注入「最近活跃剧本」的轻量剧情（背景一句 + 最近 8 幕），
 * 解决「群里在走海边剧情、朋友圈却在发上班」的割裂感。
 *
 * 单向阀设计：
 *   · 朋友圈只读群像剧情，绝不写回群像记忆库 / 剧本 turns；
 *   · 不注入归档全文与世界书全文（配图不需要那么重，最近 8 幕足够定场景与氛围）；
 *   · 群像引擎侧不受任何影响，保持纯净注入口径不变。
 */
import { loadEnsembleScripts } from "@/lib/ensemble-storage";
import { resolveUserIdentity } from "@/lib/settings-storage";

/** 每幕截断字数（与投递回放口径一致） */
const TURN_LIMIT = 300;
/** 注入的最近幕数 */
const RECENT_TURNS = 8;
/** 剧本背景截断字数 */
const BACKGROUND_LIMIT = 400;

/**
 * 取「最近活跃的进行中剧本」的轻量剧情块。
 * 没有任何剧本 / 都没有 turns → 返回 null，朋友圈完全不受影响。
 */
export function buildEnsembleMomentsPhotoBlock(): string | null {
    if (typeof window === "undefined") return null;
    const scripts = loadEnsembleScripts().filter(s => (s.turns?.length ?? 0) > 0);
    if (scripts.length === 0) return null;

    // 最近活跃 = updatedAt 最新的那部（发动态时"当下"就应该是它）
    const script = [...scripts].sort((a, b) =>
        (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
    )[0];

    const lines: string[] = [];
    lines.push(`【当下剧情参照 · 群像剧本《${script.title || "未命名剧本"}》正在推进】`);
    lines.push("角色发朋友圈的文案与配图，应当与这条主线当前的场景、地点、时间与氛围一致；若动态内容与最近剧情冲突，一律以剧情为准。");
    if (script.background?.trim()) {
        lines.push(`剧本设定：${script.background.trim().slice(0, BACKGROUND_LIMIT)}`);
    }
    const recent = script.turns.slice(-RECENT_TURNS);
    if (recent.length > 0) {
        lines.push("最近剧情（由旧到新）：");
        for (const t of recent) {
            lines.push(`· ${t.senderName || "旁白"}：${(t.content ?? "").trim().slice(0, TURN_LIMIT)}`);
        }
    }
    return lines.join("\n");
}

/**
 * 画面里是否出现「我」→ 返回用户面具外观词；没有则 undefined。
 * 判定：开启了参考图（自拍检测命中），或描述明确提到自拍/合照/「我和」。
 */
export function userMaskForDescription(
    description: string,
    characterId?: string,
    useReferenceImage?: boolean,
): { positive?: string; negative?: string } | undefined {
    const mentionsMe = useReferenceImage === true
        || /自拍|对镜拍|合照|合影|selfie|group photo|我和/i.test(description);
    if (!mentionsMe || !characterId) return undefined;
    const identity = resolveUserIdentity(characterId, "chat");
    if (!identity) return undefined;
    return {
        positive: identity.imagePromptPositive,
        negative: identity.imagePromptNegative,
    };
}
