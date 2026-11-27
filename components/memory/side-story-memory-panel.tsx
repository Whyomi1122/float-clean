"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Layers, Trash2, Upload, Undo2 } from "lucide-react";
import type { MemoryEntry } from "@/lib/memory-types";
import {
    deleteSideStoryMemory,
    injectSideStoryMemory,
    isInjected,
    listSideStoryScriptsInMemory,
    querySideStoryEntries,
    revertSideStoryInjection,
    sideStoryScriptIdOf,
    sideStoryTitleOf,
    type SideStoryMemoryEntry,
} from "@/lib/side-story-memory";

type Props = {
    characterId?: string | null;
    onNotice?: (message: string) => void;
};

/**
 * 番外记忆库（记忆库页独立页签）
 *
 * 口径（2026-11-27）：
 *   · 番外杀青先落在这里，**未手动确认永不注入**角色记忆库；
 *   · 「确认注入」= 复制一条进角色记忆库（带「来自番外」前缀、降权、排最后）；
 *   · 撤回 = 删掉角色侧副本，这里那条保留；
 *   · 删除只动番外库，永远不碰角色记忆库。
 */
export function SideStoryMemoryPanel({ characterId, onNotice }: Props) {
    const [entries, setEntries] = useState<SideStoryMemoryEntry[]>([]);
    const [scripts, setScripts] = useState<{ id: string; title: string }[]>([]);
    const [scriptFilter, setScriptFilter] = useState<string>("all");
    const [onlyPending, setOnlyPending] = useState(false);
    const [keyword, setKeyword] = useState("");
    const [loading, setLoading] = useState(true);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [confirmId, setConfirmId] = useState<string | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const list = await querySideStoryEntries({
                characterId: characterId ?? undefined,
                scriptId: scriptFilter === "all" ? undefined : scriptFilter,
                onlyPending,
                keyword,
            });
            setEntries(list);
            setScripts(await listSideStoryScriptsInMemory());
        } finally {
            setLoading(false);
        }
    }, [characterId, scriptFilter, onlyPending, keyword]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const pendingCount = useMemo(
        () => entries.filter(entry => !isInjected(entry)).length,
        [entries],
    );

    async function handleInject(entry: SideStoryMemoryEntry) {
        setBusyId(entry.id);
        setConfirmId(null);
        try {
            const result = await injectSideStoryMemory(entry.id);
            onNotice?.(result.message);
            await refresh();
        } finally {
            setBusyId(null);
        }
    }

    async function handleRevert(entry: SideStoryMemoryEntry) {
        setBusyId(entry.id);
        try {
            const result = await revertSideStoryInjection(entry.id);
            onNotice?.(result.message);
            await refresh();
        } finally {
            setBusyId(null);
        }
    }

    async function handleDelete(entry: SideStoryMemoryEntry) {
        setBusyId(entry.id);
        try {
            await deleteSideStoryMemory(entry.id);
            onNotice?.("已从番外记忆库删除（角色记忆库不受影响）");
            await refresh();
        } finally {
            setBusyId(null);
        }
    }

    return (
        <div className="flex flex-col gap-3">
            <div
                className="rounded-2xl px-4 py-3"
                style={{ background: "rgba(192,174,142,0.10)", color: "#8a7550" }}
            >
                <div className="flex items-center gap-2 ts-12" style={{ letterSpacing: "0.5px" }}>
                    <Layers size={14} />
                    <span>番外记忆库</span>
                </div>
                <p className="ts-12 leading-relaxed" style={{ marginTop: 4, opacity: 0.85 }}>
                    番外（if 线/支线）杀青后先落在这里，<strong>不会自动影响角色记忆</strong>。
                    手动确认后才复制一条进角色记忆库，并标注「来自番外」、排在归档预算最后。
                </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <select
                    value={scriptFilter}
                    onChange={event => setScriptFilter(event.target.value)}
                    className="ts-12 rounded-xl px-2 py-1"
                    style={{ background: "var(--c-surface, #fff)", border: "1px solid rgba(0,0,0,0.08)" }}
                >
                    <option value="all">全部番外</option>
                    {scripts.map(script => (
                        <option key={script.id} value={script.id}>{script.title}</option>
                    ))}
                </select>
                <button
                    type="button"
                    onClick={() => setOnlyPending(value => !value)}
                    className="ts-12 rounded-xl px-2 py-1"
                    style={{
                        background: onlyPending ? "rgba(91,143,185,0.14)" : "var(--c-surface, #fff)",
                        color: onlyPending ? "#5B8FB9" : undefined,
                        border: "1px solid rgba(0,0,0,0.08)",
                    }}
                >
                    只看未注入（{pendingCount}）
                </button>
                <input
                    value={keyword}
                    onChange={event => setKeyword(event.target.value)}
                    placeholder="搜索内容…"
                    className="ts-12 flex-1 min-w-[120px] rounded-xl px-2 py-1"
                    style={{ background: "var(--c-surface, #fff)", border: "1px solid rgba(0,0,0,0.08)" }}
                />
            </div>

            {loading ? (
                <p className="ts-12 px-1" style={{ opacity: 0.6 }}>读取中…</p>
            ) : entries.length === 0 ? (
                <p className="ts-13 px-1 leading-relaxed" style={{ opacity: 0.6 }}>
                    还没有番外记忆。在番外剧本里杀青归档后，这里会出现一条，等你确认要不要注入。
                </p>
            ) : (
                <div className="flex flex-col gap-2">
                    {entries.map(entry => {
                        const injected = isInjected(entry);
                        const expanded = expandedId === entry.id;
                        return (
                            <div
                                key={entry.id}
                                className="rounded-2xl px-4 py-3"
                                style={{ background: "var(--c-surface, #fff)", border: "1px solid rgba(0,0,0,0.06)" }}
                            >
                                <div className="flex items-center justify-between gap-2 flex-wrap">
                                    <div className="flex items-center gap-2">
                                        <span className="ts-12" style={{ color: "#8a7550" }}>
                                            {sideStoryTitleOf(entry)}
                                        </span>
                                        <span className="ts-11" style={{ opacity: 0.55 }}>
                                            {(entry.createdAt || "").slice(0, 10)}
                                        </span>
                                        {injected ? (
                                            <span
                                                className="ts-11 rounded-full px-2 py-0.5"
                                                style={{ background: "rgba(91,143,185,0.14)", color: "#5B8FB9" }}
                                            >
                                                已注入
                                            </span>
                                        ) : (
                                            <span
                                                className="ts-11 rounded-full px-2 py-0.5"
                                                style={{ background: "rgba(0,0,0,0.05)", color: "#8a7550" }}
                                            >
                                                未注入
                                            </span>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-1">
                                        {injected ? (
                                            <button
                                                type="button"
                                                onClick={() => void handleRevert(entry)}
                                                disabled={busyId === entry.id}
                                                className="ts-11 flex items-center gap-1 rounded-lg px-2 py-1"
                                                style={{ color: "#5B8FB9" }}
                                            >
                                                <Undo2 size={12} />撤回
                                            </button>
                                        ) : (
                                            <button
                                                type="button"
                                                onClick={() => setConfirmId(entry.id)}
                                                disabled={busyId === entry.id}
                                                className="ts-11 flex items-center gap-1 rounded-lg px-2 py-1"
                                                style={{ color: "#5B8FB9" }}
                                            >
                                                <Upload size={12} />确认注入
                                            </button>
                                        )}
                                        <button
                                            type="button"
                                            onClick={() => void handleDelete(entry)}
                                            disabled={busyId === entry.id}
                                            className="ts-11 flex items-center gap-1 rounded-lg px-2 py-1"
                                            style={{ color: "#b4544c" }}
                                        >
                                            <Trash2 size={12} />删除
                                        </button>
                                    </div>
                                </div>

                                <p
                                    className={`ts-13 leading-relaxed whitespace-pre-wrap${expanded ? "" : " line-clamp-3"}`}
                                    style={{ marginTop: 8 }}
                                    onClick={() => setExpandedId(expanded ? null : entry.id)}
                                >
                                    {entry.content}
                                </p>

                                {confirmId === entry.id && (
                                    <div
                                        className="rounded-xl px-3 py-2 ts-12 leading-relaxed"
                                        style={{ marginTop: 8, background: "rgba(180,84,76,0.08)", color: "#8a4b45" }}
                                    >
                                        注入后，这个角色的单聊与其他剧本都会看到这条内容，并标注「来自番外」。
                                        正片归档不会被修改，但角色会记住 if 线里发生过的事。确认注入？
                                        <div className="flex gap-2" style={{ marginTop: 8 }}>
                                            <button
                                                type="button"
                                                onClick={() => void handleInject(entry)}
                                                className="rounded-lg px-3 py-1"
                                                style={{ background: "#5B8FB9", color: "#fff" }}
                                            >
                                                确认注入
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setConfirmId(null)}
                                                className="rounded-lg px-3 py-1"
                                                style={{ background: "rgba(0,0,0,0.06)" }}
                                            >
                                                取消
                                            </button>
                                        </div>
                                    </div>
                                )}

                                {!expanded && (
                                    <button
                                        type="button"
                                        onClick={() => setExpandedId(entry.id)}
                                        className="ts-11"
                                        style={{ marginTop: 4, color: "#5B8FB9" }}
                                    >
                                        展开
                                    </button>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

export default SideStoryMemoryPanel;