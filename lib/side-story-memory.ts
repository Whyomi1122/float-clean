// lib/side-story-memory.ts
// 番外记忆库（scope = "sideStory"）
//
// 设计口径（2026-11-27 用户拍板）：
//   · 番外杀青**不直接进角色记忆库**，先落在番外记忆库；
//   · 未手动确认的番外条，永远不参与任何注入路径（读侧靠 scope 过滤）；
//   · 用户勾选「确认注入」后才复制一条进角色记忆库，并：
//       ① 正文首行标注「来自番外」；② importance 降一档；③ 归档预算里排最后。
//   · 注入是复制不是移动：撤回 = 删掉角色侧的那条副本，番外库原条保留。
//   · 复用同一个 IndexedDB store（不新建表）：备份/云备份天然覆盖，旧数据零迁移。

import type { MemoryEntry } from "./memory-types";
import type { EnsembleArchiveEntry, EnsembleScript } from "./ensemble-storage";
import {
    deleteMemoryEntry,
    deleteMemoryEntries,
    loadMemoryEntries,
    loadMemoryEntriesByType,
    loadSideStoryEntries,
    saveMemoryEntry,
    saveMemoryEntries,
} from "./memory-storage";

/** 取剧本阵容里"真实角色"的 id（与 bridge 里的口径一致；此处内联避免循环依赖） */
function castCharacterIds(script: EnsembleScript): string[] {
    const ids = new Set<string>();
    for (const member of script.cast ?? []) {
        const id = member?.id;
        if (typeof id === "string" && id.trim()) ids.add(id);
    }
    return [...ids];
}

/** 注入到角色记忆库时用的标记，读侧据此降权 / 排末尾 / 加前缀。 */
export const SIDE_STORY_SOURCE_FLAG = true;

export type SideStoryMemoryEntry = MemoryEntry & { scope: "sideStory" };

export type SideStoryQuery = {
    /** 只看某个角色 */
    characterId?: string;
    /** 只看某个番外剧本 */
    scriptId?: string;
    /** 只看还没注入的 */
    onlyPending?: boolean;
    /** 全文关键词 */
    keyword?: string;
};

function metaOf(entry: MemoryEntry): Record<string, unknown> {
    return (entry.metadata as Record<string, unknown> | undefined) ?? {};
}

export function isSideStoryMemory(entry: MemoryEntry): boolean {
    return entry.scope === "sideStory";
}

export function sideStoryScriptIdOf(entry: MemoryEntry): string {
    const value = metaOf(entry).sideStoryScriptId;
    return typeof value === "string" ? value : "";
}

export function sideStoryTitleOf(entry: MemoryEntry): string {
    const value = metaOf(entry).sideStoryTitle;
    if (typeof value === "string" && value.trim()) return value.trim();
    return "番外";
}

/** 是否已经注入过（且副本还在） */
export function isInjected(entry: MemoryEntry): boolean {
    const meta = metaOf(entry);
    return typeof meta.injectedEntryId === "string" && !!meta.injectedEntryId;
}

/** 番外记忆库查询（带筛选）。永远不返回主线条目。 */
export async function querySideStoryEntries(query: SideStoryQuery = {}): Promise<SideStoryMemoryEntry[]> {
    const all = (await loadSideStoryEntries()) as SideStoryMemoryEntry[];
    const keyword = (query.keyword ?? "").trim();
    return all.filter(entry => {
        if (query.characterId && entry.characterId !== query.characterId) return false;
        if (query.scriptId && sideStoryScriptIdOf(entry) !== query.scriptId) return false;
        if (query.onlyPending && isInjected(entry)) return false;
        if (keyword && !entry.content.includes(keyword)) return false;
        return true;
    });
}

/** 番外记忆库涉及的剧本清单（筛选下拉用） */
export async function listSideStoryScriptsInMemory(): Promise<{ id: string; title: string }[]> {
    const all = await loadSideStoryEntries();
    const seen = new Map<string, string>();
    for (const entry of all) {
        const id = sideStoryScriptIdOf(entry);
        if (!id || seen.has(id)) continue;
        seen.set(id, sideStoryTitleOf(entry));
    }
    return [...seen.entries()].map(([id, title]) => ({ id, title }));
}

/** 番外记忆库涉及的剧本清单（按剧本过滤的下拉用） */
export async function countPendingSideStoryEntries(): Promise<number> {
    const all = await loadSideStoryEntries();
    return all.filter(entry => !isInjected(entry)).length;
}

/**
 * 番外杀青：把归档写进番外记忆库（每个在场角色一条，内容共享）。
 * 不写墓碑：番外可以随时重建，不需要跨会话去重。
 */
export async function saveSideStoryArchive(
    script: EnsembleScript,
    archive: EnsembleArchiveEntry,
): Promise<{ written: number; characterIds: string[] }> {
    const body = buildSideStoryMemoryContent(script, archive);
    if (!body) return { written: 0, characterIds: [] };

    const characterIds = castCharacterIds(script);
    if (characterIds.length === 0) return { written: 0, characterIds: [] };

    const { computeContentHash } = await import("./memory-types");
    const hash = computeContentHash(body);
    const now = new Date().toISOString();

    // 同一次杀青重复触发时按 (角色, 剧本, 指纹) 去重
    const existing = (await loadSideStoryEntries()) as SideStoryMemoryEntry[];
    const fresh = characterIds.filter(characterId => !existing.some(entry =>
        entry.characterId === characterId
        && sideStoryScriptIdOf(entry) === script.id
        && metaOf(entry).contentHash === hash,
    ));
    if (fresh.length === 0) return { written: 0, characterIds: [] };

    const entries: MemoryEntry[] = fresh.map(characterId => ({
        id: `mem_side_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        characterId,
        sourceApp: "ensemble",
        type: "archive",
        scope: "sideStory",
        content: body,
        importance: 1.0,
        createdAt: now,
        updatedAt: now,
        metadata: {
            contentHash: hash,
            archivedAt: now,
            sideStoryScriptId: script.id,
            sideStoryTitle: (script.title || "番外").trim(),
            ensembleArchiveId: archive.id,
        },
    }));

    await saveMemoryEntries(entries);
    return { written: entries.length, characterIds: fresh };
}

/** 手动「重新同步」：清掉该剧本未注入的旧番外记忆，再写最新一条（已注入的副本与标记保留） */
export async function resyncSideStoryArchive(
    script: EnsembleScript,
    archive: EnsembleArchiveEntry,
): Promise<{ written: number }> {
    const all = (await loadSideStoryEntries()) as SideStoryMemoryEntry[];
    const stale = all
        .filter(entry => sideStoryScriptIdOf(entry) === script.id && !isInjected(entry))
        .map(entry => entry.id);
    if (stale.length > 0) await deleteMemoryEntries(stale);
    const result = await saveSideStoryArchive(script, archive);
    return { written: result.written };
}

/**
 * 手动确认注入：把一条番外记忆**复制**进角色记忆库。
 * 副本带「（来自番外）」前缀 + sideStorySource 标记，importance 降到 0.5；
 * 原条保留在番外库，并记下 injectedEntryId 供撤回。
 */
export async function injectSideStoryMemory(entryId: string): Promise<{ ok: boolean; message: string; injectedId?: string }> {
    const all = (await loadSideStoryEntries()) as SideStoryMemoryEntry[];
    const source = all.find(entry => entry.id === entryId);
    if (!source) return { ok: false, message: "找不到这条番外记忆（可能已被删除）" };

    const meta = metaOf(source);
    const previousId = typeof meta.injectedEntryId === "string" ? meta.injectedEntryId : "";
    if (previousId) {
        // 副本还在就当作已完成；副本被用户删了则允许重新注入
        const mainEntries = await loadMemoryEntries(source.characterId);
        if (mainEntries.some(entry => entry.id === previousId)) {
            return { ok: false, message: "这条已经注入过了" };
        }
    }

    const { computeContentHash } = await import("./memory-types");
    const now = new Date().toISOString();
    const title = sideStoryTitleOf(source);
    const injectedContent = `（来自番外「${title}」——这是 if 线/支线里发生的事，不是主线事实；与主线冲突时以主线为准。）\n${source.content}`;
    const hash = computeContentHash(injectedContent);
    const injectedId = `mem_arc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    await saveMemoryEntry({
        id: injectedId,
        characterId: source.characterId,
        sourceApp: "ensemble",
        type: "archive",
        content: injectedContent,
        importance: 0.5, // 降一档：注入侧用的是 importance，白名单里番外排在后面
        createdAt: now,
        updatedAt: now,
        metadata: {
            contentHash: hash,
            archivedAt: now,
            ensembleScriptId: sideStoryScriptIdOf(source) || undefined,
            ensembleScriptTitle: title,
            sideStorySource: SIDE_STORY_SOURCE_FLAG,
            sideStoryFromEntryId: source.id,
            injectedAt: now,
        },
    });

    await saveMemoryEntry({
        ...source,
        updatedAt: now,
        metadata: {
            ...meta,
            injectedAt: now,
            injectedEntryId: injectedId,
            injectedContentHash: hash,
        },
    });

    return { ok: true, message: `已注入到 ${source.characterId} 的角色记忆`, injectedId };
}

/** 撤回注入：删掉角色侧那条副本，番外库原条保留并清掉注入标记。 */
export async function revertSideStoryInjection(entryId: string): Promise<{ ok: boolean; message: string }> {
    const all = (await loadSideStoryEntries()) as SideStoryMemoryEntry[];
    const source = all.find(entry => entry.id === entryId);
    if (!source) return { ok: false, message: "找不到这条番外记忆" };

    const meta = metaOf(source);
    const injectedId = typeof meta.injectedEntryId === "string" ? meta.injectedEntryId : "";
    if (!injectedId) return { ok: false, message: "这条没有注入过" };

    const mainEntries = await loadMemoryEntries(source.characterId);
    const copy = mainEntries.find(entry => entry.id === injectedId);
    if (copy) await deleteMemoryEntry(injectedId);

    const nextMeta = { ...meta };
    delete nextMeta.injectedAt;
    delete nextMeta.injectedEntryId;
    delete nextMeta.injectedContentHash;
    await saveMemoryEntry({ ...source, updatedAt: new Date().toISOString(), metadata: nextMeta });

    return { ok: true, message: copy ? "已撤回注入" : "副本已不在，仅清理了标记" };
}

/** 删一条番外记忆（只动番外库；已注入的副本保留，需用户单独抢救/删除） */
export async function deleteSideStoryMemory(entryId: string): Promise<void> {
    await deleteMemoryEntry(entryId);
}

/** 批量删番外记忆（只动番外库） */
export async function deleteSideStoryMemories(entryIds: string[]): Promise<void> {
    await deleteMemoryEntries(entryIds);
}

/**
 * 番外记忆正文：
 * 与主线归档同结构，但头部明确"这是番外"，避免以后被误当成主线事实。
 */
export function buildSideStoryMemoryContent(
    script: EnsembleScript,
    archive: EnsembleArchiveEntry,
): string {
    const raw = (archive.content ?? "").trim();
    if (!raw) return "";
    const title = (script.title || "番外").trim();
    const castNames = (script.cast ?? []).map(member => member.name).filter(Boolean).join("、");
    const when = (archive.createdAt || "").slice(0, 10);

    const head: string[] = [];
    head.push("（以下是一段番外（if 线/支线）里发生的事，没有写进主线，也不是主线事实。）");
    head.push(`【番外剧情 · ${title}${when ? ` · ${when}` : ""}】`);
    if (castNames) head.push(`在场：${castNames}`);
    return `${head.join("\n")}\n${raw}`;
}

/** 删除某个番外剧本名下的全部番外记忆（删剧本时用；注入过的副本不动） */
export async function purgeSideStoryMemoryOfScript(scriptId: string): Promise<number> {
    const all = (await loadSideStoryEntries()) as SideStoryMemoryEntry[];
    const targets = all.filter(entry => sideStoryScriptIdOf(entry) === scriptId).map(entry => entry.id);
    if (targets.length === 0) return 0;
    await deleteMemoryEntries(targets);
    return targets.length;
}

/** 角色侧那条已注入副本（记忆库页展示"来自番外"分组时用） */
export async function listInjectedSideStoryArchives(characterId: string): Promise<MemoryEntry[]> {
    const entries = await loadMemoryEntriesByType(characterId, "archive");
    return entries.filter(entry => metaOf(entry).sideStorySource === SIDE_STORY_SOURCE_FLAG);
}