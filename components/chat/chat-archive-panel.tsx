"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Sparkles, Trash2, Check, X } from "lucide-react";
import { loadChatMessages, type ChatMessage } from "@/lib/chat-storage";
import { loadMemoryEntriesByType } from "@/lib/memory-storage";
import { commitArchive, deleteArchive, updateArchiveEntry } from "@/lib/memory-service";
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
    // 其他富媒体（红包/转账/位置/礼物/名片/音乐分享/贴纸…）：尽量留下「发生过什么」，别整行丢掉
    if (m.mediaType || m.mediaData) {
        const kind = (m.mediaData as { type?: string } | undefined)?.type || "";
        const tag =
            kind === "music_share" ? "[音乐分享]" :
                kind === "red_packet" || kind === "transfer" ? "[红包]" :
                    kind === "location" ? "[位置]" :
                        kind === "voice_call" ? "[通话]" :
                            kind === "sticker" ? "[贴纸]" :
                                kind === "gift" ? "[礼物]" :
                                    kind === "contact_card" || kind === "app_card" ? "[卡片]" :
                                        kind === "quote" ? "[引用]" :
                                            m.mediaType === "video" ? "[视频]" : "";
        const body = text || label;
        if (tag) return body ? `${tag} ${body}` : tag;
    }
    return text || label;
}

const WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const pad2 = (n: number) => String(n).padStart(2, "0");
const fmtClock = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const fmtDate = (d: Date) => `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;

/** 归档头行：和群像归档同一套写法（带星期与时刻）。 */
function buildArchiveHeader(now: Date): string {
    return `─────  归档 · 普通模式 · 至 ${fmtDate(now)} ${WEEKDAY_CN[now.getDay()]} ${fmtClock(now)}  ─────`;
}

/**
 * 拆旧归档：头行丢掉，正文与【关键锚点】分开。
 * 归档是「单条滚动」的：老正文必须原样保留，只有锚点整块重写。
 */
function splitArchiveDoc(text: string): { body: string; anchors: string } {
    const raw = (text || "").trim();
    if (!raw) return { body: "", anchors: "" };
    const lines = raw.split("\n");
    // 丢掉最前面的头行（───── … ─────）和紧随其后的空行
    let start = 0;
    while (start < lines.length && (lines[start].trim().startsWith("─────") || !lines[start].trim())) start += 1;
    const rest = lines.slice(start).join("\n").trim();
    const cutAt = Math.min(
        ...[rest.indexOf("【关键锚点】"), rest.indexOf("【当前锚点】")].filter(idx => idx >= 0),
    );
    if (!Number.isFinite(cutAt)) return { body: rest, anchors: "" };
    return {
        body: rest.slice(0, cutAt).trim(),
        anchors: rest.slice(cutAt).trim(),
    };
}

/** 从模型输出里拆出「本轮新增段落」和「关键锚点」两块。 */
function splitNewParts(text: string): { body: string; anchors: string } {
    let rest = (text || "").trim();
    rest = rest.replace(/^【新增段落】\s*/, "");
    const idx = rest.indexOf("【关键锚点】");
    if (idx < 0) return { body: rest.trim(), anchors: "" };
    return { body: rest.slice(0, idx).trim(), anchors: rest.slice(idx).trim() };
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
            // 每行带发送时刻：归档要靠它判断「隔了多久才回」「聊到几点」
            const stamp = m.createdAt ? fmtClock(new Date(m.createdAt)) : "";
            lines.push(stamp ? `${stamp} ${role}：${text}` : `${role}：${text}`);
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
            const header = buildArchiveHeader(now);
            const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
                Promise.race([
                    p,
                    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("请求超时（60秒无响应）")), ms)),
                ]);
            // 背景包：人设 + 世界书 + 长期记忆（归档上一版单独喂，见下）
            const pack = await buildArchiveContextPack(characterId);
            const settingsText = pack.settings
                ? "【角色设定与世界书（只用来判断双方各自在哪、什么关系，不得据此编造本轮记录之外的情节）】\n" +
                pack.settings + "\n\n"
                : "";
            const memoriesText = pack.memories
                ? "【长期记忆（只当已知背景，不要复述，也不要当成这一轮发生的事）】\n" +
                pack.memories + "\n\n"
                : "";
            // 上一版归档：归档是「单条滚动」的——老正文原样保留，只往后追加新段落
            const existingArchives = (await loadMemoryEntriesByType(characterId, "archive"))
                .filter(entry => entry.sourceApp !== "ensemble" && !entry.metadata?.listenRecord)
                .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
            const previous = existingArchives[0]?.content?.trim() || "";
            const previousParts = splitArchiveDoc(previous);
            const previousText = previous
                ? "【上一版归档（只作为上文与已知状态，不要重写、不要压缩、不要复述）】\n" + previous + "\n\n"
                : "";
            const res = await withTimeout(simpleLLMCall(
                apiConfig,
                [
                    {
                        role: "system",
                        content:
                            "你是记忆归档助手。任务：把「这一轮」新发生的事，追加进这个角色的归档文档。\n" +
                            "老内容一个字都不要改写、不要压缩、不要总结、不要写版本号——你只负责写本轮新增的部分。\n\n" +
                            "【只输出下面两块，纯文本，不要 Markdown 符号（** # ` >），不要解释】\n\n" +
                            "【新增段落】\n" +
                            "【11-11 周二 20:35 - 21:10】\n" +
                            "（本轮发生的事，小说式叙述，按时间推进；换时段或换场景就再起一段【…】）\n\n" +
                            "【关键锚点】\n" +
                            "· 物品与状态：…\n" +
                            "· 认知与事实澄清：…\n" +
                            "· 违规隐患：…\n" +
                            "· 关系变化：…\n" +
                            "· 待兑现：…\n\n" +
                            "【写法要求】\n" +
                            "1. 只写这一轮记录里真实发生的内容。可以写动作、场景、语气，以及这一方对另一方行为的判断，" +
                            "但每一句都要能在本轮记录里找到依据；不许凭空补对白、不许补结尾、" +
                            "不许加记录里没有的环境与氛围细节。\n" +
                            "2. 一律第三人称，用记录里的名字称呼双方（角色名 / 用户的名字），全篇不得出现「我」。" +
                            "一句只写一个主语，分不清谁做、谁说的，宁可不写这句。\n" +
                            "3. 空间按设定来：除非记录里明确写到两人见面、同处一室，否则一律写成各自在各自所在地、" +
                            "隔着手机——不写任何需要共享物理空间的动作（「歪头看向手机屏幕」「把手机推过来」「递过去」之类），" +
                            "也不要把任何一方搬到对方的城市；设定里没写的地方就写「那边」「国内」「首尔」。\n" +
                            "4. 段落标题用真实时刻「【11-11 周二 20:35 - 21:10】」，时间取记录每行前面的 HH:MM。" +
                            "跨天、跨时段就分段。\n" +
                            "5. 「[语音]」是角色说出口的话，可原话引用；「[图片]/[红包]/[位置]/[音乐分享]/[通话]」" +
                            "这类是真实发生过的动作，要写清楚发生了什么、对方怎么接的。\n" +
                            "6. 【关键锚点】整块重写：在上一版锚点的基础上更新，五类都写，" +
                            "某一类确实没有变化就写「无变化」，不要留空。\n" +
                            "7. 上一版归档只用来判断双方状态、避免重复叙述，不要把旧内容再写一遍。\n" +
                            "8. 篇幅：每段 200–900 字，把事情写透；不设总字数上限。\n\n" +
                            settingsText +
                            "【输出前的自检】每写一段，回查本轮记录：这条信息是哪句话/哪个媒体给的？" +
                            "找不到依据的句子直接删掉，宁短不凑。",
                    },
                    {
                        role: "user",
                        content:
                            memoriesText +
                            previousText +
                            "【本轮聊天记录（每行前面是发送时间 HH:MM）】\n" + transcript,
                    },
                ],
                { temperature: 0.3, label: "chat-archive" },
            ), 60000);
            if (!res.content) {
                onNotice(res.error || "提炼失败");
                return;
            }
            // 模型只出「新增段落 + 新锚点」，老正文由代码原样拼回去（绝不压缩、绝不被模型改写）
            let added = splitNewParts(res.content);
            if (!added.body) {
                onNotice("提炼结果为空，请重试");
                return;
            }
            // 第二轮自检：只核对新增部分，逐句回查本轮记录
            try {
                const checked = await withTimeout(simpleLLMCall(
                    apiConfig,
                    [
                        {
                            role: "system",
                            content:
                                "你是归档审校员。给你本轮聊天记录和一段新增归档，逐句核对：" +
                                "每一句都必须能在这轮记录里找到依据（出现过的对白、媒体事件、双方明确说过的状态）。\n" +
                                "1. 记录里没有的动作、表情、环境、氛围、心理判断，编造的对白与结尾，全部删掉。\n" +
                                "2. 把写成同一空间、共享物理空间的句子（「歪头看向手机屏幕」「把手机推过来」「递过去」等），" +
                                "改写成各自在各自所在地、隔着手机。\n" +
                                "3. 不要新增内容，不要改格式，不要写解释或修订说明。\n" +
                                "4. 原样输出这两块：【新增段落】…【关键锚点】…（五类都保留）。",
                        },
                        {
                            role: "user",
                            content:
                                settingsText +
                                "【本轮聊天记录】\n" + transcript +
                                "\n\n【待审校的新增部分】\n【新增段落】\n" + added.body +
                                "\n\n" + (added.anchors || "【关键锚点】\n· 物品与状态：无变化\n· 认知与事实澄清：无变化\n· 违规隐患：无变化\n· 关系变化：无变化\n· 待兑现：无变化"),
                        },
                    ],
                    { temperature: 0.1, label: "chat-archive-check" },
                ), 60000);
                const checkedText = checked.content?.trim();
                if (checkedText && checkedText.includes("【关键锚点】")) {
                    const revised = splitNewParts(checkedText);
                    if (revised.body) added = { body: revised.body, anchors: revised.anchors || added.anchors };
                }
            } catch { /* 自检失败就用第一版 */ }
            const bodyParts = [previousParts.body, added.body].filter(Boolean).join("\n\n");
            const anchorPart = added.anchors || previousParts.anchors;
            setDraft([header, bodyParts, anchorPart].filter(Boolean).join("\n\n"));
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
            // 归档是「单条滚动」的：已有归档就原地增量更新，不新建、不删旧
            const list = await loadMemoryEntriesByType(characterId, "archive");
            const target = list
                .filter(entry => entry.sourceApp !== "ensemble" && !entry.metadata?.listenRecord)
                .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))[0];
            const res = target
                ? await updateArchiveEntry(characterId, target.id, text)
                : await commitArchive(characterId, text, "chat");
            if (res.success) {
                onNotice(target ? "已追加进归档，写入角色记忆" : "已归档，写入角色记忆");
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
            // 普通聊天归档原地改，不删除（删除会写防污染墓碑，还会丢 id）
            const res = entry.sourceApp === "ensemble"
                ? await (async () => {
                    await deleteArchive(characterId, entry.id);
                    return commitArchive(characterId, text, entry.sourceApp);
                })()
                : await updateArchiveEntry(characterId, entry.id, text);
            if (res.success) {
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
