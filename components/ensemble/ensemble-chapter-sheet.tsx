"use client";

// components/ensemble/ensemble-chapter-sheet.tsx
// 剧情记录 · 章节目录（2026-11-23）
//
// 纯内容组件：由 ensemble-app.tsx 挂在 MiniSheet 外壳里；数据挂 script.chapters。
// 铁律：只影响「回看」——不碰归档 / AI 上下文 / 杀青流程；删除章不删原文。
// 页内三层：目录（章列表 + 未分章桶）→ 阅读（章内原文，按剧情室样式）
//          → 新建章（选起点幕）/ AI 建议预览。

import { useMemo, useState } from "react";
import {
  buildChapterViews,
  createChapterObj,
  listWrappedTurns,
  suggestChapterDivision,
  withChapters,
  type ChapterView,
} from "@/lib/ensemble-chapters";
import type { EnsembleChapter, EnsembleScript, EnsembleTurn } from "@/lib/ensemble-storage";
import type { ApiConfig } from "@/lib/settings-types";

type Mode =
  | { kind: "index" }
  | { kind: "read"; viewIdx: number }
  | { kind: "pick" }
  | { kind: "suggest" };

const CH_INPUT =
  "w-full rounded-[12px] bg-black/[0.04] px-3 py-2.5 text-[13px] text-[#111] outline-none placeholder:text-black/25";

function turnPreview(t: EnsembleTurn, width = 26): string {
  return (
    (t.content ?? "")
      .split("\n")
      .map((s) => s.trim())
      .find(Boolean)
      ?.slice(0, width) || "（空）"
  );
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

function TurnBlock({ t }: { t: EnsembleTurn }) {
  if (t.senderType === "narration") {
    return (
      <div className="whitespace-pre-wrap px-1 py-1.5 text-[13px] italic leading-relaxed text-black/40">
        {t.content}
      </div>
    );
  }
  const initial = (t.senderName ?? "?").trim().slice(0, 1) || "?";
  return (
    <div className="flex gap-2.5 py-1.5">
      {t.senderAvatar ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={t.senderAvatar} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" />
      ) : (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black/[0.06] text-[12px] font-semibold text-black/60">
          {initial}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-semibold text-black/55">{t.senderName}</div>
        <div className="mt-0.5 whitespace-pre-wrap text-[14px] leading-relaxed text-[#111]">
          {t.content}
        </div>
        {t.storyboardUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={t.storyboardUrl} alt="" className="mt-2 max-h-56 w-full rounded-[12px] object-cover" />
        ) : null}
        <div className="mt-1 text-[9px] text-black/25">{t.timestamp}</div>
      </div>
    </div>
  );
}

export function EnsembleChapterSheet({
  script,
  apiConfig,
  onToast,
  onScriptUpdated,
}: {
  script: EnsembleScript;
  /** 已由父组件解析好的模型配置（resolveEnsembleApiConfig 的结果） */
  apiConfig: ApiConfig | null;
  onToast?: (msg: string) => void;
  onScriptUpdated?: (s: EnsembleScript) => void;
}) {
  const [mode, setMode] = useState<Mode>({ kind: "index" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<EnsembleChapter[] | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [confirmDelId, setConfirmDelId] = useState<string | null>(null);
  const [pickTitle, setPickTitle] = useState("");
  const [pickTurnId, setPickTurnId] = useState<string | null>(null);

  const views = useMemo<ChapterView[]>(() => buildChapterViews(script), [script]);
  const wrapped = useMemo<EnsembleTurn[]>(() => listWrappedTurns(script), [script]);
  const chapters = script.chapters ?? [];
  const usedStarts = useMemo(() => new Set(chapters.map((c) => c.fromTurnId)), [script]);

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
      setMode({ kind: "suggest" });
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

  function doCreate() {
    if (!pickTurnId) return;
    commit([...chapters, createChapterObj(pickTitle, pickTurnId)], "新章已建");
    setMode({ kind: "index" });
  }

  function applySuggestion() {
    if (!suggestion || suggestion.length === 0) return;
    commit(suggestion, "已应用 AI 划分");
    setSuggestion(null);
    setMode({ kind: "index" });
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
          <button
            onClick={() => {
              setPickTurnId(null);
              setPickTitle("");
              setError(null);
              setMode({ kind: "pick" });
            }}
            className="flex-1 rounded-full bg-black/[0.05] px-3 py-2.5 text-[12px] font-medium text-[#111]"
          >
            ＋ 新建一章
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
                      onClick={() => setMode({ kind: "read", viewIdx: i })}
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

  // ── 阅读页 ──
  if (mode.kind === "read") {
    const v = views[mode.viewIdx];
    if (!v) {
      setMode({ kind: "index" });
      return null;
    }
    return (
      <div className="pb-2">
        <SubHeader
          title={v.title}
          sub={`${v.turns.length} 幕 · ${v.charCount} 字`}
          onBack={() => setMode({ kind: "index" })}
        />
        <div className="rounded-[16px] bg-white px-3 py-2">
          {v.turns.map((t) => (
            <TurnBlock key={t.id} t={t} />
          ))}
        </div>
      </div>
    );
  }

  // ── 新建章（选起点幕） ──
  if (mode.kind === "pick") {
    return (
      <div className="pb-2">
        <SubHeader
          title="新建一章"
          sub={`共 ${wrapped.length} 幕`}
          onBack={() => setMode({ kind: "index" })}
        />
        <div className="mx-1 rounded-[16px] bg-white p-3.5">
          <div className="text-[11px] leading-relaxed text-black/45">
            选中的这一幕起（含）到下一章之前，都属于新章。
          </div>
          <input
            className={`${CH_INPUT} mt-2`}
            placeholder="章名，如「第一章 · 别庄的海」"
            value={pickTitle}
            onChange={(e) => setPickTitle(e.target.value)}
          />
          <button
            onClick={doCreate}
            disabled={!pickTurnId}
            className="mt-2 w-full rounded-full bg-[#111] px-3 py-2.5 text-[12px] font-medium text-white disabled:opacity-30"
          >
            {pickTurnId ? "创建章节" : "先在下方选择起点幕"}
          </button>
        </div>
        <div className="mt-2 space-y-1 px-1">
          {wrapped.map((t, i) => {
            const used = usedStarts.has(t.id);
            const picked = pickTurnId === t.id;
            return (
              <button
                key={t.id}
                disabled={used}
                onClick={() => setPickTurnId(t.id)}
                className={`flex w-full items-baseline gap-2 rounded-[10px] px-2.5 py-1.5 text-left text-[11px] ${
                  picked
                    ? "bg-[#111] text-white"
                    : used
                      ? "cursor-not-allowed text-black/25"
                      : "bg-white text-[#111]"
                }`}
              >
                <span className="shrink-0 tabular-nums opacity-60">#{i}</span>
                <span className="min-w-0 flex-1 truncate">{turnPreview(t)}</span>
                {used ? <span className="shrink-0 opacity-70">已是章起点</span> : null}
              </button>
            );
          })}
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
        onBack={() => setMode({ kind: "index" })}
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
            setMode({ kind: "index" });
          }}
          className="flex-1 rounded-full bg-black/[0.05] px-3 py-2.5 text-[12px] font-medium text-[#111]"
        >
          放弃
        </button>
      </div>
    </div>
  );
}
