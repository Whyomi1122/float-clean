// lib/archive-context-pack.ts — 给「归档」这一步塞满背景资料
//
// 背景（2026-11-11 v7）：归档是独立 LLM 调用，原本只吃「归档规则 + 聊天转录」，
// 拿不到角色卡与世界书，模型只能按常识假设两人在同一空间、顺手补动作。
// 这里把该同步的上下文按顺序拼好一起喂进去（每段都有字数上限，别把转录挤没）：
//   1. 角色设定（persona + 时区）
//   2. 世界书（绑定在「聊天」上的书，全部启用条目）
//   3. 长期记忆（核心记忆已于 2026-10-15 废弃，不再注入；归档由归档面板单独喂）
//   4. 归档的「上一版」不在这里读：归档面板自己读最新那条，避免重复注入。
//
// 归档正文本身仍然只写「这次聊天记录里有的东西」，背景只用于判断地点、关系与已发生过的事。

import { loadCharacters } from "./character-storage";
import { loadWorldBooks, loadBindingConfig, resolveBinding, resolveUserIdentity } from "./settings-storage";
import { loadMemoryConfig } from "./memory-storage";
import { retrieveMemoriesForPrompt } from "./memory-service";
import { formatLongTermMemories } from "./memory-injector";

const LIMITS = {
    persona: 2000,
    worldBook: 4000,
    memories: 1500,
    scene: 4000,
};

function clip(text: string, max: number): string {
    const value = (text || "").trim();
    if (!value) return "";
    if (value.length <= max) return value;
    return value.slice(0, max) + "\n…（后略）";
}

/** 角色设定段：persona 全文 + 时区（时区是判断「各自在哪」最硬的线索）。 */
function buildSettingsSection(characterId: string): string {
    const parts: string[] = [];
    try {
        const character = loadCharacters().find(c => c.id === characterId);
        if (!character) return "";
        const name = character.name || "角色";
        const lines: string[] = [];
        if (character.timeZone) lines.push(`· ${name} 所在时区：${character.timeZone}`);
        if (character.personality) lines.push(`· 性格：${clip(character.personality, 300)}`);
        const userIdentity = resolveUserIdentity(characterId, "chat");
        if (userIdentity?.name) lines.push(`· 用户在${name}这里的称呼：${userIdentity.name}`);
        if (lines.length > 0) parts.push(lines.join("\n"));
        const persona = clip(character.persona || "", LIMITS.persona);
        if (persona) parts.push(`【${name}·设定】\n${persona}`);
    } catch { /* 角色卡读不到就算了 */ }
    return parts.join("\n\n");
}

/** 世界书段：绑定在「聊天」上的书，全部启用条目（comment/key 当小标题）。 */
function buildWorldBookSection(characterId: string): string {
    const chunks: string[] = [];
    try {
        const slot = resolveBinding(loadBindingConfig(), characterId, "chat");
        const allBooks = loadWorldBooks();
        const ids = slot?.worldBookIds || [];
        let used = 0;
        for (const id of ids) {
            const book = allBooks.find(item => item.id === id);
            if (!book) continue;
            for (const entry of book.entries || []) {
                if (entry.disable) continue;
                const body = (entry.content || "").trim();
                if (!body) continue;
                const title = (entry.comment || entry.key || "").trim();
                const text = title ? `【${title}】\n${body}` : body;
                if (used + text.length > LIMITS.worldBook) {
                    chunks.push("…（世界书后略）");
                    return chunks.join("\n\n");
                }
                chunks.push(text);
                used += text.length;
            }
        }
    } catch { /* 世界书读不到就算了 */ }
    return chunks.join("\n\n");
}

/**
 * 群像背景段（2026-11-12 加，`a87d7ad` 起）：
 * 与聊天室「投递段」同一口径 —— **群像归档全文合并注入**，再加上最新一条的「当前锚点」。
 * 起因：实机里两人明明同处一室，归档却写成「她隔着手机问」；只抽锚点还不够，
 * 归档和聊天 AI 必须看到同一份剧情真相，否则会出现「归档记得的和聊天记得的不一样」。
 */
async function buildEnsembleSection(characterId: string): Promise<string> {
    try {
        const { loadMemoryEntriesByType } = await import("./memory-storage");
        const entries = await loadMemoryEntriesByType(characterId, "archive");
        const latest = entries
            .filter(entry => entry.sourceApp === "ensemble")
            .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))[0];
        if (!latest) return "";
        const content = String(latest.content || "");
        const anchorMatch = content.match(/═+\s*当前锚点[^\n]*═+([\s\S]*)$/);
        const archiveBody = (anchorMatch ? content.slice(0, anchorMatch.index) : content).trim();
        const anchor = anchorMatch ? anchorMatch[1].trim() : "";

        const parts: string[] = [];
        if (archiveBody) {
            parts.push(
                "【剧情归档 · 已杀青总结（与聊天室同口径，这是两人过往剧情的唯一真相，请以它为准）】\n" +
                clip(archiveBody, LIMITS.scene),
            );
        }
        if (anchor) {
            parts.push("【当前场景（空间、时间、在场人物以此为准，不许自己假设）】\n" + clip(anchor, 1200));
        }
        return parts.join("\n\n");
    } catch {
        return "";
    }
}

/**
 * 设置页「对齐剧情时间」用（2026-11-12）：
 * 在所有角色里找**最新一条群像归档**的「当前锚点」原文，交给剧情时钟解析。
 */
export async function findLatestEnsembleAnchor(): Promise<{ characterId: string; characterName: string; anchor: string; updatedAt: string } | null> {
    if (typeof window === "undefined") return null;
    try {
        const { loadMemoryEntriesByType } = await import("./memory-storage");
        const characters = loadCharacters();
        let best: { characterId: string; characterName: string; anchor: string; updatedAt: string } | null = null;
        for (const character of characters) {
            const entries = await loadMemoryEntriesByType(character.id, "archive").catch(() => []);
            for (const entry of entries) {
                if (entry.sourceApp !== "ensemble") continue;
                const content = String(entry.content || "");
                const anchorMatch = content.match(/═+\s*当前锚点([^\n]*)═+([\s\S]*)$/);
                if (!anchorMatch) continue;
                const body = anchorMatch[2].trim();
                if (!body) continue;
                const anchor = `当前锚点${anchorMatch[1] || ""}\n${body}`.trim();
                const updatedAt = String(entry.updatedAt || entry.createdAt || "");
                if (!best || updatedAt.localeCompare(best.updatedAt) > 0) {
                    best = { characterId: character.id, characterName: character.name || "角色", anchor, updatedAt };
                }
            }
        }
        return best;
    } catch {
        return null;
    }
}

/**
 * 归档用的完整背景包。
 * - settings：人设 + 时区 + 世界书（够判断双方各自在哪、是什么关系）
 * - memories：长期记忆（知道更早发生过什么，避免重复叙述；上一版归档由归档面板单独喂）
 * - scene：群像归档全文 + 最新「当前锚点」（空间、时间、在场人物、正在发生的事）
 */
export async function buildArchiveContextPack(characterId: string): Promise<{ settings: string; memories: string; scene: string }> {
    if (typeof window === "undefined") return { settings: "", memories: "", scene: "" };
    const settings = [buildSettingsSection(characterId), buildWorldBookSection(characterId)]
        .filter(Boolean)
        .join("\n\n");

    // 只给长期记忆：归档本身（上一版）由归档面板单独喂，避免重复注入
    let memories = "";
    try {
        const memConfig = loadMemoryConfig();
        const memResults = await retrieveMemoriesForPrompt(characterId, settings, memConfig).catch(() => null);
        if (memResults) memories = clip(formatLongTermMemories(memResults), LIMITS.memories);
    } catch { /* 记忆读不到就算了 */ }

    const scene = await buildEnsembleSection(characterId);

    return { settings, memories, scene };
}
