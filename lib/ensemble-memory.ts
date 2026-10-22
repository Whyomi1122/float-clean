/**
 * 群像记忆注入引擎（2026-10-09 新建 · M1）
 * ──────────────────────────────────────────────────────────────
 * 背景：float 自带完整记忆系统（`memory-*` 五模块），单聊/共创等五大引擎均已接入，
 *       唯独群像从未接入。本文件负责把「按角色存储的记忆」注入群像提示词。
 *
 * 用户口径（2026-10-09 拍板）：
 *   ① 取谁的记忆？ → **全员并标注归属**（每个在场角色都取，注入时标明属于谁）
 *   ② "线上互通"通到哪？ → **读单聊里跟同一角色的记忆**（同一个 characterId）
 *   ③ 记忆从哪来？ → **沿用单聊已有的记忆库（共用一套）**
 *
 * 关键事实：`EnsembleCastMember.id` 就是真实 `characterId`
 *   （建剧本时 `cast: chosenChars.map(c => ({ id: c.id, ... }))`），
 *   因此可以直接拿 cast.id 调 `retrieveMemoriesForPrompt(characterId, ...)`，
 *   天然实现"读同一角色在单聊的记忆"。
 *
 * 与单聊的差异：单聊只有 1 个角色，群像有 N 个。
 *   → 逐角色检索，然后**按角色分段标注**拼装，而不是简单堆在一起。
 */

import type { MemoryConfig, MemoryEntry } from "./memory-types";
import {
  retrieveMemoriesForPrompt,
  retrieveCoreMemoriesForPrompt,
} from "./memory-service";
import { loadMemoryConfig } from "./memory-storage";

/** 一个角色的记忆检索结果。 */
export type RoleMemoryBlock = {
  characterId: string;
  name: string;
  longTerm: MemoryEntry[];
  core: MemoryEntry[];
};

/** 群像记忆注入结果。 */
export type EnsembleMemoryResult = {
  /** 已格式化的注入文本；无任何记忆时为空串。 */
  text: string;
  /** 逐角色的检索明细（调试用）。 */
  blocks: RoleMemoryBlock[];
  /** 参与检索的角色数。 */
  roleCount: number;
  /** 命中的记忆总条数。 */
  totalCount: number;
};

/** 单条记忆 → 文本行。与 `formatLongTermMemories` 口径一致（`- 内容`）。 */
function formatEntries(entries: MemoryEntry[]): string[] {
  return entries.map((e) => `- ${(e.content ?? "").trim()}`).filter((l) => l.length > 2);
}

/**
 * 为群像剧本检索并格式化记忆。
 *
 * @param cast 剧本演员表（`EnsembleScript.cast`）。注意 id 即真实 characterId。
 * @param contextText 检索上下文（本幕最近若干回合正文），用于向量相似度排序。
 * @param options.enabled 「线上互通」开关。false 时直接返回空（不检索、不注入）。
 * @param options.limitPerRole 每角色最多注入的长期记忆条数（默认不限，交给 tokenBudget）。
 * @returns 格式化文本 + 明细。
 */
export async function buildEnsembleMemoryBlock(
  cast: { id: string; name: string }[],
  contextText: string,
  options?: { enabled?: boolean; limitPerRole?: number }
): Promise<EnsembleMemoryResult> {
  const enabled = options?.enabled ?? false;
  if (!enabled || !cast || cast.length === 0) {
    return { text: "", blocks: [], roleCount: 0, totalCount: 0 };
  }

  const config: MemoryConfig = loadMemoryConfig();
  const limitPerRole = options?.limitPerRole ?? 0;

  // 逐角色并行检索（长期 + 核心）。任一角色出错不影响其他角色。
  const blocks = await Promise.all(
    cast.map(async (member): Promise<RoleMemoryBlock> => {
      const [longTerm, core] = await Promise.all([
        retrieveMemoriesForPrompt(member.id, contextText, config).catch(() => []),
        retrieveCoreMemoriesForPrompt(member.id, config).catch(() => []),
      ]);
      return {
        characterId: member.id,
        name: member.name,
        longTerm: limitPerRole > 0 ? longTerm.slice(0, limitPerRole) : longTerm,
        core,
      };
    })
  );

  // 过滤掉没有记忆的角色
  const withMemory = blocks.filter((b) => b.longTerm.length > 0 || b.core.length > 0);
  const totalCount = withMemory.reduce((n, b) => n + b.longTerm.length + b.core.length, 0);

  if (withMemory.length === 0) {
    return { text: "", blocks: [], roleCount: 0, totalCount: 0 };
  }

  // 按角色分段标注归属（用户口径 ①：全员并标注归属）
  const sections: string[] = [];
  for (const b of withMemory) {
    const lines: string[] = [];
    const coreLines = formatEntries(b.core);
    const longLines = formatEntries(b.longTerm);
    if (coreLines.length > 0) {
      lines.push(`【核心记忆】`);
      lines.push(...coreLines);
    }
    if (longLines.length > 0) {
      lines.push(`【相关记忆】`);
      lines.push(...longLines);
    }
    if (lines.length > 0) {
      sections.push(`◆ ${b.name}\n${lines.join("\n")}`);
    }
  }

  const text = `
═══════════ 线上记忆 · 互通库（这些是你离线/单聊时的记忆，可在剧情中自然调用）═══════════
${sections.join("\n\n")}
`;
  return {
    text,
    blocks: withBlocksClean(withMemory),
    roleCount: withMemory.length,
    totalCount,
  };
}

/** 内部：把 blocks 收敛为最终对外结构（去掉空块）。 */
function withBlocksClean(blocks: RoleMemoryBlock[]): RoleMemoryBlock[] {
  return blocks.filter((b) => b.longTerm.length > 0 || b.core.length > 0);
}

// ────────────────────────────────────────────────────────────
// C-2 · 交叉记忆（在场角色之间互相认知）
// ────────────────────────────────────────────────────────────
//
// 用户口径（2026-10-18 拍板）：多人剧情里最容易穿帮的不是"角色对用户的态度"，
// 而是"角色与其他在场角色之间的关系没有来历"——上一秒陌生人，下一秒挚友。
// 所以这里只检索「A 的记忆里提到 B/C…」的条目，并附带用户相关的内容
// （因为"用户跟 A 说过关于 B 的事"正是剧情有内味的地方）。
//
// 实现方式：逐角色取记忆 → 用其他在场角色的**名字**做命中过滤。
// 不做向量重排，纯字符串包含判断，足够且零成本。

/** 交叉记忆检索结果。 */
export type EnsembleCrossMemoryResult = {
    /** 已格式化文本；无命中时为空串。 */
    text: string;
    /** 每个角色命中的条数（调试用）。 */
    perRole: { characterId: string; name: string; hits: number }[];
    /** 命中总条数。 */
    totalCount: number;
};

/**
 * 检索「在场角色之间互相提到」的记忆。
 *
 * @param cast 剧本演员表
 * @param contextText 本幕最近回合正文，用于相似度排序
 * @param options.enabled 线上互通开关；关闭时直接返回空
 * @param options.maxPerRole 每角色最多带出几条（默认 3，防止刷屏）
 */
export async function buildEnsembleCrossMemoryBlock(
    cast: { id: string; name: string }[],
    contextText: string,
    options?: { enabled?: boolean; maxPerRole?: number },
): Promise<EnsembleCrossMemoryResult> {
    const enabled = options?.enabled ?? false;
    if (!enabled || !cast || cast.length < 2) {
        return { text: "", perRole: [], totalCount: 0 };
    }

    const config: MemoryConfig = loadMemoryConfig();
    const maxPerRole = options?.maxPerRole ?? 3;

    const perRoleResults = await Promise.all(
        cast.map(async member => {
            // 其他在场角色的名字，作为命中关键词
            const others = cast.filter(c => c.id !== member.id).map(c => c.name).filter(Boolean);
            if (others.length === 0) return { characterId: member.id, name: member.name, hits: [] as string[] };

            const candidates = await retrieveMemoriesForPrompt(member.id, contextText, config)
                .catch(() => [] as MemoryEntry[]);

            const hits = candidates
                .map(e => (e.content ?? "").trim())
                .filter(text => text.length > 2 && others.some(name => text.includes(name)))
                .slice(0, maxPerRole);

            return { characterId: member.id, name: member.name, hits };
        }),
    );

    const withHits = perRoleResults.filter(r => r.hits.length > 0);
    if (withHits.length === 0) return { text: "", perRole: [], totalCount: 0 };

    const sections = withHits.map(r => `◆ ${r.name} 眼中的其他人\n${r.hits.map(h => `- ${h}`).join("\n")}`);
    const totalCount = withHits.reduce((n, r) => n + r.hits.length, 0);

    return {
        text: `
═══════════ 人物关系 · 交叉记忆（在场角色彼此之间已知的事，用于保持关系连贯）═══════════
${sections.join("\n\n")}
`,
        perRole: perRoleResults.map(r => ({ characterId: r.characterId, name: r.name, hits: r.hits.length })),
        totalCount,
    };
}
