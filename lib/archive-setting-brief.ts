// lib/archive-setting-brief.ts — 给「归档」这一步补一点设定常识
//
// 背景（2026-11-11 v7）：归档是独立 LLM 调用，只吃「归档规则 + 聊天转录」，
// 拿不到角色卡与世界书，模型只能按常识假设两人在同一空间，
// 于是写出「歪头看向手机屏幕」「把手机推过来」这类异地不可能发生的动作。
//
// 这里不去拼完整世界书，只挑和「所在地 / 时区 / 关系」相关的几行（最多 6 行、500 字），
// 作为【设定】一并发给模型，仅用于判断双方各自在哪、是什么关系，不得据此编造事件。

import { loadWorldBooks, loadBindingConfig, resolveBinding } from "./settings-storage";
import { loadCharacters } from "./character-storage";

/** 只挑和空间/关系有关的行：所在地、城市、时区、异地、关系、称呼。 */
const PLACE_RELATION_RE =
    /所在|位于|住在|居住|定居|老家|城市|国家|时差|时区|异地|两地|距离|首尔|国内|北京|上海|广州|深圳|杭州|成都|东京|关系|恋人|情侣|朋友|同事|搭档|称呼|身份|工作|职业/;

const MAX_LINES = 6;
const MAX_CHARS = 500;

function pickLines(text: string, picked: string[]): void {
    for (const raw of (text || "").split(/\r?\n/)) {
        const line = raw.replace(/^[·•\-*\s]+/, "").trim();
        if (line.length < 4 || line.length > 100) continue;
        if (!PLACE_RELATION_RE.test(line)) continue;
        if (picked.some(exist => exist === line)) continue;
        picked.push(line);
        if (picked.length >= MAX_LINES) return;
    }
}

/**
 * 生成归档用设定摘要；拿不到任何设定时返回空串（调用方直接跳过这一段）。
 */
export function buildArchiveSettingBrief(characterId: string, characterName: string): string {
    if (typeof window === "undefined") return "";
    const picked: string[] = [];
    try {
        const character = loadCharacters().find(c => c.id === characterId);
        if (character?.timeZone) {
            const tz = String(character.timeZone).trim();
            picked.push(`${characterName} 所在时区：${tz}`);
        }
        if (character?.persona) pickLines(character.persona, picked);
    } catch { /* 角色卡读不到就算了 */ }

    if (picked.length < MAX_LINES) {
        try {
            const slot = resolveBinding(loadBindingConfig(), characterId, "chat");
            const allBooks = loadWorldBooks();
            const books = (slot.worldBookIds || [])
                .map(id => allBooks.find(book => book.id === id))
                .filter(Boolean) as NonNullable<ReturnType<typeof loadWorldBooks>[number]>[];
            for (const book of books) {
                for (const entry of book.entries || []) {
                    if (entry.disable) continue;
                    pickLines(entry.content, picked);
                    if (picked.length >= MAX_LINES) break;
                }
                if (picked.length >= MAX_LINES) break;
            }
        } catch { /* 世界书读不到就算了 */ }
    }

    if (picked.length === 0) return "";
    const lines: string[] = [];
    let used = 0;
    for (const line of picked) {
        used += line.length + 3;
        if (used > MAX_CHARS) break;
        lines.push(`· ${line}`);
    }
    return lines.join("\n");
}
