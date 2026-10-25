"use client";

import { Component, useState, useEffect, useCallback, type CSSProperties, type ReactNode } from "react";
import { Trash2, Zap, Clock, Users, Archive, AlertCircle, Search, FileText, MoreHorizontal, Plus, Edit3, X, Check, ChevronRight, Filter, type LucideIcon } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/modal";
import { MemoryTimeline } from "./memory-timeline";
import { Toggle } from "@/components/ui/form";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import type { MemoryEntry, MemoryConfig } from "@/lib/memory-types";
import { DEFAULT_SUMMARIZATION_PROMPT } from "@/lib/memory-types";
import {
    loadMemoryConfig,
    saveMemoryConfig,
    loadMemoryEntriesByType,
    saveMemoryEntry,
    deleteMemoryEntry,
    deleteCharacterMemoriesByType,
    getAllCharacterIdsWithMemories,
    getMemoryCountByType,
    getLastSummarizedTimestamp,
} from "@/lib/memory-storage";
import { hydrateChatStorage } from "@/lib/chat-storage";
import { loadNativeTimeline, type NativeTimelineEntry } from "@/lib/short-term-assembler";
import { runSummarizationPipeline } from "@/lib/memory-summarizer";
import { resolveAuxiliaryApiConfig, resolveUserIdentity } from "@/lib/settings-storage";
import { generateEmbedding, resolveEmbeddingModel } from "@/lib/memory-embedding";
import { BINDING_ACCENTS } from "@/lib/ui-accent-colors";

type MemoryView = "list" | "detail" | "settings";
type MemoryTab = "short" | "shared" | "long" | "archive";
type MemoryBudgetKey = "shortTermTokenBudget" | "longTermTokenBudget";

const MEMORY_TOKEN_BUDGET_MAX = 100000;
const MEMORY_TOKEN_BUDGET_MIN: Record<MemoryBudgetKey, number> = {
    shortTermTokenBudget: 1000,
    longTermTokenBudget: 200,
};
const MEMORY_TOKEN_BUDGET_STEP: Record<MemoryBudgetKey, number> = {
    shortTermTokenBudget: 5000,
    longTermTokenBudget: 1000,
};
const MANUAL_MEMORY_CONTENT_LIMIT = 3000;
// 详情页时间线最多解析渲染的条数：全量历史可能有几万条，
// 一次性解析+渲染会把 iOS Safari 的单页内存顶爆（灰屏杀页）
const MEMORY_TIMELINE_ENTRY_CAP = 2000;

/** 详情页兜底：时间线渲染抛错时显示提示，而不是整页白屏 */
class MemoryDetailBoundary extends Component<{ children?: ReactNode }, { failed: boolean }> {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    render() {
        if (this.state.failed) {
            return <p className="text-center ts-14 mt-10 text-secondary">这一页加载出错了，返回上一页再试一次。</p>;
        }
        return this.props.children;
    }
}

type SummarizeRange = "auto" | "all" | number;

const SUMMARIZE_RANGE_OPTIONS: Array<{ value: SummarizeRange; label: string; desc?: string }> = [
    { value: "auto", label: "接着上次总结", desc: "默认方式，从上次进度继续" },
    { value: 1, label: "最近 1 天" },
    { value: 3, label: "最近 3 天" },
    { value: 7, label: "最近 7 天" },
    { value: 14, label: "最近 14 天" },
    { value: 30, label: "最近 30 天" },
    { value: "all", label: "全部历史" },
];

type MemorySourceKey = keyof NonNullable<MemoryConfig["shortTermAllowedSources"]>;

/** 记忆来源开关：同时作用于短期上下文与长期总结。
 *  一个选项可绑定多个内部 key（如聊天室普通模式 = 私聊+群聊），开关时整体联动 */
const MEMORY_SOURCE_OPTIONS: Array<{ keys: MemorySourceKey[]; label: string }> = [
    { keys: ["chat", "group_chat"], label: "聊天室普通模式" },
    { keys: ["moments"], label: "朋友圈" },
    { keys: ["checkphone"], label: "查手机" },
    { keys: ["diary"], label: "手记便签" },
    { keys: ["xiaohongshu"], label: "小红书" },
    { keys: ["interview_magazine"], label: "在场访谈" },
    { keys: ["cocreate"], label: "共创" },
    { keys: ["game"], label: "内置小游戏" },
    // "story"（剧情小剧场）已隐藏：剧情 app 下线，剧情记忆走群像归档
    { keys: ["vn"], label: "漫卷" },
    { keys: ["adventure"], label: "地图冒险" },
    { keys: ["custom_app"], label: "自定义应用" },
    { keys: ["ensemble"], label: "群像剧本" },
];

/** 长期记忆 Tab 按来源分组时的展示名 */
const SOURCE_APP_LABELS: Record<string, string> = {
    chat: "聊天室普通模式",
    group_chat: "群聊",
    moments: "朋友圈",
    checkphone: "查手机",
    diary: "手记便签",
    xiaohongshu: "小红书",
    interview_magazine: "在场访谈",
    cocreate: "共创",
    game: "内置小游戏",
    story: "剧情小剧场",
    vn: "漫卷",
    adventure: "地图冒险",
    custom_app: "自定义应用",
    ensemble: "群像剧本",
};

type MemoryEditorState = {
    type: MemoryEntry["type"];
    entry?: MemoryEntry;
    content: string;
};

const memorySettingsIconStyle = (color: string): CSSProperties => ({
    "--icon-color": color,
} as CSSProperties);

function MemorySettingsIcon({ icon: Icon, color }: { icon: LucideIcon; color: string }) {
    return (
        <span className="card-icon" style={memorySettingsIconStyle(color)}>
            <Icon size={22} strokeWidth={1.75} />
        </span>
    );
}

function MemorySettingsSliderItem({
    icon,
    color,
    label,
    desc,
    value,
    onOpenPicker,
}: {
    icon: LucideIcon;
    color: string;
    label: string;
    desc: string;
    value: number;
    /** 方案A防误触：行内滑块改为点击整行弹底部弹层调节 */
    onOpenPicker: () => void;
}) {
    return (
        <button type="button" className="menu-item memory-slider-item memory-slider-row" onClick={onOpenPicker}>
            <MemorySettingsIcon icon={icon} color={color} />
            <div className="menu-label-group">
                <span className="menu-label">{label}</span>
                <span className="menu-desc">{desc}</span>
            </div>
            <div className="menu-right">
                <span className="ui-slider-value memory-slider-current">{value}</span>
                <ChevronRight size={16} />
            </div>
        </button>
    );
}

/** 底部弹层滑块：大滑块 + 数值 + 完成按钮，拖动过程只改本地草稿，点完成才落库 */
function MemorySliderSheet({
    label,
    value,
    min,
    max,
    step,
    onChange,
    onDone,
    onClose,
}: {
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    onChange: (value: number) => void;
    onDone: () => void;
    onClose: () => void;
}) {
    const [draft, setDraft] = useState(value);
    useEffect(() => { setDraft(value); }, [value]);
    return (
        <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={onClose}>
            <div className="modal-sheet" data-ui="modal-sheet" onClick={event => event.stopPropagation()}>
                <div className="modal-header" data-ui="modal-header">
                    <span style={{ width: 28 }} />
                    <h3 className="modal-title">{label}</h3>
                    <button className="modal-header-btn modal-header-btn-muted" onClick={onClose}><X size={18} /></button>
                </div>
                <div className="modal-body modal-body-tight" data-ui="modal-body">
                    <p className="text-center ts-28 font-medium mb-2" style={{ fontVariantNumeric: "tabular-nums" }}>{draft}</p>
                    <input
                        type="range"
                        min={min}
                        max={max}
                        step={step}
                        value={draft}
                        onChange={e => { const next = Number(e.target.value); setDraft(next); onChange(next); }}
                        className="ui-slider memory-settings-slider w-full"
                        aria-label={label}
                    />
                    <div className="flex justify-between ts-12 text-secondary mt-1">
                        <span>{min}</span>
                        <span>{max}</span>
                    </div>
                    <button className="ui-btn ui-btn-primary p-2.5 w-full mt-4" onClick={onDone}>完成</button>
                </div>
            </div>
        </div>
    );
}

function relativeTime(isoStr: string): string {
    const diff = Date.now() - new Date(isoStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "刚刚";
    if (mins < 60) return `${mins}分钟前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}天前`;
    const weeks = Math.floor(days / 7);
    if (weeks < 4) return `${weeks}周前`;
    return `${Math.floor(days / 30)}个月前`;
}

type CharacterMemoryInfo = {
    character: Character;
    longTermCount: number;
    shortTermCount: number;
};

type Props = {
    view: MemoryView;
    selectedCharId?: string;
    onSelectChar: (charId: string) => void;
    onNotice?: (msg: string) => void;
};

export function MemoryBankPage({ view, selectedCharId, onSelectChar, onNotice }: Props) {
    const [config, setConfig] = useState<MemoryConfig>(loadMemoryConfig);
    const [characters, setCharacters] = useState<CharacterMemoryInfo[]>([]);
    const [activeTab, setActiveTab] = useState<MemoryTab>("short");
    const [longTermEntries, setLongTermEntries] = useState<MemoryEntry[]>([]);
    /** 归档 Tab：群像杀青写入的只读归档（type=archive, sourceApp=ensemble），并列只读不进总结素材 */
    const [archiveEntries, setArchiveEntries] = useState<MemoryEntry[]>([]);
    const [shortTermEvents, setShortTermEvents] = useState<NativeTimelineEntry[]>([]);
    const [sharedEvents, setSharedEvents] = useState<NativeTimelineEntry[]>([]);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [summarizing, setSummarizing] = useState(false);
    const [editingPrompt, setEditingPrompt] = useState<string | null>(null);
    const [confirmDeleteEntryId, setConfirmDeleteEntryId] = useState<string | null>(null);
    const [confirmClearAll, setConfirmClearAll] = useState(false);
    const [pickedCharId, setPickedCharId] = useState<string | null>(null);
    const [entryMenuId, setEntryMenuId] = useState<string | null>(null);
    const [memoryEditor, setMemoryEditor] = useState<MemoryEditorState | null>(null);
    const [savingMemory, setSavingMemory] = useState(false);
    const [summarizeRangeOpen, setSummarizeRangeOpen] = useState(false);
    const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
    /** 方案A防误触：当前正在弹层调节的预算/间隔项 */
    const [sliderSheet, setSliderSheet] = useState<null | {
        key: "shortTermTokenBudget" | "longTermTokenBudget" | "interval";
        label: string;
        value: number;
        min: number;
        max: number;
        step: number;
    }>(null);

    const disabledSourceCount = MEMORY_SOURCE_OPTIONS
        .filter(source => source.keys.some(key => (config.shortTermAllowedSources ?? {})[key] === false)).length;

    // Resolve selected character object from ID
    const selectedChar = selectedCharId
        ? loadCharacters().find(c => c.id === selectedCharId) ?? null
        : null;

    const loadCharacterList = useCallback(async (isCancelled?: () => boolean) => {
        const allChars = loadCharacters();

        let charIdsWithMem: string[] = [];
        try { charIdsWithMem = await getAllCharacterIdsWithMemories(); } catch { /* DB may fail */ }

        const infos: CharacterMemoryInfo[] = [];
        const seen = new Set<string>();

        // Characters with memories first
        for (const id of charIdsWithMem) {
            const char = allChars.find(c => c.id === id);
            if (!char) continue;
            seen.add(id);
            let ltCount = 0;
            try {
                ltCount = await getMemoryCountByType(id, "long_term");
            } catch { /* ignore */ }
            infos.push({ character: char, longTermCount: ltCount, shortTermCount: 0 });
        }

        // Remaining characters
        for (const char of allChars) {
            if (seen.has(char.id)) continue;
            infos.push({ character: char, longTermCount: 0, shortTermCount: 0 });
        }

        if (isCancelled?.()) return;
        setCharacters(infos);

        // 短期计数逐个异步补齐：loadNativeTimeline 是全量组装，重数据账号
        // 在循环里同步跑完会长时间卡死主线程、瞬时吃掉大量内存
        for (const info of infos) {
            await new Promise(resolve => setTimeout(resolve, 0));
            if (isCancelled?.()) return;
            let stCount = 0;
            try { stCount = loadNativeTimeline(info.character.id).length; } catch { /* ignore */ }
            if (isCancelled?.()) return;
            setCharacters(prev => prev.map(item =>
                item.character.id === info.character.id ? { ...item, shortTermCount: stCount } : item));
        }
    }, []);

    useEffect(() => {
        let cancelled = false;
        void loadCharacterList(() => cancelled);
        return () => { cancelled = true; };
    }, [loadCharacterList]);

    // Load detail data when entering detail view
    const loadDetailData = useCallback(async (charId: string) => {
        setLoading(true);
        try {
            await hydrateChatStorage();
            const [lt, arc] = await Promise.all([
                loadMemoryEntriesByType(charId, "long_term"),
                loadMemoryEntriesByType(charId, "archive").catch(() => []),
            ]);
            setLongTermEntries(lt);
            setArchiveEntries(arc);
        } catch {
            setLongTermEntries([]);
        }
        // Native timeline is sync (localStorage) — no await needed.
        // 只取最近一段（全量可能几万条），防止解析+渲染把 iOS Safari 内存顶爆
        const timeline = loadNativeTimeline(charId).slice(-MEMORY_TIMELINE_ENTRY_CAP);
        setShortTermEvents(timeline.filter(e =>
            !(e.sourceApp === "moments" && e.postAuthorType === "user")
            && !(e.sourceApp === "interview_magazine" && e.sourceDetail === "interview_shared_issue")
        ));
        setSharedEvents(timeline.filter(e =>
            (e.sourceApp === "moments" && e.postAuthorType === "user") ||
            (e.sourceApp === "chat" && e.sourceDetail === "group") ||
            (e.sourceApp === "interview_magazine" && e.sourceDetail === "interview_shared_issue")
        ));
        setLoading(false);
    }, []);

    // Reload detail data when view changes to detail
    useEffect(() => {
        if (view === "detail" && selectedCharId) {
            setActiveTab("short");
            setExpandedId(null);
            loadDetailData(selectedCharId);
        }
    }, [view, selectedCharId, loadDetailData]);

    // Reset editing prompt when leaving settings
    useEffect(() => {
        if (view !== "settings") {
            setEditingPrompt(null);
        }
    }, [view]);

    const handleSelectChar = (char: Character) => {
        onSelectChar(char.id);
    };

    const handleDeleteEntry = async (id: string) => {
        await deleteMemoryEntry(id);
        setLongTermEntries(prev => prev.filter(e => e.id !== id));
        setEntryMenuId(null);
        loadCharacterList();
    };

    const handleClearEntries = async (type: "long_term") => {
        if (!selectedCharId) return;
        await deleteCharacterMemoriesByType(selectedCharId, type);
        setLongTermEntries([]);
        loadCharacterList();
    };

    const showNotice = (msg: string) => {
        onNotice?.(msg);
    };

    const handleManualSummarize = async (range: SummarizeRange = "auto") => {
        if (!selectedCharId || summarizing) return;
        setSummarizeRangeOpen(false);
        setSummarizing(true);
        try {
            const sinceTimestamp = typeof range === "number"
                ? new Date(Date.now() - range * 86400000).toISOString()
                : undefined;
            const afterTimestamp = range === "all"
                ? undefined
                : sinceTimestamp ?? getLastSummarizedTimestamp(selectedCharId) ?? undefined;
            const timelineCount = loadNativeTimeline(
                selectedCharId,
                afterTimestamp ? { afterTimestamp } : undefined,
            ).length;
            if (timelineCount < 4) {
                showNotice("所选范围内事件不足 4 条");
                return;
            }

            const result = await runSummarizationPipeline(
                selectedCharId,
                selectedChar?.name ?? "",
                range === "all" ? { force: true } : sinceTimestamp ? { sinceTimestamp } : undefined,
            );
            if (result.success) {
                showNotice("总结完成");
                loadDetailData(selectedCharId);
                loadCharacterList();
            } else {
                showNotice(result.error || "总结失败");
            }
        } catch (err) {
            console.error("[MemoryBank] Manual summarize failed:", err);
            showNotice("总结失败: " + String(err));
        } finally {
            setSummarizing(false);
        }
    };

    const saveBudget = (key: MemoryBudgetKey, value: number) => {
        if (!Number.isFinite(value)) return;
        const min = MEMORY_TOKEN_BUDGET_MIN[key];
        const nextValue = Math.min(MEMORY_TOKEN_BUDGET_MAX, Math.max(min, Math.round(value)));
        const next = { ...config, [key]: nextValue };
        setConfig(next);
        saveMemoryConfig(next);
    };

    const saveInterval = (value: number) => {
        if (!Number.isFinite(value)) return;
        const nextValue = Math.min(200, Math.max(10, Math.round(value)));
        const next = { ...config, summarizationEventInterval: nextValue };
        setConfig(next);
        saveMemoryConfig(next);
    };

    // ── Prompt editing ──
    const handleSavePrompt = () => {
        if (editingPrompt === null) return;
        const next = { ...config, summarizationPrompt: editingPrompt };
        setConfig(next);
        saveMemoryConfig(next);
        showNotice("提示词已保存");
    };

    const handleResetPrompt = () => {
        setEditingPrompt(DEFAULT_SUMMARIZATION_PROMPT);
        const next = { ...config, summarizationPrompt: DEFAULT_SUMMARIZATION_PROMPT };
        setConfig(next);
        saveMemoryConfig(next);
        showNotice("已恢复默认提示词");
    };

    const createManualMemoryId = (type: MemoryEntry["type"]) => (
        `mem_${type === "core" ? "core" : "lt"}_manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    );

    const isManualMemoryEntry = (entry: MemoryEntry) => {
        const origin = String(entry.metadata?.origin ?? "");
        return origin === "user_manual" || origin === "user_edited" || entry.id.includes("_manual_");
    };

    const maybeBuildManualMemoryEmbedding = async (type: MemoryEntry["type"], content: string): Promise<number[] | undefined> => {
        if (type !== "long_term" || !config.vectorRecallEnabled) return undefined;
        const embeddingApiConfig = resolveAuxiliaryApiConfig("embeddingApiConfigId");
        if (!embeddingApiConfig || !resolveEmbeddingModel(embeddingApiConfig)) return undefined;
        try {
            return await generateEmbedding(content, embeddingApiConfig) ?? undefined;
        } catch {
            return undefined;
        }
    };

    const openCreateMemoryEditor = (type: MemoryEntry["type"]) => {
        setEntryMenuId(null);
        setMemoryEditor({ type, content: "" });
    };

    const openEditMemoryEditor = (entry: MemoryEntry) => {
        setEntryMenuId(null);
        setMemoryEditor({ type: entry.type, entry, content: entry.content });
    };

    const handleSaveManualMemory = async () => {
        if (!selectedCharId || !memoryEditor || savingMemory) return;
        const content = memoryEditor.content.trim();
        if (!content) {
            showNotice("记忆内容不能为空");
            return;
        }
        if (content.length > MANUAL_MEMORY_CONTENT_LIMIT) {
            showNotice(`记忆内容过长，请控制在 ${MANUAL_MEMORY_CONTENT_LIMIT} 字以内`);
            return;
        }

        setSavingMemory(true);
        try {
            const now = new Date().toISOString();
            const type = memoryEditor.type;
            const source = memoryEditor.entry;
            const contentChanged = !source || source.content.trim() !== content;
            const embedding = type === "long_term"
                ? (contentChanged ? await maybeBuildManualMemoryEmbedding(type, content) : source?.embedding)
                : undefined;
            const entry: MemoryEntry = source
                ? {
                    ...source,
                    content,
                    embedding,
                    updatedAt: now,
                    metadata: {
                        ...(source.metadata ?? {}),
                        origin: isManualMemoryEntry(source) ? "user_manual" : "user_edited",
                        editedByUser: true,
                    },
                }
                : {
                    id: createManualMemoryId(type),
                    characterId: selectedCharId,
                    sourceApp: "chat",
                    type,
                    content,
                    embedding,
                    importance: type === "core" ? 0.95 : 0.8,
                    createdAt: now,
                    updatedAt: now,
                    metadata: {
                        origin: "user_manual",
                    },
                };

            await saveMemoryEntry(entry);
            setLongTermEntries(prev => source ? prev.map(item => item.id === entry.id ? entry : item) : [...prev, entry]);
            setMemoryEditor(null);
            setExpandedId(entry.id);
            loadCharacterList();
            showNotice("长期记忆已保存");
        } catch (error) {
            console.error("[MemoryBank] Save manual memory failed:", error);
            showNotice("记忆保存失败: " + String(error));
        } finally {
            setSavingMemory(false);
        }
    };

    const renderMemoryEntries = (type: MemoryEntry["type"], entries: MemoryEntry[], emptyText: string) => {
        const label = "长期记忆";
        // 长期记忆按来源 app 分组展示：组头 = app 名，组内按时间倒序。便于按 app 圈选编辑/删除/重总结
        const groups: Array<{ key: string; label: string; items: MemoryEntry[] }> = [];
        {
            const sorted = [...entries].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
            const index = new Map<string, number>();
            for (const entry of sorted) {
                const key = entry.sourceApp || "unknown";
                if (!index.has(key)) {
                    index.set(key, groups.length);
                    groups.push({ key, label: SOURCE_APP_LABELS[key] ?? key, items: [] });
                }
                groups[index.get(key)!].items.push(entry);
            }
        }
        return (
            <>
                {entries.length > 0 && (
                    <div className="mem-entry-toolbar">
                        <button
                            className="mem-entry-add-btn"
                            onClick={() => openCreateMemoryEditor(type)}
                        >
                            <Plus size={15} strokeWidth={1.8} />
                            <span>新增{label}</span>
                        </button>
                        <button
                            className="mem-entry-clear-btn"
                            onClick={() => setConfirmClearAll(true)}
                        >
                            <Trash2 size={15} strokeWidth={1.8} />
                            <span>清除{label}</span>
                        </button>
                    </div>
                )}
                {entryMenuId && (
                    <button
                        className="mem-entry-menu-backdrop"
                        aria-label="关闭菜单"
                        onClick={() => setEntryMenuId(null)}
                    />
                )}
                {entries.length === 0 ? (
                    <div className="mem-empty-card">
                        <p>{emptyText}</p>
                        <button className="mem-empty-add-btn" onClick={() => openCreateMemoryEditor(type)}>
                            <Plus size={14} />
                            <span>新增{label}</span>
                        </button>
                    </div>
                ) : (
                    groups.map(group => (
                        <div key={group.key} className="mem-source-group">
                            {groups.length > 1 && (
                                <div className="mem-source-group-head">
                                    <span>{group.label}</span>
                                    <span className="mem-source-group-count">{group.items.length}</span>
                                </div>
                            )}
                            {group.items.map(entry => (
                                <div
                                    key={entry.id}
                                    className={`g-card memory-report-card${entryMenuId === entry.id ? " is-menu-open" : ""}`}
                                    onClick={() => {
                                        if (entryMenuId) {
                                            setEntryMenuId(null);
                                            return;
                                        }
                                        setExpandedId(expandedId === entry.id ? null : entry.id);
                                    }}
                                >
                                    <div className="mem-report-head">
                                        <span className="ts-11 text-secondary" style={{ letterSpacing: "1px" }}>[ DATE: {relativeTime(entry.createdAt)} ]</span>
                                        <div className="mem-report-actions">
                                            <span className={`mem-origin-badge ${isManualMemoryEntry(entry) ? "is-manual" : ""}`}>
                                                {isManualMemoryEntry(entry) ? "MANUAL" : "AUTO"}
                                            </span>
                                            <div className="mem-entry-menu-wrap">
                                                <button
                                                    className="mem-entry-menu-btn"
                                                    onClick={(event) => {
                                                        event.stopPropagation();
                                                        setEntryMenuId(prev => prev === entry.id ? null : entry.id);
                                                    }}
                                                    title="更多"
                                                >
                                                    <MoreHorizontal size={18} />
                                                </button>
                                                {entryMenuId === entry.id && (
                                                    <div className="mem-entry-menu" onClick={event => event.stopPropagation()}>
                                                        <button onClick={() => openEditMemoryEditor(entry)}>
                                                            <Edit3 size={13} />
                                                            <span>编辑</span>
                                                        </button>
                                                        <button
                                                            className="is-danger"
                                                            onClick={() => {
                                                                setEntryMenuId(null);
                                                                setConfirmDeleteEntryId(entry.id);
                                                            }}
                                                        >
                                                            <Trash2 size={13} />
                                                            <span>删除</span>
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="ts-12 leading-[1.7]">
                                        {expandedId === entry.id
                                            ? entry.content
                                            : entry.content.length > 100
                                                ? entry.content.slice(0, 100) + "..."
                                                : entry.content
                                        }
                                    </div>
                                </div>
                            ))}
                        </div>
                    ))
                )}
            </>
        );
    };


    // ── Detail View ──
    if (view === "detail" && selectedChar) {
        return (
            <div className="flex flex-col absolute inset-0 overflow-hidden" style={{ padding: "0 16px" }}>
                {/* Content */}
                <div className="memory-detail-scroll flex-1 overflow-y-auto flex flex-col gap-2 min-h-0">
                    <MemoryDetailBoundary>
                    {loading ? (
                        <p className="text-center ts-14 mt-10 text-secondary">
                            加载中...
                        </p>
                    ) : activeTab === "short" ? (
                        /* ── Short-term: card view ── */
                        <>
                            <MemoryTimeline
                                events={shortTermEvents}
                                userName={resolveUserIdentity(selectedCharId!)?.name || "用户"}
                            />
                        </>
                    ) : activeTab === "shared" ? (
                        /* ── Shared events: card view ── */
                        sharedEvents.length === 0 ? (
                            <p className="text-center ts-14 mt-10 text-secondary">
                                暂无共享事件。用户发朋友圈或参与群聊后会自动显示。
                            </p>
                        ) : (
                            <MemoryTimeline
                                events={sharedEvents}
                                userName={resolveUserIdentity(selectedCharId!)?.name || "用户"}
                            />
                        )
                    ) : activeTab === "archive" ? (
                        /* ── 归档：群像杀青写入的剧情归档，并列只读，不进总结素材 ── */
                        archiveEntries.length === 0 ? (
                            <div className="mem-empty-card">
                                <p>暂无归档。在群像 App 杀青剧本后，剧情归档会自动出现在这里。</p>
                            </div>
                        ) : (
                            archiveEntries.map(entry => (
                                <div
                                    key={entry.id}
                                    className="g-card memory-report-card"
                                    onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
                                >
                                    <div className="mem-report-head">
                                        <span className="ts-11 text-secondary" style={{ letterSpacing: "1px" }}>[ DATE: {relativeTime(entry.createdAt)} ]</span>
                                        <span
                                            className="ts-11 font-bold px-2 py-0.5 rounded-full"
                                            style={{ background: "rgba(192,174,142,0.18)", color: "#8a7550", letterSpacing: "1px" }}
                                        >
                                            {entry.sourceApp === "ensemble" ? "ENSEMBLE" : "ARCHIVE"}
                                        </span>
                                    </div>
                                    <p
                                        className={`ts-13 leading-relaxed whitespace-pre-wrap${expandedId === entry.id ? "" : " line-clamp-3"}`}
                                        style={{ marginTop: "6px" }}
                                    >
                                        {entry.content}
                                    </p>
                                </div>
                            ))
                        )
                    ) : (
                        /* ── Long-term: Summarized Memories ── */
                        renderMemoryEntries("long_term", longTermEntries, "暂无长期记忆。点击设置页的手动总结，或直接新增一条记忆。")
                    )}
                    </MemoryDetailBoundary>
                </div>

                {/* Bottom tab bar — floating above bottom */}
                <div className="chat-tab-bar" style={{ position: "absolute", bottom: 40, left: 40, right: 40, zIndex: 10, borderRadius: 28, borderTop: "none", padding: "10px 0" }}>
                    {([
                        { key: "short" as const, icon: Clock, label: "短期" },
                        { key: "shared" as const, icon: Users, label: "共享事件" },
                        { key: "long" as const, icon: Archive, label: "长期" },
                        { key: "archive" as const, icon: Archive, label: "归档" },
                    ]).map(tab => (
                        <button
                            key={tab.key}
                            className={`chat-tab${activeTab === tab.key ? " chat-tab-active" : ""}`}
                            onClick={() => {
                                setActiveTab(tab.key);
                                setEntryMenuId(null);
                            }}
                        >
                            <tab.icon size={18} />
                            <span>{tab.label}</span>
                        </button>
                    ))}
                </div>

                {/* Manual memory editor */}
                {memoryEditor && (() => {
                    const isEdit = Boolean(memoryEditor.entry);
                    const title = `${isEdit ? "编辑" : "新增"}长期记忆`;
                    const placeholder = "记录一次重要事件、承诺、偏好、关系变化，后续对话会参考。";
                    const contentLength = memoryEditor.content.trim().length;
                    const overLimit = contentLength > MANUAL_MEMORY_CONTENT_LIMIT;
                    return (
                        <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={() => savingMemory ? undefined : setMemoryEditor(null)}>
                            <div className="modal-sheet mem-edit-sheet" data-ui="modal-sheet" onClick={event => event.stopPropagation()}>
                                <div className="modal-header" data-ui="modal-header">
                                    <button
                                        className="modal-header-btn modal-header-btn-muted"
                                        onClick={() => setMemoryEditor(null)}
                                        disabled={savingMemory}
                                    >
                                        <X size={18} />
                                    </button>
                                    <h3 className="modal-title">{title}</h3>
                                    <button
                                        className="modal-header-btn modal-header-btn-action"
                                        onClick={handleSaveManualMemory}
                                        disabled={savingMemory || !contentLength || overLimit}
                                    >
                                        <Check size={18} />
                                    </button>
                                </div>
                                <div className="modal-body mem-edit-body" data-ui="modal-body">
                                    <textarea
                                        className="ui-textarea mem-edit-textarea"
                                        value={memoryEditor.content}
                                        placeholder={placeholder}
                                        disabled={savingMemory}
                                        onChange={event => setMemoryEditor(prev => prev ? { ...prev, content: event.target.value } : prev)}
                                    />
                                    <div className={`mem-edit-footer ${overLimit ? "is-over-limit" : ""}`}>
                                        <span>LONG TERM</span>
                                        <span>{contentLength}/{MANUAL_MEMORY_CONTENT_LIMIT}</span>
                                    </div>
                                    <button
                                        className="ui-btn ui-btn-primary mem-edit-save-btn"
                                        onClick={handleSaveManualMemory}
                                        disabled={savingMemory || !contentLength || overLimit}
                                    >
                                        {savingMemory ? "保存中..." : "保存记忆"}
                                    </button>
                                </div>
                            </div>
                        </div>
                    );
                })()}

                {/* Confirm delete single entry */}
                {confirmDeleteEntryId && (
                    <ConfirmDialog
                        title="确认删除？"
                        message="删除记忆条目后无法恢复。是否继续？"
                        icon={AlertCircle}
                        variant="danger"
                        confirmLabel="确认删除"
                        onConfirm={() => {
                            handleDeleteEntry(confirmDeleteEntryId);
                            setConfirmDeleteEntryId(null);
                        }}
                        onCancel={() => setConfirmDeleteEntryId(null)}
                    />
                )}

                {/* Confirm clear all long-term entries */}
                {confirmClearAll && (
                    <ConfirmDialog
                        title="确认清除？"
                        message="将清除该角色所有长期记忆，此操作无法恢复。"
                        icon={AlertCircle}
                        variant="danger"
                        confirmLabel="确认清除"
                        onConfirm={() => {
                            handleClearEntries("long_term");
                            setConfirmClearAll(false);
                        }}
                        onCancel={() => setConfirmClearAll(false)}
                    />
                )}
            </div>
        );
    }

    // ── Settings View ──
    if (view === "settings") {
        const currentPrompt = editingPrompt ?? config.summarizationPrompt ?? DEFAULT_SUMMARIZATION_PROMPT;
        const isModified = currentPrompt !== (config.summarizationPrompt ?? DEFAULT_SUMMARIZATION_PROMPT);
        const isDefault = (config.summarizationPrompt ?? DEFAULT_SUMMARIZATION_PROMPT) === DEFAULT_SUMMARIZATION_PROMPT;

        return (
            <div className="page-menu memory-settings-menu">
                {/* 总结：手动与自动放同一组，避免同一功能重复出现 */}
                <p className="menu-group-desc mx-2">总结</p>
                <div className="menu-group">
                    <button
                        type="button"
                        className="menu-item"
                        onClick={() => {
                            if (!selectedCharId || summarizing) return;
                            setSummarizeRangeOpen(true);
                        }}
                        disabled={!selectedCharId}
                    >
                        <MemorySettingsIcon icon={Zap} color={BINDING_ACCENTS.memory} />
                        <div className="menu-label-group">
                            <span className="menu-label">长期记忆手动总结</span>
                            <span className="menu-desc">
                                {selectedCharId ? "将新产生的事件整理为长期记忆" : "请先选择角色"}
                            </span>
                        </div>
                        <div className="menu-right">
                            <span className="menu-desc mr-1">
                                {config.autoSummarizeEnabled ?? true ? `自动 · 每 ${config.summarizationEventInterval ?? 80} 条` : "自动总结已关"}
                            </span>
                            <ChevronRight size={16} />
                        </div>
                    </button>
                    <div className="menu-item">
                        <MemorySettingsIcon icon={Clock} color={BINDING_ACCENTS.memory} />
                        <div className="menu-label-group">
                            <span className="menu-label">长期记忆自动总结</span>
                            <span className="menu-desc">每隔一定条数自动将新事件整理为长期记忆</span>
                        </div>
                        <div className="menu-right">
                            <Toggle checked={config.autoSummarizeEnabled ?? true} onChange={(v) => {
                                const next = { ...config, autoSummarizeEnabled: v };
                                setConfig(next);
                                saveMemoryConfig(next);
                            }} />
                        </div>
                    </div>
                    <div className="menu-item">
                        <MemorySettingsIcon icon={Search} color={BINDING_ACCENTS.embedding} />
                        <div className="menu-label-group">
                            <span className="menu-label">向量召回</span>
                            <span className="menu-desc">长期记忆超出预算时，通过 embedding 按相关性检索</span>
                        </div>
                        <div className="menu-right">
                            <Toggle checked={config.vectorRecallEnabled ?? true} onChange={(v) => {
                                const next = { ...config, vectorRecallEnabled: v };
                                setConfig(next);
                                saveMemoryConfig(next);
                            }} />
                        </div>
                    </div>
                </div>

                {summarizeRangeOpen ? (
                    <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={() => setSummarizeRangeOpen(false)}>
                        <div className="modal-sheet" data-ui="modal-sheet" onClick={event => event.stopPropagation()}>
                            <div className="modal-header" data-ui="modal-header">
                                <button className="modal-header-btn modal-header-btn-muted" onClick={() => setSummarizeRangeOpen(false)}><X size={18} /></button>
                                <h3 className="modal-title">选择总结范围</h3>
                                <span style={{ width: 44 }} />
                            </div>
                            <div className="modal-body modal-body-tight" data-ui="modal-body">
                                <div className="menu-group">
                                    {SUMMARIZE_RANGE_OPTIONS.map(option => (
                                        <button
                                            key={String(option.value)}
                                            type="button"
                                            className="menu-item w-full text-left"
                                            onClick={() => void handleManualSummarize(option.value)}
                                        >
                                            <div className="menu-label-group">
                                                <span className="menu-label">{option.label}</span>
                                                {option.desc ? <span className="menu-desc">{option.desc}</span> : null}
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>
                ) : null}

                {/* Memory source filter — one entry row, full picker lives in a bottom sheet */}
                <p className="menu-group-desc mx-2">记忆来源</p>
                <div className="menu-group">
                    <button type="button" className="menu-item" onClick={() => setSourcePickerOpen(true)}>
                        <MemorySettingsIcon icon={Filter} color={BINDING_ACCENTS.memory} />
                        <div className="menu-label-group">
                            <span className="menu-label">记忆来源</span>
                            <span className="menu-desc">选择哪些内容参与记忆</span>
                        </div>
                        <div className="menu-right">
                            <span className="menu-desc mr-1">{disabledSourceCount === 0 ? "全部开启" : `已关闭 ${disabledSourceCount} 项`}</span>
                            <ChevronRight size={16} />
                        </div>
                    </button>
                </div>

                {sourcePickerOpen ? (
                    <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={() => setSourcePickerOpen(false)}>
                        <div className="modal-sheet memory-source-sheet" data-ui="modal-sheet" onClick={event => event.stopPropagation()}>
                            <div className="modal-header" data-ui="modal-header">
                                <span style={{ width: 28 }} />
                                <h3 className="modal-title">记忆来源</h3>
                                <button className="modal-header-btn modal-header-btn-muted" onClick={() => setSourcePickerOpen(false)}><X size={18} /></button>
                            </div>
                            <div className="modal-body modal-body-tight" data-ui="modal-body">
                                <div className="memory-source-chips" style={{ "--chip-accent": BINDING_ACCENTS.memory } as CSSProperties}>
                                    {MEMORY_SOURCE_OPTIONS.map(source => {
                                        const allowed = config.shortTermAllowedSources ?? {};
                                        // 一个选项绑定多个 key（聊天室普通模式=私聊+群聊）：任一开启即视为开启，点击整体切换
                                        const isChecked = source.keys.every(key => allowed[key] !== false);
                                        return (
                                            <button
                                                key={source.label}
                                                type="button"
                                                className="memory-source-chip"
                                                data-off={isChecked ? undefined : ""}
                                                aria-pressed={isChecked}
                                                onClick={() => {
                                                    const nextSources = { ...allowed };
                                                    for (const key of source.keys) nextSources[key] = !isChecked;
                                                    const next = { ...config, shortTermAllowedSources: nextSources };
                                                    setConfig(next);
                                                    saveMemoryConfig(next);
                                                }}
                                            >
                                                {source.label}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>
                    </div>
                ) : null}

                {/* Token budget——行内只显示数值，点击弹层调节避免误触 */}
                <p className="menu-group-desc mx-2">控制截断量</p>
                <div className="menu-group">
                    <MemorySettingsSliderItem
                        icon={Users}
                        color={BINDING_ACCENTS.voice}
                        label="短期记忆+最近上下文"
                        desc="聊天历史、朋友圈、群聊与跨应用近期事件截断量"
                        value={config.shortTermTokenBudget}
                        onOpenPicker={() => setSliderSheet({
                            key: "shortTermTokenBudget",
                            label: "短期记忆+最近上下文",
                            value: config.shortTermTokenBudget,
                            min: MEMORY_TOKEN_BUDGET_MIN.shortTermTokenBudget,
                            max: MEMORY_TOKEN_BUDGET_MAX,
                            step: MEMORY_TOKEN_BUDGET_STEP.shortTermTokenBudget,
                        })}
                    />
                    <MemorySettingsSliderItem
                        icon={Archive}
                        color={BINDING_ACCENTS.memory}
                        label="长期记忆"
                        desc="总结记忆注入量"
                        value={config.longTermTokenBudget}
                        onOpenPicker={() => setSliderSheet({
                            key: "longTermTokenBudget",
                            label: "长期记忆",
                            value: config.longTermTokenBudget,
                            min: MEMORY_TOKEN_BUDGET_MIN.longTermTokenBudget,
                            max: MEMORY_TOKEN_BUDGET_MAX,
                            step: MEMORY_TOKEN_BUDGET_STEP.longTermTokenBudget,
                        })}
                    />
                </div>

                {/* Summarization interval */}
                <p className="menu-group-desc mx-2">自动总结间隔</p>
                <div className="menu-group">
                    <MemorySettingsSliderItem
                        icon={Clock}
                        color={BINDING_ACCENTS.api}
                        label="总结间隔"
                        desc="每 N 条事件自动触发总结"
                        value={config.summarizationEventInterval ?? 80}
                        onOpenPicker={() => setSliderSheet({
                            key: "interval",
                            label: "总结间隔",
                            value: config.summarizationEventInterval ?? 80,
                            min: 10,
                            max: 200,
                            step: 10,
                        })}
                    />
                </div>

                {sliderSheet ? (
                    <MemorySliderSheet
                        label={sliderSheet.label}
                        value={sliderSheet.value}
                        min={sliderSheet.min}
                        max={sliderSheet.max}
                        step={sliderSheet.step}
                        onChange={nextValue => {
                            if (sliderSheet.key === "interval") saveInterval(nextValue);
                            else saveBudget(sliderSheet.key, nextValue);
                            setSliderSheet(prev => prev ? { ...prev, value: nextValue } : prev);
                        }}
                        onDone={() => setSliderSheet(null)}
                        onClose={() => setSliderSheet(null)}
                    />
                ) : null}

                {/* Summarization Prompt Editor */}
                <p className="menu-group-desc mx-2">长期记忆提示词</p>
                <div className="menu-group">
                    <div className="menu-item">
                        <MemorySettingsIcon icon={FileText} color={BINDING_ACCENTS.preset} />
                        <div className="menu-label-group">
                            <span className="menu-label">长期记忆总结提示词</span>
                            <span className="menu-desc">
                                变量：{"{{char}}"} 角色、{"{{earliest}}"} 起始时间、{"{{latest}}"} 结束时间、{"{{events}}"} 记录集合
                            </span>
                        </div>
                        {!isDefault && (
                            <div className="menu-right">
                                <button onClick={handleResetPrompt} className="menu-label menu-label-danger ts-12 underline">
                                    恢复默认
                                </button>
                            </div>
                        )}
                    </div>
                    <div className="px-4 pb-4 flex flex-col gap-3">
                        <textarea
                            value={currentPrompt}
                            onChange={e => setEditingPrompt(e.target.value)}
                            className="ui-textarea w-full min-h-[200px] ts-14 leading-relaxed resize-y"
                        />
                        {isModified && (
                            <button
                                onClick={handleSavePrompt}
                                className="ui-btn ui-btn-primary p-2.5 w-full"
                            >
                                <Zap size={14} className="mr-1.5" /> 保存提词配置
                            </button>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    // ── Character List View ──
    return (
        <div className="mem-picker">
            <div className="mem-picker-card">
                <p className="mem-picker-cover-title">Every moment we shared becomes a timeless memory</p>
                <div className="mem-picker-divider"><span>✦</span></div>
                <div className="mem-picker-cover-wrap">
                    {"MEMORY".split("").map((ch, i) => (
                        <span key={i} className={`mem-picker-cover-letter mem-picker-letter-${i}`}>{ch}</span>
                    ))}
                    <div className="mem-picker-cover-clip">
                        {(() => {
                            const coverSrc = pickedCharId
                                ? (characters.find(c => c.character.id === pickedCharId)?.character.avatar || "")
                                : (resolveUserIdentity()?.avatarUrl || "");
                            return coverSrc ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                    src={coverSrc}
                                    alt=""
                                    className="mem-picker-cover"
                                    draggable={false}
                                />
                            ) : null;
                        })()}
                    </div>
                </div>

                <div className="mem-picker-body">
                    <p className="mem-picker-prompt">
                        你想查看谁的记忆呢？<br />
                        <span className="mem-picker-hint">点击TA的卡片查看吧</span>
                    </p>

                    <div className="mem-picker-chips">
                        {characters.map(({ character }) => (
                            <button
                                key={character.id}
                                className="ui-chip"
                                {...(pickedCharId === character.id ? { "data-selected": "" } : {})}
                                onClick={() => setPickedCharId(pickedCharId === character.id ? null : character.id)}
                            >
                                {character.name}
                            </button>
                        ))}
                    </div>

                    <div className="mem-picker-tear">
                        <div className="mem-picker-tear-line"><span>✦</span></div>
                    </div>

                    <div className="mem-picker-action">
                        <button
                            className="ui-chip ui-chip-lg"
                            {...(pickedCharId ? { "data-selected": "" } : {})}
                            onClick={() => pickedCharId && handleSelectChar(loadCharacters().find(c => c.id === pickedCharId)!)}
                        >
                            查看TA的记忆
                        </button>
                    </div>

                    <div className="mem-picker-footer">
                        <span>OBSERVER · 记忆观察员</span>
                        <span>{characters.length} PROFILES · {characters.reduce((s, c) => s + c.shortTermCount + c.longTermCount, 0)} RECORDS</span>
                        <span>{new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })}</span>
                    </div>
                </div>
            </div>
        </div>
    );
}
