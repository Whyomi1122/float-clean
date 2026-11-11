// lib/memory-service.ts
// High-level memory orchestration: retrieve long-term memories for prompt injection.

import type { MemoryConfig, MemoryEntry } from "./memory-types";
import { loadMemoryEntriesByType } from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { generateEmbedding, resolveEmbeddingModel, cosineSimilarity } from "./memory-embedding";
import { estimateTokens } from "./token-counter";

/**
 * Retrieve relevant long-term memories for prompt injection.
 * Strategy:
 *   1. Total tokens <= longTermTokenBudget → return all
 *   2. Over budget + embedding API configured → vector-rank, fill until budget
 *   3. Over budget + no embedding → time-sorted (newest first), fill until budget
 * Embedding API is resolved from auxiliary binding (global, not per-character).
 */
export async function retrieveMemoriesForPrompt(
    characterId: string,
    currentContext: string,
    config: MemoryConfig
): Promise<MemoryEntry[]> {
    const longTermEntries = await loadMemoryEntriesByType(characterId, "long_term");
    if (longTermEntries.length === 0 || !currentContext.trim()) return [];

    const budget = config.longTermTokenBudget;

    // Calculate total tokens for all entries
    let totalTokens = 0;
    for (const entry of longTermEntries) {
        totalTokens += estimateTokens(entry.content) + 4;
    }

    // Strategy 1: all fit within budget → return all
    if (totalTokens <= budget) {
        return longTermEntries;
    }

    // Strategy 2: vector recall enabled + embedding API configured → vector search, fill by relevance
    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
        const queryEmbedding = await generateEmbedding(currentContext, embeddingApiConfig);
        if (queryEmbedding) {
            const withEmbeddings = longTermEntries.filter(m => m.embedding && m.embedding.length > 0);
            if (withEmbeddings.length > 0) {
                const scored = withEmbeddings.map(entry => ({
                    entry,
                    score: cosineSimilarity(queryEmbedding, entry.embedding!),
                }));
                scored.sort((a, b) => b.score - a.score);
                return fillByBudget(scored.map(s => s.entry), budget);
            }
        }
    }

    // Strategy 3: no embedding support → newest first, fill by budget
    const sorted = [...longTermEntries].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    return fillByBudget(sorted, budget);
}

export async function retrieveCoreMemoriesForPrompt(
    characterId: string,
    config: MemoryConfig,
): Promise<MemoryEntry[]> {
    // 核心记忆管线已废弃（2026-10-15），注入同步停用（2026-11-01 C 项清理）：
    // 历史 core 条目只读保留在存储里，不再进提示词；恢复只需删掉这一行 return。
    void characterId;
    void config;
    return [];
}

/** Pick entries in order until token budget is exhausted. */
function fillByBudget(entries: MemoryEntry[], budget: number): MemoryEntry[] {
    const result: MemoryEntry[] = [];
    let used = 0;
    for (const entry of entries) {
        const tokens = estimateTokens(entry.content) + 4;
        if (used + tokens > budget) break;
        result.push(entry);
        used += tokens;
    }
    return result;
}

/**
 * 归档：人工确认的长文档，重量级＝世界书同级。
 * 不参与相关度筛选（归档始终注入），仅按 token 预算截断（最新的优先保留）。
 * （群像【返回剧情】把剧情对话段归档进长期记忆时使用。）
 */
export async function retrieveArchivesForPrompt(
    characterId: string,
    config: MemoryConfig,
): Promise<MemoryEntry[]> {
    const archives = await loadMemoryEntriesByType(characterId, "archive");
    if (archives.length === 0) return [];
    const sorted = [...archives].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    // 群像归档去重（2026-11-09 用户口径）：同一剧本只注入最新一条。
    // 群像每次杀青都会写一条新归档，旧归档留着没有任何信息增量，只是把提示词撑长。
    // 写入侧已经会清掉旧条目，这里是兜底（老数据 / 清理失败时也不会重复注入）。
    const seenEnsembleKeys = new Set<string>();
    const deduped = sorted.filter(entry => {
        const key = ensembleArchiveKey(entry);
        if (!key) return true;
        if (seenEnsembleKeys.has(key)) return false;
        seenEnsembleKeys.add(key);
        return true;
    });
    // 归档预算：借用 longTermTokenBudget（归档与大记忆共用一段大预算）
    return fillByBudget(deduped, config.longTermTokenBudget);
}

/**
 * 群像归档的"同一份剧本"分组键：优先用写入时打的 ensembleScriptId，
 * 老数据没有这个字段时退化成解析正文头部的 `【群像剧情 · 标题 · 日期】`。
 * 非群像归档返回 null（不参与去重）。
 */
function ensembleArchiveKey(entry: MemoryEntry): string | null {
    if (entry.sourceApp !== "ensemble") return null;
    const tagged = entry.metadata?.ensembleScriptId;
    if (typeof tagged === "string" && tagged.trim()) return `id:${tagged.trim()}`;
    const match = /【群像剧情 · ([^】\n]+)】/.exec(entry.content);
    if (!match) return null;
    const title = match[1].split(" · ")[0].trim();
    return title ? `title:${title}` : null;
}

/**
 * 写入一条归档（人工确认后调用）。
 * 重量级＝世界书同级；受防污染约束（墓碑 / 指纹去重）。
 */
export async function commitArchive(
    characterId: string,
    content: string,
    sourceApp: MemoryEntry["sourceApp"] = "chat",
    /** 额外元信息（群像用它记录 ensembleScriptId，注入侧据此同剧本只留最新）。 */
    extraMetadata: Record<string, unknown> = {},
): Promise<{ success: boolean; error?: string; contentHash?: string }> {
    const trimmed = content.trim();
    if (!trimmed) return { success: false, error: "内容为空" };

    const { computeContentHash } = await import("./memory-types");
    const { addDeletedHash, isHashedDeleted, saveMemoryEntry } = await import("./memory-storage");

    const hash = computeContentHash(trimmed);
    if (isHashedDeleted(characterId, hash)) {
        return { success: false, error: "该内容已被标记删除，忽略" };
    }
    const existing = await loadMemoryEntriesByType(characterId, "archive");
    if (existing.some(e => (e.metadata?.contentHash as string) === hash)) {
        return { success: true, contentHash: hash };
    }

    const now = new Date().toISOString();
    await saveMemoryEntry({
        id: `mem_arc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        characterId,
        sourceApp,
        type: "archive",
        content: trimmed,
        importance: 1.0,
        createdAt: now,
        updatedAt: now,
        metadata: { contentHash: hash, archivedAt: now, ...extraMetadata },
    });
    return { success: true, contentHash: hash };
}

/**
 * 原地更新一条归档（普通模式归档是「单条滚动」的：增量追加，不新建、不删旧）。
 */
export async function updateArchiveEntry(
    characterId: string,
    entryId: string,
    content: string,
): Promise<{ success: boolean; error?: string; contentHash?: string }> {
    const trimmed = content.trim();
    if (!trimmed) return { success: false, error: "内容为空" };

    const { computeContentHash } = await import("./memory-types");
    const { saveMemoryEntry } = await import("./memory-storage");

    const existing = await loadMemoryEntriesByType(characterId, "archive");
    const target = existing.find(entry => entry.id === entryId);
    if (!target) return { success: false, error: "找不到那条归档（可能已被删除）" };

    const hash = computeContentHash(trimmed);
    const now = new Date().toISOString();
    await saveMemoryEntry({
        ...target,
        content: trimmed,
        updatedAt: now,
        metadata: { ...(target.metadata || {}), contentHash: hash, archivedAt: now },
    });
    return { success: true, contentHash: hash };
}

/**
 * 聊天归档「同角色只留最新」：写入新的普通模式归档后，把本聊天室更旧的归档清掉。
 * 刻意不走 deleteArchive（不进墓碑），否则用户之后重写同样内容会被指纹拦下。
 * 一起听记录（metadata.listenRecord）与群像归档（ensembleScriptId）不在此列，各自保留。
 */
export async function pruneOlderChatArchives(characterId: string, keepContentHash: string): Promise<number> {
    const { deleteMemoryEntry } = await import("./memory-storage");
    const existing = await loadMemoryEntriesByType(characterId, "archive");
    const stale = existing.filter((entry) => {
        if (entry.sourceApp !== "chat") return false;
        if (entry.metadata?.contentHash === keepContentHash) return false;
        if (entry.metadata?.listenRecord) return false;
        if (entry.metadata?.ensembleScriptId) return false;
        return true;
    });
    for (const entry of stale) {
        await deleteMemoryEntry(entry.id);
    }
    return stale.length;
}

/** 删除一条归档（进墓碑，防复活）。 */
export async function deleteArchive(characterId: string, entryId: string): Promise<void> {
    const { deleteMemoryEntry, addDeletedHash } = await import("./memory-storage");
    const existing = await loadMemoryEntriesByType(characterId, "archive");
    const target = existing.find(e => e.id === entryId);
    if (target) {
        const { computeContentHash } = await import("./memory-types");
        addDeletedHash(characterId, computeContentHash(target.content));
    }
    await deleteMemoryEntry(entryId);
}
