/**
 * 其他 App 注入管线（2026-11-02 用户拍板）
 * ─────────────────────────────────────────────────────────────────────
 * 口径：
 *  · 每个 AI 类 App 一个独立开关，**默认关**——开了才给，不开不给；
 *  · 开启后注入 = 长期记忆（安全的，走既有 retrieveMemoriesForPrompt）
 *    + 群像剧情归档（retrieveArchivesForPrompt，【归档】标记格式）
 *    + 剧本绑定世界书（按角色所在剧本 → worldBookIds → 激活管线）；
 *  · 人设（角色卡自带）各引擎本来就注入，本模块不重复处理。
 *
 * 集成方式：引擎把原来的 `formatLongTermMemories(retrieveMemoriesForPrompt(...))`
 * 换成 `buildAppInjectionMemories(...)`，并在组装 worldBooks 时把
 * `getScriptWorldBooksForCharacter(...)` 的结果合并进去（开关关闭时两个函数都退化为原行为）。
 */

import { kvGet, kvSet } from "./kv-db";
import type { MemoryConfig, MemoryEntry } from "./memory-types";
import { retrieveMemoriesForPrompt, retrieveArchivesForPrompt } from "./memory-service";
import { formatArchivesForPrompt, formatLongTermMemories } from "./memory-injector";
import { loadEnsembleScripts } from "./ensemble-storage";
import { loadWorldBooks } from "./settings-storage";
import { buildEnsembleWorldBookBlock, pickBoundBooks, type StickyLedger } from "./ensemble-worldbook";
import { collectCastCharacterIds } from "./ensemble-memory-bridge";
import type { WorldBookConfig } from "./settings-types";

/** 可注入的 App 清单（设置页渲染用）。id 与引擎调用方传入的 appId 一致。 */
export const APP_INJECTION_APPS: { id: string; name: string; desc: string }[] = [
    { id: "vn", name: "视觉小说", desc: "视觉小说 App 的 AI 对话" },
    { id: "story", name: "故事", desc: "故事/剧情类 App 的 AI 对话" },
    { id: "cocreate", name: "共创", desc: "共创 App 的 AI 对话" },
    { id: "diary", name: "日记", desc: "AI 日记生成" },
    { id: "dwelling", name: "栖所", desc: "栖所 App 的 AI 对话" },
    { id: "reading", name: "漫卷", desc: "漫卷/读书 App 的 AI 对话" },
    { id: "map", name: "地图", desc: "地图冒险 App 的 AI 对话" },
    { id: "black-market", name: "黑市", desc: "黑市场景的 AI 对话" },
    { id: "game", name: "游戏", desc: "游戏 App 的 AI 对话" },
];

const injectionKey = (appId: string) => `appInjection:${appId}`;

/** 开关是否打开。默认关：只有显式存过 "1" 才算开。 */
export function isAppInjectionEnabled(appId: string): boolean {
    if (typeof window === "undefined") return false;
    return kvGet(injectionKey(appId)) === "1";
}

export function setAppInjectionEnabled(appId: string, enabled: boolean): void {
    if (typeof window === "undefined") return;
    if (enabled) kvSet(injectionKey(appId), "1");
    else kvSet(injectionKey(appId), "0");
}

/**
 * 长期记忆 + 归档 的合并注入（替代各引擎里 `formatLongTermMemories(retrieveMemoriesForPrompt(...))`）。
 * 开关关闭时行为与原来完全一致（只给长期记忆）。
 */
export async function buildAppInjectionMemories(
    characterId: string,
    context: string,
    config: MemoryConfig,
    appId: string,
): Promise<string> {
    const longTerm = await retrieveMemoriesForPrompt(characterId, context, config).catch(() => [] as MemoryEntry[]);
    if (!isAppInjectionEnabled(appId)) {
        return formatLongTermMemories(longTerm);
    }
    const archives = await retrieveArchivesForPrompt(characterId, config).catch(() => [] as MemoryEntry[]);
    return [formatArchivesForPrompt(archives), formatLongTermMemories(longTerm)]
        .filter(part => part.trim().length > 0)
        .join("\n");
}

/**
 * 剧本绑定世界书注入块（其他 App 用）。
 * 找出该角色参与的群像剧本 → 各剧本绑定的 worldBookIds → 按上下文走激活管线（常驻/关键词/sticky）。
 * 开关关闭时返回空串（引擎侧无需再判）。
 */
export async function buildAppScriptWorldBookBlock(
    characterId: string,
    contextText: string,
    appId: string,
): Promise<string> {
    if (!isAppInjectionEnabled(appId)) return "";
    try {
        const scripts = loadEnsembleScripts();
        const bookIds = new Set<string>();
        for (const script of scripts) {
            if (!collectCastCharacterIds(script).includes(characterId)) continue;
            for (const id of script.worldBookIds ?? []) bookIds.add(id);
        }
        if (bookIds.size === 0) return "";
        const books = pickBoundBooks(loadWorldBooks(), [...bookIds]);
        if (books.length === 0) return "";
        const ledger: StickyLedger = new Map();
        const result = buildEnsembleWorldBookBlock(books, contextText, ledger);
        return result.text;
    } catch {
        return "";
    }
}

/** 同步版：拿到角色参与的剧本绑定的世界书（开关关闭时返回空数组）。 */
export function getScriptWorldBooksForCharacter(characterId: string, appId: string): WorldBookConfig[] {
    if (!isAppInjectionEnabled(appId)) return [];
    try {
        const scripts = loadEnsembleScripts();
        const bookIds = new Set<string>();
        for (const script of scripts) {
            if (!collectCastCharacterIds(script).includes(characterId)) continue;
            for (const id of script.worldBookIds ?? []) bookIds.add(id);
        }
        if (bookIds.size === 0) return [];
        return pickBoundBooks(loadWorldBooks(), [...bookIds]);
    } catch {
        return [];
    }
}
