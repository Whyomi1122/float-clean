// lib/ensemble-memory-bridge.ts
// 群像 → 记忆库（C-1 桥接）
//
// 设计要点（2026-10-18 用户拍板）：
//   · 粒度：一份共享内容，按参与角色各存一条记录 —— 检索路径短，模型不会看到别人的视角。
//   · 落地形态：写入 characterId 的 archive（归档）条目，sourceApp = "ensemble"。
//     archive 是同世界书同级的"始终注入"层，但本模块在正文里加一行"仅在相关时提及"的约束，
//     避免群像剧情每轮都刷屏占预算。
//   · 防污染：完全复用 commitArchive —— 墓碑 / contentHash 去重都在里面。
//   · 同剧本只留最新（2026-11-09 用户口径）：每次杀青都会写一条新归档，旧归档没有信息增量，
//     留着只会把提示词越撑越长。所以写入新归档后立刻清掉同剧本的旧条目（不进墓碑）。

import type { EnsembleArchiveEntry, EnsembleScript } from "./ensemble-storage";
import { commitArchive } from "./memory-service";

/** 群像归档在记忆库里使用的元信息键，记忆库页按这个分组显示。 */
export const ENSEMBLE_MEMORY_SOURCE = "ensemble" as const;

export type EnsembleBridgeResult = {
    /** 实际写入或命中去重的角色数。 */
    written: number;
    /** 被写入的角色 id。 */
    characterIds: string[];
    /** 写入失败 / 被墓碑拦截的角色 id（不再静默吞掉）。 */
    failed: string[];
    /** 各角色失败原因。 */
    errors: Record<string, string>;
};

/**
 * 把一次群像归档同步进参与角色的记忆库。
 *
 * @param script   剧本（用于取标题、cast 名单）
 * @param archive  本次杀青产生的归档条目
 */
export async function syncEnsembleArchiveToMemory(
    script: EnsembleScript,
    archive: EnsembleArchiveEntry,
): Promise<EnsembleBridgeResult> {
    const body = buildEnsembleMemoryContent(script, archive);
    if (!body) return { written: 0, characterIds: [], failed: [], errors: {} };

    const characterIds = collectCastCharacterIds(script);
    if (characterIds.length === 0) return { written: 0, characterIds: [], failed: [], errors: {} };

    const results = await Promise.all(
        characterIds.map(async characterId => {
            try {
                return await commitArchive(
                    characterId,
                    body,
                    ENSEMBLE_MEMORY_SOURCE,
                    ensembleArchiveMetadata(script, archive),
                );
            } catch (error) {
                return { success: false, error: error instanceof Error ? error.message : String(error) };
            }
        }),
    );

    const okIds: string[] = [];
    const failed: string[] = [];
    const errors: Record<string, string> = {};
    characterIds.forEach((characterId, index) => {
        const r = results[index];
        if (r?.success) okIds.push(characterId);
        else {
            failed.push(characterId);
            errors[characterId] = r?.error || "未知错误";
        }
    });

    // 写入成功后再清理同剧本的旧归档（保留刚写进去的这一条）
    await Promise.all(okIds.map(characterId =>
        pruneOlderEnsembleArchives(characterId, script, body).catch(() => 0)
    ));

    return { written: okIds.length, characterIds: okIds, failed, errors };
}

/** 群像归档写入记忆库时附带的元信息（注入侧据此"同剧本只留最新"）。 */
function ensembleArchiveMetadata(
    script: EnsembleScript,
    archive: EnsembleArchiveEntry,
): Record<string, unknown> {
    return {
        ensembleScriptId: script.id,
        ensembleScriptTitle: (script.title || "").trim() || "群像剧情",
        ensembleArchiveId: archive.id,
    };
}

/**
 * 清掉该角色记忆库里"同剧本但更旧"的群像归档，只留当前这条。
 * 走 deleteMemoryEntry 而不是 deleteArchive —— 这里不是用户主动否掉某段记忆，
 * 只是被更新的同剧本归档取代，不能进墓碑（否则将来撤销杀青再杀青会被拦）。
 */
async function pruneOlderEnsembleArchives(
    characterId: string,
    script: EnsembleScript,
    keepBody: string,
): Promise<number> {
    const { loadMemoryEntriesByType, deleteMemoryEntry } = await import("./memory-storage");
    const { computeContentHash } = await import("./memory-types");

    const keepHash = computeContentHash(keepBody);
    const marker = `【群像剧情 · ${(script.title || "群像剧情").trim()}`;
    const entries = await loadMemoryEntriesByType(characterId, "archive");

    const stale = entries.filter(entry => {
        if (entry.sourceApp !== ENSEMBLE_MEMORY_SOURCE) return false;
        const hash = typeof entry.metadata?.contentHash === "string"
            ? entry.metadata.contentHash
            : computeContentHash(entry.content);
        if (hash === keepHash) return false;
        const tagged = entry.metadata?.ensembleScriptId;
        if (typeof tagged === "string" && tagged.trim()) return tagged.trim() === script.id;
        // 老数据没有 ensembleScriptId：按正文头部标题判断是不是同一个剧本
        return entry.content.includes(marker);
    });

    for (const entry of stale) {
        try {
            await deleteMemoryEntry(entry.id);
        } catch {
            // 清理失败不阻断本次写入（注入侧还有同剧本去重兜底）
        }
    }
    return stale.length;
}

/**
 * 把剧本最新一份归档按当前 cast **强制**重灌一遍（档案面板"重新同步记忆库"按钮用）。
 * 剧本是唯一事实源：先解除对应正文的墓碑再写入，所以手动在记忆库删过的归档
 * 也会被恢复 —— 这是"修复"语义，用户点了就是要修齐。
 * 2026-11-09 起只灌**最新一条**并清掉旧的：记忆库里同剧本留多条只会把提示词撑长。
 */
export async function resyncEnsembleArchivesToMemory(
    script: EnsembleScript,
    archives: EnsembleArchiveEntry[],
): Promise<{ synced: number; failed: number; errors: Record<string, string> }> {
    const characterIds = collectCastCharacterIds(script);
    const latest = pickLatestArchive(archives);
    const body = latest ? buildEnsembleMemoryContent(script, latest) : "";
    if (characterIds.length === 0 || !latest || !body) {
        return { synced: 0, failed: 0, errors: {} };
    }

    const { removeDeletedHash } = await import("./memory-storage");
    const { computeContentHash } = await import("./memory-types");

    let synced = 0;
    let failed = 0;
    const errors: Record<string, string> = {};
    const hash = computeContentHash(body);
    for (const characterId of characterIds) {
        try {
            removeDeletedHash(characterId, hash);
            const result = await commitArchive(
                characterId,
                body,
                ENSEMBLE_MEMORY_SOURCE,
                ensembleArchiveMetadata(script, latest),
            );
            if (result.success) synced += 1;
            else {
                failed += 1;
                errors[characterId] = result.error || "写入被拒绝";
            }
        } catch (error) {
            failed += 1;
            errors[characterId] = error instanceof Error ? error.message : String(error);
        }
    }
    await Promise.all(characterIds.map(characterId =>
        pruneOlderEnsembleArchives(characterId, script, body).catch(() => 0)
    ));
    return { synced, failed, errors };
}

/** 取内容非空、createdAt 最新的那一份归档（时间解析失败时按数组顺序取后面的）。 */
function pickLatestArchive(archives: EnsembleArchiveEntry[]): EnsembleArchiveEntry | null {
    let best: EnsembleArchiveEntry | null = null;
    let bestTime = Number.NEGATIVE_INFINITY;
    for (const archive of archives) {
        if (!(archive.content ?? "").trim()) continue;
        const time = new Date(archive.createdAt || 0).getTime();
        const value = Number.isFinite(time) ? time : 0;
        if (!best || value >= bestTime) {
            best = archive;
            bestTime = value;
        }
    }
    return best;
}

/**
 * 撤销杀青时解除墓碑（否则"撤销→重新杀青"同内容会被墓碑永久拦截，导致有的角色缺记忆）。
 * 只解除本归档正文对应的那一个 hash，手动删除的记忆不受影响。
 */
export async function restoreEnsembleArchiveTombstones(script: EnsembleScript, archive: EnsembleArchiveEntry): Promise<void> {
    const body = buildEnsembleMemoryContent(script, archive);
    if (!body) return;
    const { removeDeletedHash } = await import("./memory-storage");
    const { computeContentHash } = await import("./memory-types");
    const hash = computeContentHash(body);
    for (const characterId of collectCastCharacterIds(script)) {
        removeDeletedHash(characterId, hash);
    }
}

/** 取剧本里所有"真实角色"的 id。
 *  注意：EnsembleCastMember 的 id 本身就是 Character.id（群像演员表直接复用角色 id）。 */
export function collectCastCharacterIds(script: EnsembleScript): string[] {
    const ids = new Set<string>();
    for (const member of script.cast ?? []) {
        const id = member?.id;
        if (typeof id === "string" && id.trim()) ids.add(id);
    }
    return [...ids];
}

/**
 * 撤销一次群像归档在记忆库里的影响（撤销杀青 / 删归档时调用）。
 * 按内容指纹找回那条 archive 并走 deleteArchive —— 会进墓碑，防止下次杀青把同内容写回来。
 */
export async function removeEnsembleArchiveFromMemory(
    script: EnsembleScript,
    archive: EnsembleArchiveEntry,
): Promise<number> {
    const body = buildEnsembleMemoryContent(script, archive);
    if (!body) return 0;

    const characterIds = collectCastCharacterIds(script);
    if (characterIds.length === 0) return 0;

    const { loadMemoryEntriesByType } = await import("./memory-storage");
    const { computeContentHash, } = await import("./memory-types");
    const { deleteArchive } = await import("./memory-service");
    const hash = computeContentHash(body);

    let removed = 0;
    await Promise.all(characterIds.map(async characterId => {
        try {
            const entries = await loadMemoryEntriesByType(characterId, "archive");
            const hit = entries.find(e => e.metadata?.contentHash === hash);
            if (!hit) return;
            await deleteArchive(characterId, hit.id);
            removed += 1;
        } catch {
            // 撤销记忆是尽力而为，不阻断群像侧的操作
        }
    }));
    return removed;
}

/**
 * 拼出写进记忆库的正文。
 * 单条内容全角色共享 —— 保证不同角色看到的是同一份客观事实，不产生视角分歧。
 *
 * ⚠️ 不做字数截断（2026-10-18 用户口径）：归档是"全量过一遍"的记忆，
 *    能留下来的都是筛过的重要剧情，砍掉就是丢记忆。之前 900 字上限会把
 *    长归档腰斩，记忆库里几乎等于废数据。
 */
export function buildEnsembleMemoryContent(
    script: EnsembleScript,
    archive: EnsembleArchiveEntry,
): string {
    const raw = (archive.content ?? "").trim();
    if (!raw) return "";

    const title = (script.title || "群像剧情").trim();
    const castNames = (script.cast ?? [])
        .map(member => member.name)
        .filter(Boolean)
        .join("、");
    const when = (archive.createdAt || "").slice(0, 10);

    const head: string[] = [];
    head.push(`（以下是你亲身参与过的群像剧情，可作为已知事实回想；仅在话题相关时自然提及，不必每轮复述。）`);
    head.push(`【群像剧情 · ${title}${when ? ` · ${when}` : ""}】`);
    if (castNames) head.push(`在场：${castNames}`);

    return `${head.join("\n")}\n${raw}`;
}
