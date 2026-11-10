"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Sparkles, Trash2, Check, X } from "lucide-react";
import { loadChatMessages, type ChatMessage } from "@/lib/chat-storage";
import { loadMemoryEntriesByType } from "@/lib/memory-storage";
import { commitArchive, deleteArchive, pruneOlderChatArchives } from "@/lib/memory-service";
import { simpleLLMCall } from "@/lib/api-helpers";
import { resolveAuxiliaryApiConfig, resolveUserIdentity } from "@/lib/settings-storage";
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

/** 归档提炼用的一条消息文本：语音条/图片/音乐分享的文字在 mediaData.label 里，content 常为空。 */
function messageTranscriptText(m: ChatMessage): string {
    const text = (m.content || "").trim();
    const label = (m.mediaData?.label || "").trim();
    if (m.mediaType === "audio") {
        const spoken = label || text;
        return spoken ? `[语音] ${spoken}` : "[语音]";
    }
    if (m.mediaType === "image") {
        const caption = text || label;
        return caption ? `[图片] ${caption}` : "[图片]";
    }
    return text || label;
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
            // 只显示本聊天室的普通模式归档；群像/剧情模式归档走群像那条线，不串到这里
            setArchives(
                list
                    .filter(entry => entry.sourceApp === "chat")
                    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
            );
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
        // 用用户在本角色下的称呼（拿不到就「用户」），避免模型把「我」写进归档正文
        const userName = resolveUserIdentity(characterId, "chat")?.name?.trim() || "用户";
        const msgs: ChatMessage[] = loadChatMessages(sessionId);
        const lines: string[] = [];
        let inStory = false;
        for (const m of msgs) {
            if (m.isRetracted) continue;
            // 剧情投递段（群像投递进来）用分界线隔开，提炼时与日常聊天分开叙述
            const isStory = Boolean(m.deliverySessionId);
            if (isStory && !inStory) lines.push("", "---------- 以下为剧情模式 ----------");
            else if (!isStory && inStory) lines.push("", "---------- 以上为剧情模式 ----------", "");
            inStory = isStory;
            const role = m.role === "user" ? userName : m.role === "assistant" ? characterName : null;
            if (!role) continue;
            const text = messageTranscriptText(m);
            if (!text) continue;
            lines.push(`${role}：${text}`);
        }
        if (inStory) lines.push("", "---------- 以上为剧情模式 ----------");
        return lines.join("\n").trim();
    }, [sessionId, characterName, characterId]);

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
            const modeLabel = transcript.includes("剧情模式") ? "" : " · 普通模式";
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
                            "─────  归档" + modeLabel + " · 至 " + dateStr + "  ─────\n" +
                            "【剧情正文】\n\n" +
                            "（段落标题统一写成「【普通模式 · 08-11】场景名」；普通模式就是日常玩手机的时间，日期直接用上面的归档日期。\n" +
                            "记录里被「---------- 剧情模式 ----------」隔开的部分写成「【剧情 · 剧情内时间】场景名」，" +
                            "剧情内时间只能从记录里推断（出现过的日期、季节、天气、事件），推断不出就只写场景名，绝不编日期。\n" +
                            "正文按时间顺序分段，段与段之间空行，保留关键对白要点、情绪、动作、关系变化、物品/地点状态。只写已发生的事，不编造、不评价。）\n\n" +
                            "【硬性要求】\n" +
                            "1. 只依据聊天记录里真实出现的内容。记录中没有的对白、动作、结尾一律不许补写，" +
                            "不要使用「突然」「叫住」「要求你回来」这类记录里没有的戏剧化收尾。\n" +
                            "2. 对话在记录里中断就如实写到中断处为止，不要替它补一个收场。\n" +
                            "3. 一律第三人称，用记录里的名字称呼双方（角色名 / 用户的名字），全篇不得出现「我」。" +
                            "一句只写一个主语，两个人的动作不要合并成一句；分不清谁做、谁说的，宁可不写这句。\n" +
                            "4. 记录里「---------- 以下为剧情模式 ----------」隔开的段落属于另一场戏，" +
                            "要各自叙述，不得与日常聊天串写、混为一件事。\n" +
                            "5. 标注为「[语音]」的内容是角色说出口的话，可作为对白引用。\n\n" +
                            "【关键锚点】\n" +
                            "· 3–5 条，每条写「状态推移 + 原话引用」（例如：约好下次一起去海边 → 他答应了，原话「等你有空」）\n" +
                            "· 不收瞬时状态：正在听哪首歌、发了几个表情、今天吃了几顿饭这类不进锚点\n\n" +
                            "【当前锚点】\n" +
                            "· 时间地点与在场的人\n" +
                            "· 双方各自的状态各一句\n" +
                            "· 已聊过：…（一行，防止重复聊同一件事）\n" +
                            "· 待发生：…（1–2 条线头）\n\n" +
                            "全文控制在 1000 字以内，超了先删细节，保住事实与锚点。\n" +
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
                // 同角色只留最新：清掉本聊天室更旧的归档，避免旧归档和新归档一起注入
                if (res.contentHash) await pruneOlderChatArchives(characterId, res.contentHash);
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
            if (res.success) {
                if (res.contentHash) await pruneOlderChatArchives(characterId, res.contentHash);
                onNotice("已保存"); setEditingId(null); await load();
            }
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
