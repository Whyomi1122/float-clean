// lib/archive-context-pack.ts — 给「归档」这一步塞满背景资料
//
// 背景（2026-11-11 v7）：归档是独立 LLM 调用，原本只吃「归档规则 + 聊天转录」，
// 拿不到角色卡与世界书，模型只能按常识假设两人在同一空间、顺手补动作。
// 这里把该同步的上下文按顺序拼好一起喂进去（每段都有字数上限，别把转录挤没）：
//   1. 角色设定（persona + 时区）
//   2. 世界书（绑定在「聊天」上的书，全部启用条目）
//   3. 长期记忆（核心记忆 + 长期记忆）
//   4. 既往归档（只当背景，不要求复述）
//
// 归档正文本身仍然只写「这次聊天记录里有的东西」，背景只用于判断地点、关系与已发生过的事。

import { loadCharacters } from "./character-storage";
import { loadWorldBooks, loadBindingConfig, resolveBinding, resolveUserIdentity } from "./settings-storage";
import { loadMemoryConfig } from "./memory-storage";
import {
    retrieveMemoriesForPrompt,
    retrieveCoreMemoriesForPrompt,
    retrieveArchivesForPrompt,
} from "./memory-service";
import { formatArchivesForPrompt, formatLongTermMemories, formatCoreMemories } from "./memory-injector";

const LIMITS = {
    persona: 2000,
    worldBook: 4000,
    memories: 1500,
    archives: 2000,
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
 * 归档用的完整背景包。
 * - settings：人设 + 时区 + 世界书（够判断双方各自在哪、是什么关系）
 * - history：长期记忆 + 既往归档（知道之前发生过什么，避免重复叙述）
 */
export async function buildArchiveContextPack(characterId: string): Promise<{ settings: string; history: string }> {
    if (typeof window === "undefined") return { settings: "", history: "" };
    const settings = [buildSettingsSection(characterId), buildWorldBookSection(characterId)]
        .filter(Boolean)
        .join("\n\n");

    let history = "";
    try {
        const memConfig = loadMemoryConfig();
        const [memResults, coreResults, archiveResults] = await Promise.all([
            retrieveMemoriesForPrompt(characterId, settings, memConfig).catch(() => null),
            retrieveCoreMemoriesForPrompt(characterId, memConfig).catch(() => null),
            retrieveArchivesForPrompt(characterId, memConfig).catch(() => null),
        ]);
        const pieces = [
            coreResults ? clip(formatCoreMemories(coreResults), LIMITS.memories) : "",
            memResults ? clip(formatLongTermMemories(memResults), LIMITS.memories) : "",
            archiveResults ? clip(formatArchivesForPrompt(archiveResults), LIMITS.archives) : "",
        ].filter(Boolean);
        history = pieces.join("\n\n");
    } catch { /* 记忆读不到就算了 */ }

    return { settings, history };
}
