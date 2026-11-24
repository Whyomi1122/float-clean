"use client";

// components/ensemble/ensemble-chapter-sheet.tsx
// 剧情记录 · 章节目录（2026-11-23）
//
// 纯内容组件：由 ensemble-app.tsx 挂在 MiniSheet 外壳里；数据挂 script.chapters。
// 铁律：只影响「回看」——不碰归档 / AI 上下文 / 杀青流程；删除章不删原文。
// 页内两层：目录（章列表 + 未分章桶）→ 阅读（章内原文）。
// 建章只走「✦ 让 AI 建议划分」（2026-11-24 用户定：手动建章入口取消，AI 划得够好，
// 目录只是回看工具；手动兜底留给改名 / 删除）。

import { useMemo, useState } from "react";
import {
  buildChapterViews,
  listWrappedTurns,
  suggestChapterDivision,
  withChapters,
  type ChapterView,
} from "@/lib/ensemble-chapters";
import type { EnsembleChapter, EnsembleScript, EnsembleTurn } from "@/lib/ensemble-storage";
import type { ApiConfig } from "@/lib/settings-types";

/** 面板层级：目录 → 阅读 / AI 建议预览。受控于父组件（外壳「返回」要按层级回上一级）。 */
export type ChapterSheetMode =
  | { kind: "index" }
  | { kind: "read"; viewIdx: number }
  | { kind: "suggest" };

const CH_INPUT =
  "w-full rounded-[12px] bg-black/[0.04] px-3 py-2.5 text-[13px] text-[#111] outline-none placeholder:text-black/25";

function turnPreview(t: EnsembleTurn, width = 26): string {
  const lines = (t.content ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length === 0) return "（空）";
  // 群像轮首行常是「[旁白]：」「皮韩宇：」这类纯标签行（冒号结尾、正文在下一行）——
  // 拼上下一行正文，否则清单里全是空标签、没法判断这一幕是什么。
  const first = lines[0];
  const isLabelOnly = /[:：]\s*$/.test(first) && first.replace(/[:：]\s*$/, "").length <= 14;
  if (isLabelOnly && lines.length > 1) {
    return `${first} ${lines[1]}`.slice(0, width);
  }
  return first.slice(0, width);
}

function SubHeader({ title, sub, onBack }: { title: string; sub?: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-2 px-1 pb-2.5 pt-1">
      <button onClick={onBack} className="shrink-0 text-[12px] text-black/45 hover:text-black/75">
        ← 返回
      </button>
      <div className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[#111]">{title}</div>
      {sub ? <div className="shrink-0 text-[10px] text-black/35">{sub}</div> : null}
    </div>
  );
}

/** 系统注入幕（续写指令、剧情带入说明）——小说模式不显示，它们不是剧情正文。 */
function isSystemLike(t: EnsembleTurn): boolean {
  const text = (t.content ?? "").trim();
  return /^反80续写指令/.test(text) || /^（?本次由剧情带入/.test(text) || /^【系统/.test(text);
}

function TurnBlock({ t }: { t: EnsembleTurn }) {
  // 小说模式（2026-11-24 用户定方案 A）：
  // 旁白当正文（正常字色、首行缩进两字）；台词名字加粗前缀、独立成段不缩进；
  // 逐轮时间戳去掉；分镜图保留为插图。
  if (t.senderType === "narration") {
    return (
      <p className="my-2 text-[15px] leading-[1.9] whitespace-pre-wrap text-[#2b2b2b] [text-indent:2em]">
        {t.content}
      </p>
    );
  }
  return (
    <div className="my-2">
      <p className="text-[15px] leading-[1.9] whitespace-pre-wrap text-[#2b2b2b]">
        <span className="font-semibold text-[#111]">{t.senderName}</span>
        {"\u3000"}
        {t.content}
      </p>
      {t.storyboardUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={t.storyboardUrl} alt="" className="mt-2.5 w-full rounded-[12px] object-cover" />
      ) : null}
    </div>
  );
}

export function EnsembleChapterSheet({
  script,
  apiConfig,
  mode,
  onModeChange,
  onToast,
  onScriptUpdated,
}: {
  script: EnsembleScript;
  /** 已由父组件解析好的模型配置（resolveEnsembleApiConfig 的结果） */
  apiConfig: ApiConfig | null;
  /** 当前层级（受控）：父组件拿它决定外壳「← 返回」是回目录还是关面板 */
  mode: ChapterSheetMode;
  onModeChange: (m: ChapterSheetMode) => void;
  onToast?: (msg: string) => void;
  onScriptUpdated?: (s: EnsembleScript) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<EnsembleChapter[] | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [confirmDelId, setConfirmDelId] = useState<string | null>(null);

  const views = useMemo<ChapterView[]>(() => buildChapterViews(script), [script]);
  const wrapped = useMemo<EnsembleTurn[]>(() => listWrappedTurns(script), [script]);
  const chapters = script.chapters ?? [];

  function commit(next: EnsembleChapter[], msg = "已保存") {
    onScriptUpdated?.(withChapters(script, next));
    onToast?.(msg);
  }

  async function runSuggest() {
    setError(null);
    setBusy(true);
    try {
      const res = await suggestChapterDivision(script, apiConfig);
      if (res.error) {
        setError(res.error);
        return;
      }
      setSuggestion(res.chapters ?? []);
      onModeChange({ kind: "suggest" });
    } finally {
      setBusy(false);
    }
  }

  function saveRename() {
    if (!editingId) return;
    const title = editTitle.trim();
    if (!title) return;
    commit(
      chapters.map((c) =>
        c.id === editingId ? { ...c, title, updatedAt: new Date().toISOString() } : c,
      ),
      "章名已改",
    );
    setEditingId(null);
  }

  function doDelete() {
    if (!confirmDelId) return;
    commit(chapters.filter((c) => c.id !== confirmDelId), "章已删除（原文仍在剧情里）");
    setConfirmDelId(null);
  }

  function applySuggestion() {
    if (!suggestion || suggestion.length === 0) return;
    commit(suggestion, "已应用 AI 划分");
    setSuggestion(null);
    onModeChange({ kind: "index" });
  }

  // ── 目录页 ──
  if (mode.kind === "index") {
    return (
      <div className="pb-2">
        <div className="flex gap-2 px-1 pb-3 pt-1">
          <button
            onClick={runSuggest}
            disabled={busy}
            className="flex-1 rounded-full bg-[#111] px-3 py-2.5 text-[12px] font-medium text-white disabled:opacity-40"
          >
            {busy ? "正在划分…" : "✦ 让 AI 建议划分"}
          </button>
        </div>
        {error ? (
          <div className="mx-1 mb-2 rounded-[12px] bg-red-50 px-3 py-2 text-[11px] text-red-600">
            {error}
          </div>
        ) : null}
        <div className="space-y-2 px-1">
          {views.length === 0 ? (
            <div className="rounded-[16px] bg-white p-5 text-center text-[11px] leading-relaxed text-black/35">
              还没有已杀青的剧情。
              <br />
              先在剧情里杀青一次，再回来给剧情分章。
            </div>
          ) : (
            views.map((v, i) => {
              const id = v.chapter?.id ?? "unsorted";
              const isEditing = editingId === id;
              return (
                <div key={id} className="rounded-[16px] bg-white p-3.5">
                  <div className="flex items-start gap-2">
                    <button
                      className="min-w-0 flex-1 text-left"
                      onClick={() => onModeChange({ kind: "read", viewIdx: i })}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveRename();
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className={CH_INPUT}
                        />
                      ) : (
                        <div className="truncate text-[13px] font-semibold text-[#111]">
                          {v.title}
                        </div>
                      )}
                      <div className="mt-1 text-[10px] text-black/35">
                        {v.turns.length} 幕 · {v.charCount} 字 · {v.timeLabel}
                      </div>
                    </button>
                    {v.chapter ? (
                      <div className="flex shrink-0 items-center gap-1.5">
                        {isEditing ? (
                          <>
                            <button
                              onClick={saveRename}
                              className="text-[11px] font-medium text-[#111]"
                            >
                              保存
                            </button>
                            <button
                              onClick={() => setEditingId(null)}
                              className="text-[11px] text-black/35"
                            >
                              取消
                            </button>
                          </>
                        ) : confirmDelId === id ? (
                          <>
                            <button
                              onClick={doDelete}
                              className="text-[11px] font-medium text-red-500"
                            >
                              确认删除？
                            </button>
                            <button
                              onClick={() => setConfirmDelId(null)}
                              className="text-[11px] text-black/35"
                            >
                              取消
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={() => {
                                setEditingId(id);
                                setEditTitle(v.title);
                              }}
                              className="text-[11px] text-black/40"
                            >
                              改名
                            </button>
                            <button
                              onClick={() => setConfirmDelId(id)}
                              className="text-[11px] text-black/40"
                            >
                              删除
                            </button>
                          </>
                        )}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    );
  }

  // ── 阅读页 · 小说模式（2026-11-24 方案 A） ──
  if (mode.kind === "read") {
    const v = views[mode.viewIdx];
    if (!v) {
      // 章被删 / AI 重划后下标失效：交给父组件回目录（commit 后已经会重置，这里只兜底）
      return null;
    }
    const visible = v.turns.filter((t) => !isSystemLike(t));
    return (
      <div className="pb-2">
        <div className="flex items-center justify-between px-1 pb-2.5 pt-1">
          <button
            onClick={() => onModeChange({ kind: "index" })}
            className="text-[12px] text-black/45 hover:text-black/75"
          >
            ← 返回目录
          </button>
          <div className="text-[10px] text-black/35">
            {v.turns.length} 幕 · {v.charCount} 字
          </div>
        </div>
        {/* 纸色正文卡：章头居中（章名 + 时间范围 + 发丝线），正文小说排版 */}
        <div className="rounded-[16px] bg-[#FBF9F6] px-5 pb-7 pt-6">
          <div className="text-center">
            <div className="text-[16px] font-semibold tracking-tight text-[#111]">{v.title}</div>
            <div className="mt-1.5 text-[10px] tracking-wide text-black/35">
              {v.timeLabel} · {v.turns.length} 幕
            </div>
            <div className="mx-auto mt-4 h-px w-9 bg-black/15" />
          </div>
          <div className="mt-4">
            {visible.length === 0 ? (
              <div className="py-6 text-center text-[12px] text-black/30">
                这一章里没有可显示的剧情正文。
              </div>
            ) : (
              visible.map((t) => <TurnBlock key={t.id} t={t} />)
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── AI 建议预览页 ──
  return (
    <div className="pb-2">
      <SubHeader
        title="AI 建议划分"
        sub={`${suggestion?.length ?? 0} 章`}
        onBack={() => onModeChange({ kind: "index" })}
      />
      <div className="space-y-1.5 px-1">
        {suggestion?.map((c) => {
          const idx = wrapped.findIndex((t) => t.id === c.fromTurnId);
          return (
            <div key={c.id} className="rounded-[14px] bg-white p-3">
              <div className="text-[13px] font-semibold text-[#111]">{c.title}</div>
              <div className="mt-1 text-[10px] text-black/35">
                从 #{idx} {idx >= 0 ? turnPreview(wrapped[idx]) : ""} 起
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex gap-2 px-1">
        <button
          onClick={applySuggestion}
          className="flex-1 rounded-full bg-[#111] px-3 py-2.5 text-[12px] font-medium text-white"
        >
          ✓ 应用划分
        </button>
        <button
          onClick={() => {
            setSuggestion(null);
            onModeChange({ kind: "index" });
          }}
          className="flex-1 rounded-full bg-black/[0.05] px-3 py-2.5 text-[12px] font-medium text-[#111]"
        >
          放弃
        </button>
      </div>
    </div>
  );
}
