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
    setGroupLastSummarizedTimestamp,
} from "@/lib/memory-storage";
import { hydrateChatStorage } from "@/lib/chat-storage";
import { loadNativeTimeline, type NativeTimelineEntry } from "@/lib/short-term-assembler";
import { runSummarizationPipeline, getSummaryGroupProgress, type SummaryGroupProgress } from "@/lib/memory-summarizer";
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

type MemorySourceKey = keyof NonNullable<MemoryConfig["shortTermAllowedSources"]>;

/** 水位线 ISO → 面板展示（M月d日 HH:mm） */
function formatWaterlineDisplay(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 水位线 ISO → datetime-local 输入值（本地时区） */
function formatWaterlineForInput(iso: string | null): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

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

/** 收放式行内滑杆（与聊天 App「朋友圈互动设置」同一实现）：
 *  收起态只显示一条细轨，点击才展开可拖动滑杆，避免翻页滚动时误触 */
function MemorySettingsSliderItem({
    icon,
    color,
    label,
    desc,
    value,
    min,
    max,
    step,
    onChange,
}: {
    icon: LucideIcon;
    color: string;
    label: string;
    desc: string;
    value: number;
    min: number;
    max: number;
    step: number;
    onChange: (value: number) => void;
}) {
    const [active, setActive] = useState(false);
    const pct = Math.max(0, Math.min(100, Math.round(((value - min) / Math.max(1, max - min)) * 100)));
    if (!active) {
        return (
            <div className="menu-item profile-slider-item">
                <MemorySettingsIcon icon={icon} color={color} />
                <div className="menu-label-group">
                    <span className="menu-label">{label}</span>
                    <span className="menu-desc">{desc}</span>
                </div>
                <button
                    type="button"
                    className="profile-slider-mini"
                    aria-label={`${label}：${value}`}
                    onClick={() => setActive(true)}
                >
                    <span className="profile-slider-mini-fill" style={{ width: `${pct}%` }} />
                </button>
                <span className="profile-slider-current">{value}</span>
            </div>
        );
    }
    return (
        <div className="menu-item profile-slider-item is-active">
            <MemorySettingsIcon icon={icon} color={color} />
            <div className="menu-label-group">
                <span className="menu-label">{label}</span>
                <span className="menu-desc">{desc}</span>
            </div>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                autoFocus
                onChange={event => onChange(Number(event.target.value))}
                onBlur={() => setActive(false)}
                onPointerUp={event => {
                    // 松手把当前值写到底层，保证拖到极值也生效
                    const el = event.currentTarget;
                    const next = Number(el.value);
                    if (next !== value) onChange(next);
                    if (document.activeElement !== el) setActive(false);
                }}
                className="ui-slider profile-settings-slider"
                aria-label={label}
            />
            <span className="profile-slider-current">{value}</span>
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
    /** 设置页内选角色：只更新当前角色，不切换视图（A1-a） */
    onPickChar?: (charId: string) => void;
    onNotice?: (msg: string) => void;
};

export function MemoryBankPage({ view, selectedCharId, onSelectChar, onPickChar, onNotice }: Props) {
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
    /** 提示词默认只读锁定，点「编辑」才进可写态 */
    const [promptEditing, setPromptEditing] = useState(false);
    const [confirmDeleteEntryId, setConfirmDeleteEntryId] = useState<string | null>(null);
    const [confirmClearAll, setConfirmClearAll] = useState(false);
    const [pickedCharId, setPickedCharId] = useState<string | null>(null);
    const [entryMenuId, setEntryMenuId] = useState<string | null>(null);
    const [memoryEditor, setMemoryEditor] = useState<MemoryEditorState | null>(null);
    const [savingMemory, setSavingMemory] = useState(false);
    const [summarizeSheetOpen, setSummarizeSheetOpen] = useState(false);
    /** 各来源分组的水位线进度（打开面板时计算） */
    const [groupProgress, setGroupProgress] = useState<SummaryGroupProgress[]>([]);
    /** 正在编辑水位线的分组 key；waterlineDraft 为 datetime-local 草稿值 */
    const [editingWaterlineKey, setEditingWaterlineKey] = useState<string | null>(null);
    const [waterlineDraft, setWaterlineDraft] = useState("");
    const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
    /** A1-a：设置页内的角色选择弹层 */
    const [charPickerOpen, setCharPickerOpen] = useState(false);
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

    /** 打开总结进度面板（各组水位线 + 待总结数） */
    const openSummarizeSheet = () => {
        if (!selectedCharId || summarizing) return;
        setGroupProgress(getSummaryGroupProgress(selectedCharId, SOURCE_APP_LABELS));
        setEditingWaterlineKey(null);
        setSummarizeSheetOpen(true);
    };

    /** datetime-local → ISO（空串 = 清除该组水位线） */
    const handleSaveWaterline = (groupKey: string) => {
        if (!selectedCharId) return;
        const ts = waterlineDraft ? new Date(waterlineDraft).toISOString() : null;
        if (waterlineDraft && Number.isNaN(new Date(waterlineDraft).getTime())) {
            showNotice("时间格式无效");
            return;
        }
        setGroupLastSummarizedTimestamp(selectedCharId, groupKey, ts);
        setGroupProgress(getSummaryGroupProgress(selectedCharId, SOURCE_APP_LABELS));
        setEditingWaterlineKey(null);
        showNotice("水位线已更新");
    };

    const handleManualSummarize = async () => {
        if (!selectedCharId || summarizing) return;
        // 增量总结：各组只取水位线之后的事件，绕过每组最少条数门槛
        const pending = getSummaryGroupProgress(selectedCharId, SOURCE_APP_LABELS)
            .reduce((sum, g) => sum + g.pendingCount, 0);
        if (pending === 0) {
            setSummarizeSheetOpen(false);
            showNotice("没有待总结的新事件");
            return;
        }
        setSummarizeSheetOpen(false);
        setSummarizing(true);
        showNotice("正在总结中…");
        try {
            const result = await runSummarizationPipeline(selectedCharId, selectedChar?.name ?? "", { manual: true });
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
                    {/* A1-a：设置页内直接选角色，手动总结不再依赖入口传参 */}
                    <button type="button" className="menu-item" onClick={() => setCharPickerOpen(true)}>
                        <MemorySettingsIcon icon={Users} color={BINDING_ACCENTS.memory} />
                        <div className="menu-label-group">
                            <span className="menu-label">当前角色</span>
                            <span className="menu-desc">{selectedChar ? selectedChar.name : "未选择，点击选择"}</span>
                        </div>
                        <div className="menu-right">
                            <ChevronRight size={16} />
                        </div>
                    </button>
                    <button
                        type="button"
                        className="menu-item"
                        onClick={() => {
                            if (!selectedCharId) return;
                            if (summarizing) {
                                showNotice("正在总结中，请稍候…");
                                return;
                            }
                            openSummarizeSheet();
                        }}
                        disabled={!selectedCharId}
                    >
                        <MemorySettingsIcon icon={Zap} color={BINDING_ACCENTS.memory} />
                        <div className="menu-label-group">
                            <span className="menu-label">长期记忆手动总结</span>
                            <span className="menu-desc">
                                {summarizing
                                    ? "正在总结中…"
                                    : selectedCharId
                                        ? "立即把新事件整理为长期记忆"
                                        : "请先选择角色"}
                            </span>
                        </div>
                        <div className="menu-right">
                            {summarizing ? (
                                <span className="mem-summarizing-dot" aria-hidden="true" />
                            ) : (
                                <ChevronRight size={16} />
                            )}
                        </div>
                    </button>
                    <div className={config.autoSummarizeEnabled ?? true ? "" : "opacity-50"}>
                        <MemorySettingsSliderItem
                            icon={Clock}
                            color={BINDING_ACCENTS.api}
                            label="总结间隔"
                            desc="每 N 条事件自动将新事件整理为长期记忆"
                            value={config.summarizationEventInterval ?? 80}
                            min={10}
                            max={200}
                            step={10}
                            onChange={nextValue => saveInterval(nextValue)}
                        />
                    </div>
                    <div className="menu-item">
                        <MemorySettingsIcon icon={Clock} color={BINDING_ACCENTS.memory} />
                        <div className="menu-label-group">
                            <span className="menu-label">长期记忆自动总结</span>
                            <span className="menu-desc">按上面「总结间隔」的条数自动触发</span>
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

                {summarizeSheetOpen ? (() => {
                    const totalPending = groupProgress.reduce((sum, g) => sum + g.pendingCount, 0);
                    return (
                        <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={() => setSummarizeSheetOpen(false)}>
                            <div className="modal-sheet" data-ui="modal-sheet" onClick={event => event.stopPropagation()}>
                                <div className="modal-header" data-ui="modal-header">
                                    <button className="modal-header-btn modal-header-btn-muted" onClick={() => setSummarizeSheetOpen(false)}><X size={18} /></button>
                                    <h3 className="modal-title">总结进度</h3>
                                    <span style={{ width: 44 }} />
                                </div>
                                <div className="modal-body modal-body-tight" data-ui="modal-body">
                                    <p className="ts-11 text-secondary px-4 pt-1 pb-2">每个来源独立记录上次总结到的时间。手动总结只处理水位线之后的新事件，不设最少条数限制。</p>
                                    {groupProgress.length === 0 ? (
                                        <p className="ts-12 text-secondary px-4 py-3">暂无可总结的记忆事件。</p>
                                    ) : (
                                        <div className="menu-group">
                                            {groupProgress.map(group => (
                                                <div key={group.key} className="menu-item items-start">
                                                    <div className="menu-label-group flex-1">
                                                        <span className="menu-label">{group.label}</span>
                                                        {editingWaterlineKey === group.key ? (
                                                            <div className="flex items-center gap-2 mt-1">
                                                                <input
                                                                    type="datetime-local"
                                                                    className="mem-waterline-input"
                                                                    value={waterlineDraft}
                                                                    onChange={e => setWaterlineDraft(e.target.value)}
                                                                />
                                                                <button
                                                                    type="button"
                                                                    className="mem-waterline-btn"
                                                                    onClick={() => handleSaveWaterline(group.key)}
                                                                >保存</button>
                                                                <button
                                                                    type="button"
                                                                    className="mem-waterline-btn mem-waterline-btn-muted"
                                                                    onClick={() => { setEditingWaterlineKey(null); setWaterlineDraft(""); }}
                                                                >取消</button>
                                                            </div>
                                                        ) : (
                                                            <button
                                                                type="button"
                                                                className="menu-desc text-left mt-0.5"
                                                                onClick={() => {
                                                                    setEditingWaterlineKey(group.key);
                                                                    setWaterlineDraft(formatWaterlineForInput(group.lastTimestamp));
                                                                }}
                                                            >
                                                                {group.lastTimestamp
                                                                    ? `已总结至 ${formatWaterlineDisplay(group.lastTimestamp)} · 待总结 ${group.pendingCount} 条（点击调整）`
                                                                    : `尚未总结 · 共 ${group.pendingCount} 条（点击调整）`}
                                                            </button>
                                                        )}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    <div className="px-4 py-3">
                                        <button
                                            type="button"
                                            className="w-full rounded-xl py-2.5 text-sm font-medium"
                                            style={{
                                                background: BINDING_ACCENTS.memory,
                                                color: "#fff",
                                                opacity: totalPending === 0 ? 0.5 : 1,
                                            }}
                                            disabled={totalPending === 0}
                                            onClick={() => void handleManualSummarize()}
                                        >
                                            {totalPending === 0 ? "没有待总结的新事件" : `开始总结（待总结 ${totalPending} 条）`}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    );
                })() : null}

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

                {charPickerOpen ? (
                    <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={() => setCharPickerOpen(false)}>
                        <div className="modal-sheet" data-ui="modal-sheet" onClick={event => event.stopPropagation()}>
                            <div className="modal-header" data-ui="modal-header">
                                <span style={{ width: 28 }} />
                                <h3 className="modal-title">选择角色</h3>
                                <button className="modal-header-btn modal-header-btn-muted" onClick={() => setCharPickerOpen(false)}><X size={18} /></button>
                            </div>
                            <div className="modal-body modal-body-tight" data-ui="modal-body">
                                {characters.length === 0 ? (
                                    <p className="ts-13 text-secondary text-center py-4">暂无角色</p>
                                ) : (
                                    <div className="menu-group">
                                        {characters.map(info => (
                                            <button
                                                key={info.character.id}
                                                type="button"
                                                className="menu-item w-full text-left"
                                                onClick={() => {
                                                    onPickChar?.(info.character.id);
                                                    setCharPickerOpen(false);
                                                    showNotice(`已选择「${info.character.name}」`);
                                                }}
                                            >
                                                <div className="menu-label-group">
                                                    <span className="menu-label">{info.character.name}</span>
                                                    {selectedCharId === info.character.id ? (
                                                        <span className="menu-desc">当前角色</span>
                                                    ) : null}
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                ) : null}

                {/* Token budget——行内收起细轨，点击展开滑杆，防翻页误触 */}
                <p className="menu-group-desc mx-2">控制截断量</p>
                <div className="menu-group">
                    <MemorySettingsSliderItem
                        icon={Users}
                        color={BINDING_ACCENTS.voice}
                        label="短期记忆+最近上下文"
                        desc="聊天历史、朋友圈、群聊与跨应用近期事件截断量"
                        value={config.shortTermTokenBudget}
                        min={MEMORY_TOKEN_BUDGET_MIN.shortTermTokenBudget}
                        max={MEMORY_TOKEN_BUDGET_MAX}
                        step={MEMORY_TOKEN_BUDGET_STEP.shortTermTokenBudget}
                        onChange={nextValue => saveBudget("shortTermTokenBudget", nextValue)}
                    />
                    <MemorySettingsSliderItem
                        icon={Archive}
                        color={BINDING_ACCENTS.memory}
                        label="长期记忆"
                        desc="总结记忆注入量"
                        value={config.longTermTokenBudget}
                        min={MEMORY_TOKEN_BUDGET_MIN.longTermTokenBudget}
                        max={MEMORY_TOKEN_BUDGET_MAX}
                        step={MEMORY_TOKEN_BUDGET_STEP.longTermTokenBudget}
                        onChange={nextValue => saveBudget("longTermTokenBudget", nextValue)}
                    />
                </div>

                {/* Summarization Prompt Editor——默认只读锁定，点「编辑」才可改，防误触改坏 */}
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
                        <div className="menu-right">
                            <button
                                onClick={() => {
                                    if (promptEditing) {
                                        // 退出编辑＝放弃未保存的改动，回到当前生效值
                                        setEditingPrompt(null);
                                    }
                                    setPromptEditing(prev => !prev);
                                }}
                                className="ui-btn ui-btn-outline py-1 px-3 ts-12"
                            >
                                {promptEditing ? "完成编辑" : "编辑"}
                            </button>
                        </div>
                    </div>
                    <div className="px-4 pb-4 flex flex-col gap-3">
                        <textarea
                            value={currentPrompt}
                            onChange={e => promptEditing && setEditingPrompt(e.target.value)}
                            readOnly={!promptEditing}
                            className={`ui-textarea w-full min-h-[260px] ts-14 leading-relaxed resize-y${promptEditing ? "" : " memory-prompt-locked"}`}
                        />
                        {promptEditing && (
                            <div className="flex gap-2">
                                {!isDefault && (
                                    <button onClick={handleResetPrompt} className="ui-btn ui-btn-outline p-2.5 flex-1">
                                        恢复默认
                                    </button>
                                )}
                                {isModified && (
                                    <button onClick={handleSavePrompt} className="ui-btn ui-btn-primary p-2.5 flex-1">
                                        <Zap size={14} className="mr-1.5" /> 保存提词配置
                                    </button>
                                )}
                            </div>
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
