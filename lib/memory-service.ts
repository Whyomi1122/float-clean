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
    const coreEntries = await loadMemoryEntriesByType(characterId, "core");
    if (coreEntries.length === 0) return [];

    const sorted = [...coreEntries].sort((a, b) => {
        const aActive = a.metadata?.active ? 1 : 0;
        const bActive = b.metadata?.active ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        const aDate = String(a.metadata?.eventDate ?? a.updatedAt ?? a.createdAt);
        const bDate = String(b.metadata?.eventDate ?? b.updatedAt ?? b.createdAt);
        return bDate.localeCompare(aDate);
    });

    return fillByBudget(sorted, config.coreMemoryTokenBudget);
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
    // 归档预算：借用 longTermTokenBudget（归档与大记忆共用一段大预算）
    return fillByBudget(sorted, config.longTermTokenBudget);
}

/**
 * 写入一条归档（人工确认后调用）。
 * 重量级＝世界书同级；受防污染约束（墓碑 / 指纹去重）。
 */
export async function commitArchive(
    characterId: string,
    content: string,
    sourceApp: MemoryEntry["sourceApp"] = "chat",
): Promise<{ success: boolean; error?: string }> {
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
        return { success: true };
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
        metadata: { contentHash: hash, archivedAt: now },
    });
    return { success: true };
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
