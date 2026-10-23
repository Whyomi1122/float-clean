"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Sparkles, Trash2, Check, X } from "lucide-react";
import { loadChatMessages, type ChatMessage } from "@/lib/chat-storage";
import { loadMemoryEntriesByType } from "@/lib/memory-storage";
import { commitArchive, deleteArchive } from "@/lib/memory-service";
import { simpleLLMCall } from "@/lib/api-helpers";
import { resolveAuxiliaryApiConfig } from "@/lib/settings-storage";
import type { MemoryEntry } from "@/lib/memory-types";

const DRAFT_STORE_PREFIX = "ai_phone_chat_archive_draft_";

function loadArchiveDraft(characterId: string): string {
    try { return localStorage.getItem(DRAFT_STORE_PREFIX + characterId) || ""; } catch { return ""; }
}
function saveArchiveDraft(characterId: string, text: string): void {
    try {
        if (text) localStorage.setItem(DRAFT_STORE_PREFIX + characterId, text);
        else localStorage.removeItem(DRAFT_STORE_PREFIX + characterId);
    } catch { /* ignore */ }
}

/** 归档弹窗：把聊天记录提炼成一份可编辑的长文档，确认后写入角色记忆（世界书级）。 */
export function ChatArchivePanel({
    characterId,
    characterName,
    sessionId,
    onClose,
}: {
    characterId: string;
    characterName: string;
    sessionId?: string;
    onClose: () => void;
}) {
    const [archives, setArchives] = useState<MemoryEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [summarizing, setSummarizing] = useState(false);
    const [draft, setDraft] = useState("");
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editText, setEditText] = useState("");
    const [saving, setSaving] = useState(false);
    const [notice, setNotice] = useState("");
    const noticeTimer = useRef<number | null>(null);
    const onNotice = useCallback((msg: string) => {
        setNotice(msg);
        if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
        noticeTimer.current = window.setTimeout(() => setNotice(""), 2200);
    }, []);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const list = await loadMemoryEntriesByType(characterId, "archive");
            setArchives([...list].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
        } catch {
            setArchives([]);
        } finally {
            setLoading(false);
        }
    }, [characterId]);

    // 进入时：恢复上次未确认的草稿（避免退出后丢失编辑）
    useEffect(() => {
        setDraft(loadArchiveDraft(characterId));
    }, [characterId]);

    useEffect(() => { void load(); }, [load]);

    // 草稿变化即持久化
    useEffect(() => { saveArchiveDraft(characterId, draft); }, [characterId, draft]);

    const collectTranscript = useCallback((): string => {
        if (!sessionId) return "";
        const msgs: ChatMessage[] = loadChatMessages(sessionId);
        const lines: string[] = [];
        for (const m of msgs) {
            if (m.isRetracted) continue;
            const role = m.role === "user" ? "我" : m.role === "assistant" ? characterName : null;
            if (!role) continue;
            const text = (m.content || "").trim();
            if (!text) continue;
            lines.push(`${role}：${text}`);
        }
        return lines.join("\n");
    }, [sessionId, characterName]);

    const handleSummarize = useCallback(async () => {
        const transcript = collectTranscript();
        if (!transcript.trim()) {
            onNotice("暂无可提炼的聊天记录");
            return;
        }
        setSummarizing(true);
        try {
            const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
            if (!apiConfig || !apiConfig.apiKey) {
                onNotice("未配置记忆总结模型（设置 → 辅助模型）");
                return;
            }
            const now = new Date();
            const dateStr = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}.${String(now.getDate()).padStart(2, "0")}`;
            const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
                Promise.race([
                    p,
                    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("请求超时（60秒无响应）")), ms)),
                ]);
            const res = await withTimeout(simpleLLMCall(
                apiConfig,
                [
                    {
                        role: "system",
                        content:
                            "你是记忆归档助手，负责把聊天记录整理成一份可长期存档的「剧情档案」，供角色日后回忆。\n" +
                            "严格按以下格式输出（纯文本，不要任何 Markdown 符号如 ** # ` >）：\n\n" +
                            "─────  归档 · 至 " + dateStr + "  ─────\n" +
                            "【剧情正文】\n\n" +
                            "（以日期或场景开头的段落，第三人称叙述发生了什么；按时间顺序分段，段与段之间空行；" +
                            "保留关键对白要点、情绪、动作、关系变化、物品/地点状态。只写已发生的事，不编造、不评价。）\n\n" +
                            "【关键锚点】\n" +
                            "· 一条一条列出的重要事实（约定、承诺、关系里程碑、标志性物品、下次行程等）\n\n" +
                            "只输出档案正文本身，不要额外解释。",
                    },
                    { role: "user", content: transcript },
                ],
                { temperature: 0.3, label: "chat-archive" },
            ), 60000);
            if (!res.content) {
                onNotice(res.error || "提炼失败");
                return;
            }
            setDraft(res.content.trim());
        } catch (e) {
            onNotice(e instanceof Error ? e.message : "提炼失败");
        } finally {
            setSummarizing(false);
        }
    }, [collectTranscript, characterName, onNotice]);

    const handleConfirmArchive = useCallback(async () => {
        const text = draft.trim();
        if (!text) { onNotice("内容为空"); return; }
        setSaving(true);
        try {
            const res = await commitArchive(characterId, text, "chat");
            if (res.success) {
                onNotice("已归档，写入角色记忆");
                setDraft("");
                await load();
            } else {
                onNotice(res.error || "归档失败");
            }
        } finally {
            setSaving(false);
        }
    }, [draft, characterId, onNotice, load]);

    const handleSaveEdit = useCallback(async (entry: MemoryEntry) => {
        const text = editText.trim();
        if (!text) { onNotice("内容为空"); return; }
        setSaving(true);
        try {
            await deleteArchive(characterId, entry.id);
            const res = await commitArchive(characterId, text, entry.sourceApp);
            if (res.success) { onNotice("已保存"); setEditingId(null); await load(); }
            else onNotice(res.error || "保存失败");
        } finally {
            setSaving(false);
        }
    }, [editText, characterId, onNotice, load]);

    const handleDelete = useCallback(async (entry: MemoryEntry) => {
        await deleteArchive(characterId, entry.id);
        setArchives(prev => prev.filter(e => e.id !== entry.id));
        onNotice("已删除（并加入防污染墓碑）");
    }, [characterId, onNotice]);

    const hasTranscript = useMemo(() => (sessionId ? loadChatMessages(sessionId).length > 0 : false), [sessionId]);

    return (
        <div className="modal-overlay" style={{ zIndex: 210 }} onClick={onClose} data-ens-ui="1">
            <div
                className="modal-dialog-archive"
                onClick={e => e.stopPropagation()}
                style={{
                    width: "92%", maxWidth: 560, maxHeight: "86vh", display: "flex", flexDirection: "column",
                    background: "var(--c-panel, #fff)", borderRadius: 16, overflow: "hidden",
                    boxShadow: "0 12px 36px rgba(0,0,0,0.2)",
                    animation: "modalSoftRise 0.3s cubic-bezier(0.16, 1, 0.3, 1)",
                }}
            >
                {/* 头部 */}
                <div className="flex items-center justify-between px-4 py-3 shrink-0" style={{ borderBottom: "1px solid var(--border-subtle, rgba(0,0,0,0.06))" }}>
                    <div>
                        <div className="ts-16 font-medium">归档</div>
                        <div className="ts-11 text-secondary mt-0.5">{characterName} · 人工确认的长档案，权重等同世界书</div>
                    </div>
                    <button className="rounded-full p-1.5" style={{ background: "var(--surface-2, rgba(0,0,0,0.05))" }} onClick={onClose} aria-label="关闭">
                        <X size={16} />
                    </button>
                </div>

                {/* 内容 */}
                <div className="flex-1 overflow-y-auto px-4 py-3">
                    <div className="rounded-2xl p-3 mb-4" style={{ background: "var(--surface-2, rgba(0,0,0,0.03))" }}>
                        <div className="flex items-center justify-between mb-2">
                            <span className="ts-13 font-medium">从聊天记录提炼</span>
                            <button
                                className="rounded-xl px-3 py-1.5 ts-12 flex items-center gap-1"
                                style={{ background: "#BDD4E3", color: "#2b3a44", opacity: hasTranscript && !summarizing ? 1 : 0.5 }}
                                disabled={!hasTranscript || summarizing}
                                onClick={handleSummarize}
                            >
                                {summarizing ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                                {summarizing ? "提炼中…" : (draft ? "重新提炼" : "提炼")}
                            </button>
                        </div>
                        {!hasTranscript && <p className="ts-11 text-secondary">当前会话暂无记录可提炼。</p>}
                        {draft && (
                            <>
                                <textarea
                                    value={draft}
                                    onChange={e => setDraft(e.target.value)}
                                    rows={10}
                                    className="w-full rounded-xl p-2 ts-13 mt-1"
                                    style={{ background: "var(--c-panel, #fff)", border: "1px solid var(--border-subtle, rgba(0,0,0,0.1))", resize: "vertical", lineHeight: 1.6 }}
                                />
                                <div className="flex gap-2 mt-2">
                                    <button
                                        className="flex-1 rounded-xl py-2 ts-13 flex items-center justify-center gap-1"
                                        style={{ background: "#BDD4E3", color: "#2b3a44", opacity: saving ? 0.6 : 1 }}
                                        disabled={saving}
                                        onClick={handleConfirmArchive}
                                    >
                                        <Check size={14} /> {saving ? "写入中…" : "确认归档"}
                                    </button>
                                    <button
                                        className="rounded-xl py-2 px-3 ts-13"
                                        style={{ background: "var(--c-panel, #fff)", border: "1px solid var(--border-subtle, rgba(0,0,0,0.1))" }}
                                        onClick={() => setDraft("")}
                                    >
                                        放弃
                                    </button>
                                </div>
                            </>
                        )}
                    </div>

                    <div className="ts-13 font-medium mb-2">已归档（{archives.length}）</div>
                    {loading ? (
                        <p className="ts-12 text-secondary text-center py-6">加载中…</p>
                    ) : archives.length === 0 ? (
                        <p className="ts-12 text-secondary text-center py-6">暂无归档。</p>
                    ) : (
                        <div className="flex flex-col gap-3">
                            {archives.map(entry => {
                                const isEditing = editingId === entry.id;
                                return (
                                    <div key={entry.id} className="rounded-2xl p-3" style={{ background: "var(--surface-2, rgba(0,0,0,0.03))", border: "1px solid var(--border-subtle, rgba(0,0,0,0.06))" }}>
                                        <div className="flex items-center justify-between mb-2">
                                            <span className="ts-11 text-secondary">{new Date(entry.createdAt).toLocaleString("zh-CN")}</span>
                                            <div className="flex gap-2 items-center">
                                                {isEditing ? (
                                                    <>
                                                        <button className="ts-12" style={{ color: "var(--accent, #6c5ce7)" }} disabled={saving} onClick={() => handleSaveEdit(entry)}>保存</button>
                                                        <button className="ts-12 text-secondary" onClick={() => setEditingId(null)}>取消</button>
                                                    </>
                                                ) : (
                                                    <>
                                                        <button className="ts-12" style={{ color: "var(--accent, #6c5ce7)" }} onClick={() => { setEditingId(entry.id); setEditText(entry.content); }}>编辑</button>
                                                        <button className="ts-12" style={{ color: "var(--danger, #e74c3c)" }} onClick={() => handleDelete(entry)}><Trash2 size={12} /></button>
                                                    </>
                                                )}
                                            </div>
                                        </div>
                                        {isEditing ? (
                                            <textarea
                                                value={editText}
                                                onChange={e => setEditText(e.target.value)}
                                                rows={8}
                                                className="w-full rounded-xl p-2 ts-13"
                                                style={{ background: "var(--c-panel, #fff)", border: "1px solid var(--border-subtle, rgba(0,0,0,0.1))", resize: "vertical", lineHeight: 1.6 }}
                                            />
                                        ) : (
                                            <p className="ts-13 whitespace-pre-wrap" style={{ lineHeight: 1.7 }}>{entry.content}</p>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {notice && (
                    <div className="absolute left-1/2 -translate-x-1/2 bottom-6 z-[220] rounded-full px-4 py-2 ts-13"
                        style={{ background: "rgba(0,0,0,0.78)", color: "#fff" }}>{notice}</div>
                )}
            </div>
        </div>
    );
}
