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
    scene: 800,
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
 * 当前场景段（2026-11-12 加）：取最近一条群像归档里的「当前锚点」，让归档知道两人此刻在不在同一个空间。
 * 起因：实机里两人明明同处一室，归档却写成「她隔着手机问」——因为模型手上没有场景事实，只能按「手机聊天」想当然。
 * 空间永远以剧情进度为准，模型不许自己假设。
 */
async function buildSceneSection(characterId: string): Promise<string> {
    try {
        const { loadMemoryEntriesByType } = await import("./memory-storage");
        const entries = await loadMemoryEntriesByType(characterId, "archive");
        const latest = entries
            .filter(entry => entry.sourceApp === "ensemble")
            .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))[0];
        if (!latest) return "";
        const content = String(latest.content || "");
        const match = content.match(/═+\s*当前锚点[^\n]*═+([\s\S]*)$/);
        const body = clip(match ? match[1] : "", LIMITS.scene);
        if (!body) return "";
        return `【当前场景（群像剧情的最新进度，空间与在场人物以此为准，不许自己假设）】\n${body}`;
    } catch {
        return "";
    }
}

/**
 * 归档用的完整背景包。
 * - settings：人设 + 时区 + 世界书（够判断双方各自在哪、是什么关系）
 * - memories：长期记忆（知道更早发生过什么，避免重复叙述；上一版归档由归档面板单独喂）
 * - scene：最近一条群像归档的「当前锚点」（空间、在场人物、正在发生的事）
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

    const scene = await buildSceneSection(characterId);

    return { settings, memories, scene };
}
