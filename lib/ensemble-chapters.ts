// lib/ensemble-chapters.ts
// 剧情记录分章（2026-11-23）
//
// 给「已杀青」的剧情原文打「章」书签，按剧情节点像小说一样回看。
// 铁律：
//   · 分章是**纯阅读坐标**：不碰归档内容、不碰 AI 上下文（computeVisibleTurns）、
//     不碰杀青流程——改章 / 删章对模型看到什么零影响。
//   · 章只用「起点锚点」定义：章 N = [fromTurnId(N) .. 下一章起点之前]，
//     末章延伸到最后一幕；排序按起点幕在 turns 里的先后。
//   · 数据挂 EnsembleScript.chapters（可选字段），随剧本整包读写，无新增存储 key。
//   · 章内只收「已杀青」的幕；未杀青幕永远留在剧情区，不进任何章。

import { computeWrappedTurnIds } from "./ensemble-archive";
import {
  type EnsembleChapter,
  type EnsembleScript,
  type EnsembleTurn,
} from "./ensemble-storage";
import type { ApiConfig } from "./settings-types";
import { simpleLLMCall } from "./api-helpers";

// ── 视图模型 ──

/** 单章的视图模型（目录与阅读共用；chapter = null 表示「未分章」桶） */
export type ChapterView = {
  chapter: EnsembleChapter | null;
  title: string;
  turns: EnsembleTurn[];
  charCount: number;
  /** 时间范围标签，如「08-10 ～ 08-11」 */
  timeLabel: string;
};

function shortDate(ts: string | undefined): string {
  const raw = (ts ?? "").trim();
  if (!raw) return "";
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  return raw.slice(0, 10);
}

function firstLine(content: string): string {
  return (content ?? "").split("\n").map((s) => s.trim()).find(Boolean) ?? "";
}

/** 已杀青幕的有序清单（起点选择页与 AI 清单共用；序号即清单 #i）。 */
export function listWrappedTurns(script: EnsembleScript): EnsembleTurn[] {
  const turns = script.turns ?? [];
  const wrappedIds = computeWrappedTurnIds(turns, script.archives);
  return turns.filter((t) => wrappedIds.has(t.id));
}

/**
 * 把已杀青的幕按章书签切成视图。
 * 未被任何章覆盖的已杀青幕归入「未分章」桶（排最后）；
 * 第一章起点之前、没有章书签时，全部已杀青幕都在「未分章」桶。
 */
export function buildChapterViews(script: EnsembleScript): ChapterView[] {
  const turns = script.turns ?? [];
  const wrappedIds = computeWrappedTurnIds(turns, script.archives);
  const wrappedTurns = turns.filter((t) => wrappedIds.has(t.id));
  if (wrappedTurns.length === 0) return [];

  const posOf = new Map<string, number>();
  wrappedTurns.forEach((t, i) => posOf.set(t.id, i));

  // 过滤掉起点不存在的章，并按起点位置排序
  const marks = (script.chapters ?? [])
    .filter((c) => posOf.has(c.fromTurnId))
    .map((c) => ({ chapter: c, start: posOf.get(c.fromTurnId) as number }))
    .sort((a, b) => a.start - b.start);

  const views: ChapterView[] = [];
  const covered = new Set<number>();
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].start;
    const end = i + 1 < marks.length ? marks[i + 1].start : wrappedTurns.length; // 不含
    const seg = wrappedTurns.slice(start, end);
    seg.forEach((t) => covered.add(posOf.get(t.id) as number));
    if (seg.length === 0) continue;
    views.push({
      chapter: marks[i].chapter,
      title: marks[i].chapter.title,
      turns: seg,
      charCount: seg.reduce((n, t) => n + (t.content?.length ?? 0), 0),
      timeLabel: `${shortDate(seg[0]?.timestamp)} ～ ${shortDate(seg[seg.length - 1]?.timestamp)}`,
    });
  }

  const rest = wrappedTurns.filter((t) => !covered.has(posOf.get(t.id) as number));
  if (rest.length > 0) {
    views.push({
      chapter: null,
      title: "未分章",
      turns: rest,
      charCount: rest.reduce((n, t) => n + (t.content?.length ?? 0), 0),
      timeLabel: `${shortDate(rest[0]?.timestamp)} ～ ${shortDate(rest[rest.length - 1]?.timestamp)}`,
    });
  }
  return views;
}

// ── 增删改（纯函数：父组件拿返回值走 setCurrentScript + saveOrUpdateEnsembleScript） ──

export function createChapterObj(title: string, fromTurnId: string): EnsembleChapter {
  const now = new Date().toISOString();
  return {
    id: `ch_${Date.now().toString(36)}`,
    title: title.trim() || "未命名章节",
    fromTurnId,
    createdAt: now,
    updatedAt: now,
  };
}

/** 应用新的章书签集合（替换式保存），返回更新后的剧本对象。 */
export function withChapters(script: EnsembleScript, chapters: EnsembleChapter[]): EnsembleScript {
  return { ...script, chapters, updatedAt: new Date().toISOString() };
}

// ── AI 建议分章 ──

export type SuggestResult = { error?: string; chapters?: EnsembleChapter[] };

/**
 * 让模型按剧情节点建议章节划分。
 * 输入只用两样便宜的东西：最新一条剧情归档（事件脉络）+ 已杀青幕清单（定位起点）。
 * 模型只建议，应用与否由用户在界面上拍板。
 * apiConfig 由调用方解析好传入（ensemble-app.tsx 内部的 resolveEnsembleApiConfig，不搬进 lib）。
 */
export async function suggestChapterDivision(
  script: EnsembleScript,
  apiConfig: ApiConfig | null,
  signal?: AbortSignal,
): Promise<SuggestResult> {
  const turns = script.turns ?? [];
  const wrappedIds = computeWrappedTurnIds(turns, script.archives);
  const wrappedTurns = turns.filter((t) => wrappedIds.has(t.id));
  if (wrappedTurns.length < 4) {
    return { error: "已杀青的剧情太少，暂时不值得分章。" };
  }

  const archiveText = (script.archives ?? []).slice(-1).map((a) => a.content).join("");
  if (!archiveText.trim()) {
    return { error: "还没有剧情归档，AI 没有事件脉络可依据——请先杀青一次。" };
  }

  const listing = wrappedTurns
    .map((t, i) => `#${i} ${shortDate(t.timestamp)} ${firstLine(t.content).slice(0, 26)}`)
    .join("\n")
    .slice(0, 12000);

  const prompt =
    `以下是一部群像剧本的「剧情归档摘要」与「已杀青剧情幕清单」。请像小说一样，` +
    `按剧情节点/事件（一次出行、一段矛盾、一个阶段）把这段剧情划分成若干章。\n\n` +
    `【剧情归档摘要】\n${archiveText.slice(0, 9000)}\n\n` +
    `【已杀青剧情幕清单】（共 ${wrappedTurns.length} 幕；#序号从 0 开始，用于指定每章起点）\n${listing}\n\n` +
    `要求：\n` +
    `1. 章数按剧情自然节点定，不固定数量；每章起一个简洁章名，如「第一章 · 别庄的海」；\n` +
    `2. 每章必须以清单中的某一幕为起点：给 startIndex（第一章固定 0，其余严格递增）；\n` +
    `3. 只输出 JSON 数组：[{"title":"…","startIndex":0}, …]，不要输出任何其他文字。`;

  if (!apiConfig) {
    return { error: "未找到可用的 API 配置，请先在设置里绑定群像模型。" };
  }

  const res = await simpleLLMCall(
    apiConfig,
    [
      { role: "system", content: "你是剧本分章助手。只依据给定材料划分章节，不添加剧情内容。" },
      { role: "user", content: prompt },
    ],
    { signal, max_tokens: 1600, label: "章节建议" },
  );
  if (res.error) return { error: res.error };

  const chapters = parseChapterPlan(res.content ?? "", wrappedTurns);
  if (!chapters || chapters.length === 0) {
    return { error: "模型返回的划分格式无法解析，请重试一次。" };
  }
  return { chapters };
}

/** 解析模型的划分 JSON；容错：剥围栏、取首尾方括号、丢弃非法/重复起点。 */
function parseChapterPlan(text: string, wrappedTurns: EnsembleTurn[]): EnsembleChapter[] | null {
  let raw = (text ?? "").trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) raw = fence[1].trim();
  const s = raw.indexOf("[");
  const e = raw.lastIndexOf("]");
  if (s < 0 || e <= s) return null;
  let arr: Array<{ title?: unknown; startIndex?: unknown }>;
  try {
    arr = JSON.parse(raw.slice(s, e + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || arr.length === 0) return null;

  const seen = new Set<number>();
  const out: EnsembleChapter[] = [];
  const now = new Date().toISOString();
  for (const item of arr) {
    const idx = Math.floor(Number(item?.startIndex));
    if (!Number.isFinite(idx) || idx < 0 || idx >= wrappedTurns.length) continue;
    if (seen.has(idx)) continue;
    seen.add(idx);
    const title =
      typeof item?.title === "string" && item.title.trim()
        ? item.title.trim().slice(0, 40)
        : `第 ${out.length + 1} 章`;
    out.push({
      id: `ch_${Date.now().toString(36)}_${out.length}`,
      title,
      fromTurnId: wrappedTurns[idx].id,
      createdAt: now,
      updatedAt: now,
    });
  }
  // 第一章没从 0 开始时，把最前面那章的起点提前到 0（开头剧情并进第一章，不丢内容）
  if (out.length > 0 && seen.size > 0) {
    const minIdx = Math.min(...seen);
    if (minIdx > 0) {
      out[0] = { ...out[0], fromTurnId: wrappedTurns[0].id, updatedAt: now };
    }
  }
  return out;
}
