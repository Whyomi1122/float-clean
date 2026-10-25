// lib/memory-summarizer.ts
// Auto-summarization engine: summarizes short-term events into long-term memories.
// Trigger: every N events (configurable). Short-term events are NOT deleted after summarization.

import type { MemoryEntry } from "./memory-types";
import { DEFAULT_SUMMARIZATION_PROMPT } from "./memory-types";
import {
    loadMemoryConfig,
    loadMemoryEntries,
    saveMemoryEntry,
    deleteMemoryEntries,
    getEventCounter,
    resetEventCounter,
    getGroupLastSummarizedTimestamp,
    setGroupLastSummarizedTimestamp,
    setLastSummarizedTimestamp,
    incrementCoreMemoryCounter,
} from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { loadNativeTimeline, formatTimelineForSummarization, filterTimelineByAllowedSources } from "./short-term-assembler";
import { generateEmbedding, resolveEmbeddingModel } from "./memory-embedding";
import { simpleLLMCall } from "./api-helpers";
import { maybeRunCoreMemoryPipeline } from "./core-memory-builder";

/** Per-character lock to prevent concurrent summarization. */
const summarizingSet = new Set<string>();

/**
 * 总结分组：来源 app（聊天按私聊/群聊拆开，内容天然分开便于分组管理）。
 * 返回 [groupKey, 展示名]。
 */
function resolveSummaryGroup(entry: { sourceApp: string; sourceDetail?: string }): { key: string; label: string } {
    if (entry.sourceApp === "chat") {
        return entry.sourceDetail === "group"
            ? { key: "group_chat", label: "群聊" }
            : { key: "chat", label: "聊天室普通模式" };
    }
    return { key: entry.sourceApp, label: entry.sourceApp };
}

/** 每组最少事件数：不满则留存进度下轮再总结 */
const GROUP_MIN_EVENTS = 3;

/**
 * Check if summarization should run based on event counter, then execute.
 * Trigger: counter >= summarizationEventInterval.
 * API config is resolved from auxiliary binding (global, not per-character).
 */
export async function maybeRunSummarization(
    characterId: string,
    characterName: string
): Promise<void> {
    const config = loadMemoryConfig();
    if (!config.autoSummarizeEnabled) return;

    const counter = getEventCounter(characterId);
    if (counter < config.summarizationEventInterval) return;

    if (summarizingSet.has(characterId)) return;
    summarizingSet.add(characterId);
    try {
        await runSummarizationPipeline(characterId, characterName);
    } finally {
        summarizingSet.delete(characterId);
    }
}

/**
 * Run the full summarization pipeline.
 * Reads events since last summarization, summarizes them, saves as long-term memory.
 * Does NOT delete short-term events — they are only trimmed by token budget elsewhere.
 * API config is resolved from auxiliary binding (global, not per-character).
 */
export async function runSummarizationPipeline(
    characterId: string,
    characterName: string,
    options?: {
        force?: boolean;
        /** 手动指定总结起点（覆盖进度水位线）；force 为真时忽略 */
        sinceTimestamp?: string;
    }
): Promise<{ success: boolean; error?: string }> {
    const config = loadMemoryConfig();

    // Resolve API from auxiliary binding
    const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig) {
        return { success: false, error: "未配置记忆总结 API（请在绑定配置 → 辅助API绑定中设置）" };
    }

    // Read native app data (chat messages, moments) directly — no separate event log.
    // 记忆来源开关同样作用于长期总结：被关掉的来源不进总结素材。
    // 一次拉全量，再按组各自用水位线过滤——各组进度独立，小来源攒够门槛才总结。
    const allEntries = filterTimelineByAllowedSources(
        loadNativeTimeline(characterId),
        config.shortTermAllowedSources,
    );

    if (allEntries.length === 0) {
        if (!options?.force) resetEventCounter(characterId);
        return { success: false, error: "没有可总结的事件" };
    }

    // 按来源分组（聊天拆私聊/群聊），各组独立总结、独立水位线
    const groups = new Map<string, { label: string; entries: typeof allEntries }>();
    for (const entry of allEntries) {
        const g = resolveSummaryGroup(entry);
        if (!groups.has(g.key)) groups.set(g.key, { label: g.label, entries: [] });
        groups.get(g.key)!.entries.push(entry);
    }

    const manual = Boolean(options?.force || options?.sinceTimestamp);
    const promptTemplate = config.summarizationPrompt?.trim() || DEFAULT_SUMMARIZATION_PROMPT;
    let savedCount = 0;
    let lastError: string | undefined;
    let anyPending = false;
    let globalLatest: string | undefined;

    for (const [groupKey, group] of groups) {
        // 组水位线：手动总结用指定起点（force 则全量），自动总结用组自己的进度
        const groupAfter = options?.force
            ? undefined
            : options?.sinceTimestamp ?? getGroupLastSummarizedTimestamp(characterId, groupKey) ?? undefined;
        const groupEntries = groupAfter
            ? group.entries.filter(e => e.timestamp > groupAfter)
            : group.entries;
        if (groupEntries.length === 0) continue;
        // 门槛：自动总结时每组不满 3 条留存下轮（水位线不动）；手动总结不设门槛，有多少总结多少
        if (!manual && groupEntries.length < GROUP_MIN_EVENTS) {
            anyPending = true;
            continue;
        }

        const formatted = formatTimelineForSummarization(groupEntries);
        if (!formatted) { lastError = "格式化事件数据失败"; continue; }
        const { eventsText, earliest, latest } = formatted;

        const summaryPrompt = promptTemplate
            .replace(/\{\{char\}\}/gi, characterName)
            .replace(/\{\{earliest\}\}/gi, earliest)
            .replace(/\{\{latest\}\}/gi, latest)
            .replace(/\{\{events\}\}/gi, eventsText);

        // label 用于在「底层调用大模型日志」中标识这是记忆总结调用（按组标注）
        const result = await simpleLLMCall(
            apiConfig,
            [{ role: "user", content: summaryPrompt }],
            { temperature: 0.3, label: `记忆总结·${characterName}·${group.label}` },
        );

        if (!result.content) {
            lastError = result.error || "LLM 返回了空内容";
            continue;
        }

        if (result.wasTruncated) {
            console.warn("[MemorySummarizer] Summary generation truncated:", result.finishReason);
            lastError = "记忆总结结果疑似被截断，已取消入库，请稍后重试或提高模型输出上限";
            continue;
        }

        const summary = result.content;

        // Generate embedding for the summary (only if vector recall is enabled)
        let embedding: number[] | undefined;
        const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
        if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
            try {
                const emb = await generateEmbedding(summary, embeddingApiConfig);
                if (emb) embedding = emb;
            } catch { /* ignore */ }
        }

        const sourceSessionIds = Array.from(new Set(
            groupEntries
                .map(entry => entry.sessionId)
                .filter((sessionId): sessionId is string => Boolean(sessionId)),
        ));

        // Save as long-term memory（sourceApp 填真实来源）
        const now = new Date().toISOString();
        const longTermEntry: MemoryEntry = {
            id: `mem_lt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            characterId,
            sourceApp: (groupKey === "group_chat" ? "chat" : groupKey) as MemoryEntry["sourceApp"],
            type: "long_term",
            content: summary,
            embedding,
            importance: 0.8,
            createdAt: now,
            updatedAt: now,
            metadata: {
                summarizedEvents: groupEntries.length,
                timeSpan: `${earliest} ~ ${latest}`,
                sourceSessionIds,
                summaryGroup: groupKey,
            },
        };
        await saveMemoryEntry(longTermEntry);
        savedCount++;

        // 组水位线推到该组最新事件；全局水位线同步推到全局最新（兼容旧读取方）
        setGroupLastSummarizedTimestamp(characterId, groupKey, latest);
        if (!globalLatest || latest > globalLatest) globalLatest = latest;
    }

    if (savedCount === 0) {
        if (!options?.force && !anyPending) resetEventCounter(characterId);
        return { success: false, error: lastError || "没有可总结的事件" };
    }

    // Update last summarized timestamp + reset counter
    if (globalLatest) setLastSummarizedTimestamp(characterId, globalLatest);
    resetEventCounter(characterId);

    // Enforce long-term limit
    const allLongTerm = await loadMemoryEntries(characterId);
    if (allLongTerm.length > config.maxLongTermEntries) {
        const excess = allLongTerm.slice(0, allLongTerm.length - config.maxLongTermEntries);
        await deleteMemoryEntries(excess.map(e => e.id));
    }

    incrementCoreMemoryCounter(characterId);
    await maybeRunCoreMemoryPipeline(characterId, characterName);

    console.log(`[MemorySummarizer] Summarized ${allEntries.length} entries → ${savedCount} long-term memories (by source group)`);
    return { success: true };
}
