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

const CATALOG_KEY = "ai_phone_story_script_catalog_v1";
let catalogCache: { scriptId: string; scriptTitle: string }[] | null = null;

function writeCatalog(list: { scriptId: string; scriptTitle: string }[]) {
    catalogCache = list;
    if (typeof window === "undefined") return;
    try {
        localStorage.setItem(CATALOG_KEY, JSON.stringify(list));
    } catch {
        /* ignore */
    }
}

function getCatalog(): { scriptId: string; scriptTitle: string }[] {
    if (catalogCache) return catalogCache;
    if (typeof window === "undefined") return [];
    try {
        const raw = localStorage.getItem(CATALOG_KEY);
        const parsed = raw ? (JSON.parse(raw) as { scriptId: string; scriptTitle: string }[]) : [];
        catalogCache = Array.isArray(parsed) ? parsed : [];
    } catch {
        catalogCache = [];
    }
    return catalogCache;
}

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
    const next: ScopeMap = {};
    // ① 剧本库（更硬的来源）：剧本里存着 cast（角色 id 快照）和 archives（杀青归档）。
    //    记忆库没同步成功 / 归档正文没写「当前锚点」时，只扫记忆库会整排空掉，设置页就只剩默认线
    //    （实机连着两次踩到）。这一段自己 import、自己兜错，保证一定能列出剧本。
    try {
        const [{ loadEnsembleScripts }, { hydrateKvDb, isKvHydrated }] = await Promise.all([
            import("./ensemble-storage"),
            import("./kv-db"),
        ]);
        // 剧本/角色都存在 IndexedDB 里，没 hydrate 完读出来是空的 —— 设置页刚打开就扫会全空
        if (!isKvHydrated()) await hydrateKvDb().catch(() => undefined);
        const catalog: { scriptId: string; scriptTitle: string }[] = [];
        const byScriptAt = new Map<string, { scriptId: string; scriptTitle: string; at: string; archived: boolean }>();
        for (const script of loadEnsembleScripts()) {
            const scriptId = String(script?.id || "");
            if (!scriptId) continue;
            const scriptTitle = String(script.title || "").trim() || "群像剧情";
            catalog.push({ scriptId, scriptTitle });
            const archived = (script.archives || []).some(entry => String(entry.content || "").trim());
            const at = String(script.updatedAt || "");
            for (const member of script.cast || []) {
                const characterId = String(member?.id || "");
                if (!characterId) continue;
                const previous = byScriptAt.get(characterId);
                // 有杀青归档的剧本优先，其次比更新时间
                if (
                    !previous ||
                    (archived && !previous.archived) ||
                    (archived === previous.archived && at.localeCompare(previous.at) > 0)
                ) {
                    byScriptAt.set(characterId, { scriptId, scriptTitle, at, archived });
                }
            }
        }
        for (const [characterId, hit] of byScriptAt) {
            next[characterId] = { scriptId: hit.scriptId, scriptTitle: hit.scriptTitle };
        }
        writeCatalog(catalog);
    } catch {
        /* 剧本库读不到就只靠记忆库 */
    }
    // ② 记忆库归档（更贴近真实历史）：谁有更新的归档信谁，覆盖 ① 的结果
    try {
        const [{ loadCharacters }, { loadMemoryEntriesByType }] = await Promise.all([
            import("./character-storage"),
            import("./memory-storage"),
        ]);
        for (const character of loadCharacters()) {
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
    } catch {
        /* 记忆库读不到就用剧本库的结果 */
    }
    if (Object.keys(next).length === 0) return getMap();
    writeMap(next);
    return next;
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
    // 2026-11-14 补：映射扫不出来时（记忆库没同步 / 归档缺锚点），至少按剧本库列出来
    for (const entry of getCatalog()) {
        if (!entry?.scriptId || seen.has(entry.scriptId)) continue;
        seen.add(entry.scriptId);
        list.push({ scriptId: entry.scriptId, scriptTitle: entry.scriptTitle || "群像剧情" });
    }
    return list.sort((a, b) => a.scriptTitle.localeCompare(b.scriptTitle, "zh"));
}
