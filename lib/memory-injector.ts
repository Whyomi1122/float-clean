// lib/memory-injector.ts
// Formats long-term memory entries into injectable prompt text.

import type { MemoryEntry } from "./memory-types";

/**
 * Format long-term memories for prompt injection.
 * The service layer already handles token-budget filtering,
 * so this just formats the selected entries.
 */
export function formatLongTermMemories(memories: MemoryEntry[]): string {
    if (memories.length === 0) return "";

    const lines: string[] = [];
    for (const entry of memories) {
        lines.push(`- ${entry.content}`);
    }
    return lines.join("\n");
}

export function formatCoreMemories(memories: MemoryEntry[]): string {
    if (memories.length === 0) return "";

    const lines: string[] = [];
    for (const entry of memories) {
        lines.push(`- ${entry.content}`);
    }
    return lines.join("\n");
}

/**
 * Format archives for prompt injection（2026-11-01 回流项目）。
 * 归档＝重量级（世界书同级），注入时排在长期记忆之前、给「归档」标记，
 * service 层已按时间倒序 + token 预算裁剪（超预算从最旧省略）。
 * 群像剧情归档镜像（sourceApp:"ensemble"）与普通聊天归档同级混排。
 */
export function formatArchivesForPrompt(archives: MemoryEntry[]): string {
    if (archives.length === 0) return "";
    return archives.map(entry => `【归档】${entry.content}`).join("\n");
}
