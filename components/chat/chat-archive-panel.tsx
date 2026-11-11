"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Sparkles, Trash2, Check, X } from "lucide-react";
import { loadChatMessages, type ChatMessage } from "@/lib/chat-storage";
import { loadMemoryEntriesByType } from "@/lib/memory-storage";
import { commitArchive, deleteArchive, pruneOlderChatArchives } from "@/lib/memory-service";
import { simpleLLMCall } from "@/lib/api-helpers";
import { resolveAuxiliaryApiConfig, resolveUserIdentity } from "@/lib/settings-storage";
import { buildArchiveContextPack } from "@/lib/archive-context-pack";
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
        for (const m of msgs) {
            if (m.isRetracted) continue;
            // 剧情模式（群像投递进来的那几段）归群像剧本自己的归档，这里只吃普通聊天
            if (m.deliverySessionId) continue;
            const role = m.role === "user" ? userName : m.role === "assistant" ? characterName : null;
            if (!role) continue;
            const text = messageTranscriptText(m);
            if (!text) continue;
            lines.push(`${role}：${text}`);
        }
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
            const modeLabel = " · 普通模式";
            const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
                Promise.race([
                    p,
                    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("请求超时（60秒无响应）")), ms)),
                ]);
            // 背景包：人设 + 世界书 + 长期记忆 + 既往归档（归档原本什么都看不到，只能瞎猜地点关系）
            const pack = await buildArchiveContextPack(characterId);
            const settingsText = pack.settings
                ? "【角色设定与世界书（只用来判断双方各自在哪、什么关系，不得据此编造本次记录之外的情节）】\n" +
                pack.settings + "\n\n"
                : "";
            const historyText = pack.history
                ? "【长期记忆与既往归档（只当已知背景，不要复述，也不要当成这次发生的事）】\n" +
                pack.history + "\n\n"
                : "";
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
                            "（段落标题统一写成「【普通模式 · 08-11】场景名」，日期用上面的归档日期。" +
                            "正文按时间顺序分段，段与段之间空行，保留关键对白要点、情绪、关系变化、物品/地点状态；" +
                            "这些也必须是记录里明确出现的，动作、表情、环境、氛围一律不写。）\n\n" +
                            "【硬性要求】\n" +
                            "1. 白名单，只能写三类内容：(a) 记录里出现过的对白，可原话引用；(b) 双方明确说过的状态" +
                            "（去了哪、做了什么、心情如何、身体怎么样）；(c) 系统事实（时间、一起听了哪几首、听了多久）。" +
                            "除此以外的一切动作、表情、环境、氛围、心理描写都不许写——" +
                            "「他哼起了歌」「靠在椅背上敲桌面」这类记录里没有的细节一个都不要。\n" +
                            "2. 逐段自检：每一段都要能在记录里找到对应的原句，找不到就整段删掉；宁可短，不许凑。\n" +
                            "3. 不补对白、不补结尾：对话在记录里中断就如实写到中断处为止，不要替它补一个收场，" +
                            "不要使用「突然」「叫住」「要求你回来」这类记录里没有的戏剧化收尾。\n" +
                            "4. 一律第三人称，用记录里的名字称呼双方（角色名 / 用户的名字），全篇不得出现「我」。" +
                            "一句只写一个主语，两个人的动作不要合并成一句；分不清谁做、谁说的，宁可不写这句。\n" +
                            "5. 空间按设定来：除非记录里明确写到两人见面、同处一室，否则一律写成各自在各自所在地、" +
                            "隔着手机聊天——不写任何需要共享物理空间的动作（「歪头看向手机屏幕」「把手机推过来」" +
                            "「递过去」之类），也不要把任何一方搬到对方的城市。" +
                            "设定里没写的地方，就写「那边」「国内」「首尔」这种不具体的地点，不要猜。\n" +
                            "6. 标注为「[语音]」的内容是角色说出口的话，可作为对白引用。\n\n" +
                            settingsText +
                            historyText +
                            "【关键锚点】\n" +
                            "· 3–5 条，每条写「状态推移 + 原话引用」（例如：约好下次一起去海边 → 他答应了，原话「等你有空」）\n" +
                            "· 不收瞬时状态：正在听哪首歌、发了几个表情、今天吃了几顿饭这类不进锚点\n\n" +
                            "【当前锚点】\n" +
                            "· 时间 + 双方各自所在地（按设定写，不确定就写「各自那边」，不许写成在一起）\n" +
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
            const firstDraft = res.content.trim();
            // 第二轮自检：逐句核对，把记录里找不到依据的句子删掉。
            // 归档是手动触发，多花一次调用（成本×2）换「不编」，失败就退回第一版。
            let finalText = firstDraft;
            try {
                const checked = await withTimeout(simpleLLMCall(
                    apiConfig,
                    [
                        {
                            role: "system",
                            content:
                                "你是归档审校员。下面给你一份聊天记录和一份归档草稿。\n" +
                                "逐句核对草稿：每一句都必须在聊天记录里找到依据（出现过的对白、双方明确说过的状态、系统事实）。\n" +
                                "1. 记录里没有的动作、表情、环境、氛围、心理描写，编造的对白与结尾，全部删掉。\n" +
                                "2. 把两人写成同一空间、共享物理空间的句子（「歪头看向手机屏幕」「把手机推过来」「递过去」等），" +
                                "改写成各自在各自所在地、隔着手机。\n" +
                                "3. 不要新增任何内容，不要改格式，不要加解释，不要写修订说明。\n" +
                                "按原格式输出修订后的全文（纯文本）。草稿若已全部有依据，就原样输出。",
                        },
                        {
                            role: "user",
                            content:
                                (settingsText ? settingsText : "") +
                                "【聊天记录】\n" + transcript + "\n\n【待审校的归档草稿】\n" + firstDraft,
                        },
                    ],
                    { temperature: 0.1, label: "chat-archive-check" },
                ), 60000);
                const checkedText = checked.content?.trim();
                if (checkedText && checkedText.includes("─────")) finalText = checkedText;
            } catch { /* 自检失败就用第一版 */ }
            setDraft(finalText);
        } catch (e) {
            onNotice(e instanceof Error ? e.message : "提炼失败");
        } finally {
            setSummarizing(false);
        }
    }, [collectTranscript, characterId, characterName, onNotice]);

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
