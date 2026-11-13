// lib/story-scope.ts — 角色 → 剧本 的映射（2026-11-13，剧情时间「按剧本分组」配套）
//
// 剧情时钟是**按剧本**分线的：同一剧本的角色共享一条时间线。
// 映射的唯一事实来源是群像归档的 metadata（lib/ensemble-memory-bridge.ts 写入的
// ensembleScriptId / ensembleScriptTitle）—— 角色进过哪个剧本，它的群像归档里就有。
//
// 这里把「角色 → 剧本」缓存到 localStorage，好处是读取同步（getStoryScopeForCharacter
// 会被生成回复、界面时间这些高频路径调用），刷新走 refreshStoryScopes()：
//   · App 启动时一次
//   · 打开剧情时间设置页 / 群像归档后一次
import type { StoryScope } from "./story-clock";

const SCOPE_KEY = "ai_phone_story_scope_v1";

type ScopeMap = Record<string, { scriptId: string; scriptTitle: string }>;

let cached: ScopeMap | null = null;

function readMap(): ScopeMap {
    if (typeof window === "undefined") return {};
    try {
        const raw = localStorage.getItem(SCOPE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as ScopeMap;
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

function getMap(): ScopeMap {
    if (!cached) cached = readMap();
    return cached;
}

function writeMap(map: ScopeMap) {
    cached = map;
    if (typeof window === "undefined") return;
    try {
        localStorage.setItem(SCOPE_KEY, JSON.stringify(map));
    } catch {
        /* ignore */
    }
}

/** 这个角色属于哪个剧本（没有则 null = 走默认时间线） */
export function getStoryScopeForCharacter(characterId?: string | null): StoryScope {
    if (!characterId) return null;
    const entry = getMap()[characterId];
    return entry?.scriptId || null;
}

export function getStoryScriptTitle(scriptId: StoryScope): string {
    if (!scriptId) return "默认时间线";
    const hit = Object.values(getMap()).find(entry => entry.scriptId === scriptId);
    return hit?.scriptTitle || "群像剧情";
}

/** 把「当前角色所属剧本」设为生效 scope（生成回复 / 归档这类长流程入口调用一次） */
export function activateStoryScopeForCharacter(characterId?: string | null): StoryScope {
    const scope = getStoryScopeForCharacter(characterId);
    return scope;
}

/**
 * 重新扫描所有角色的群像归档，刷新「角色 → 剧本」映射。
 * 只读每个角色最新一条 sourceApp === "ensemble" 的归档的 metadata。
 */
export async function refreshStoryScopes(): Promise<ScopeMap> {
    if (typeof window === "undefined") return {};
    try {
        const [{ loadCharacters }, { loadMemoryEntriesByType }] = await Promise.all([
            import("./character-storage"),
            import("./memory-storage"),
        ]);
        const characters = loadCharacters();
        const next: ScopeMap = {};
        for (const character of characters) {
            let entries: Awaited<ReturnType<typeof loadMemoryEntriesByType>> = [];
            try {
                entries = await loadMemoryEntriesByType(character.id, "archive");
            } catch {
                continue;
            }
            let latestScriptId = "";
            let latestScriptTitle = "";
            let latestAt = "";
            for (const entry of entries) {
                if (entry.sourceApp !== "ensemble") continue;
                const scriptId = typeof entry.metadata?.ensembleScriptId === "string" ? entry.metadata.ensembleScriptId.trim() : "";
                if (!scriptId) continue;
                const at = String(entry.updatedAt || entry.createdAt || "");
                if (!latestScriptId || at.localeCompare(latestAt) > 0) {
                    latestScriptId = scriptId;
                    latestScriptTitle = typeof entry.metadata?.ensembleScriptTitle === "string" ? entry.metadata.ensembleScriptTitle.trim() : "";
                    latestAt = at;
                }
            }
            if (latestScriptId) {
                next[character.id] = { scriptId: latestScriptId, scriptTitle: latestScriptTitle || "群像剧情" };
            }
        }
        writeMap(next);
        return next;
    } catch {
        return getMap();
    }
}

/** 是否已经扫过一次（设置页用来决定要不要显示「还没同步」提示） */
export function hasStoryScopeMap(): boolean {
    return Object.keys(getMap()).length > 0;
}

/**
 * 列出已知的所有剧本（去重，按标题排序）。
 * 设置页的「选一条时间线」用它列 chip —— 只靠锚点列会漏：
 * 归档里没写「当前锚点」或者格式变了，剧本就不该从选项里消失。
 */
export function listStoryScripts(): { scriptId: string; scriptTitle: string }[] {
    const seen = new Set<string>();
    const list: { scriptId: string; scriptTitle: string }[] = [];
    for (const entry of Object.values(getMap())) {
        if (!entry?.scriptId || seen.has(entry.scriptId)) continue;
        seen.add(entry.scriptId);
        list.push({ scriptId: entry.scriptId, scriptTitle: entry.scriptTitle || "群像剧情" });
    }
    return list.sort((a, b) => a.scriptTitle.localeCompare(b.scriptTitle, "zh"));
}
