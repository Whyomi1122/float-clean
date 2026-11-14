"use client";

// 剧情时间设置（2026-11-12 起；2026-11-13 升级为「按剧本分组」）
//
// 为什么按剧本而不是按角色：同一剧本的角色共享一条时间线（实机锚点里金成帝在首尔、
// 岳霖玉在别庄，是同一天同一刻），按角色分会自相矛盾。不同剧本各玩各的才需要分开。
//
// 做法：只存偏移量，剧情时间 = 现实时间 + 偏移；没设置过 = 与以前完全一致。

import { useCallback, useEffect, useMemo, useState } from "react";
import { Clock, RotateCcw, Sparkles } from "lucide-react";
import { Toggle } from "@/components/ui/form";
import { listEnsembleAnchors, type EnsembleAnchorHit } from "@/lib/archive-context-pack";
import {
    clearStoryClock,
    getStoryNow,
    getStoryOffset,
    listStoryClockScopes,
    parseAnchorStoryTime,
    setStoryNow,
    subscribeStoryClock,
    type StoryScope,
} from "@/lib/story-clock";
import { getStoryScriptTitle, listStoryScripts, refreshStoryScopes } from "@/lib/story-scope";

function pad(value: number): string {
    return String(value).padStart(2, "0");
}

function formatDateTime(date: Date): string {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toInputValue(date: Date): string {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function describeOffset(offsetMs: number): string {
    if (!offsetMs) return "未启用，和现实时间一致";
    const abs = Math.abs(offsetMs);
    const days = Math.floor(abs / 86400000);
    const hours = Math.floor((abs % 86400000) / 3600000);
    const minutes = Math.round((abs % 3600000) / 60000);
    const parts: string[] = [];
    if (days) parts.push(`${days} 天`);
    if (hours) parts.push(`${hours} 小时`);
    if (!days && !hours && minutes) parts.push(`${minutes} 分钟`);
    return `比现实时间${offsetMs < 0 ? "早" : "晚"} ${parts.join("") || "1 分钟"}`;
}

type TimelineOption = { scope: StoryScope; label: string; anchor: EnsembleAnchorHit | null };

type StoryClockSettingsProps = {
    /** 原「真实时间感知」开关（2026-11-13 并进本页，主页不再单列一张卡） */
    timeAware?: boolean;
    onTimeAwareChange?: (next: boolean) => void;
};

export function StoryClockSettings({ timeAware, onTimeAwareChange }: StoryClockSettingsProps) {
    const [tick, setTick] = useState(0);
    const [anchors, setAnchors] = useState<EnsembleAnchorHit[]>([]);
    const [scripts, setScripts] = useState<{ scriptId: string; scriptTitle: string }[]>([]);
    const [anchorLoading, setAnchorLoading] = useState(true);
    const [selectedScope, setSelectedScope] = useState<StoryScope>(null);
    const [manualValue, setManualValue] = useState("");

    const sync = useCallback(() => setTick(value => value + 1), []);

    useEffect(() => {
        sync();
        const unsubscribe = subscribeStoryClock(sync);
        const timer = window.setInterval(() => setTick(value => value + 1), 30000);
        return () => {
            unsubscribe();
            window.clearInterval(timer);
        };
    }, [sync]);

    useEffect(() => {
        let alive = true;
        (async () => {
            // 先把「角色 → 剧本」映射同步一遍，再按剧本取锚点
            await refreshStoryScopes().catch(() => undefined);
            const found = await listEnsembleAnchors().catch(() => []);
            if (!alive) return;
            setScripts(listStoryScripts());
            setAnchors(found);
            setAnchorLoading(false);
        })();
        return () => {
            alive = false;
        };
    }, []);

    const timelines = useMemo<TimelineOption[]>(() => {
        // 2026-11-14：默认线不再排第一（看着像主选项），排到最后，名字改成「通用（现实）时间线」
        const defaultOption: TimelineOption = { scope: null, label: "通用（现实）时间线", anchor: null };
        const options: TimelineOption[] = [];
        const seen = new Set<string>();
        anchors.forEach(hit => {
            if (!hit.scriptId || seen.has(hit.scriptId)) return;
            seen.add(hit.scriptId);
            options.push({ scope: hit.scriptId, label: hit.scriptTitle, anchor: hit });
        });
        // 已经设过偏移但当前没有锚点的剧本也列出来，避免「设过却找不到了」
        // 有剧本映射但归档里没锚点（或锚点格式变了）也要列出来，否则用户根本选不到那条线
        scripts.forEach(entry => {
            if (!entry.scriptId || seen.has(entry.scriptId)) return;
            seen.add(entry.scriptId);
            options.push({ scope: entry.scriptId, label: entry.scriptTitle, anchor: null });
        });
        listStoryClockScopes().forEach(entry => {
            if (!entry.scope || seen.has(entry.scope)) return;
            seen.add(entry.scope);
            options.push({ scope: entry.scope, label: getStoryScriptTitle(entry.scope), anchor: null });
        });
        options.push(defaultOption);
        return options;
    }, [anchors, scripts, tick]);

    const activeOption = useMemo(
        () => timelines.find(option => option.scope === selectedScope) || timelines.find(option => option.scope === null) || timelines[0],
        [timelines, selectedScope]
    );
    const currentScope = activeOption?.scope ?? null;

    const storyNow = useMemo(() => {
        void tick;
        return getStoryNow(currentScope);
    }, [tick, currentScope]);
    const realNow = useMemo(() => {
        void tick;
        return new Date();
    }, [tick]);
    const offsetMs = useMemo(() => {
        void tick;
        return getStoryOffset(currentScope);
    }, [tick, currentScope]);

    useEffect(() => {
        setManualValue(toInputValue(getStoryNow(currentScope)));
    }, [currentScope]);

    const anchorTime = useMemo(() => {
        if (!activeOption?.anchor) return null;
        return parseAnchorStoryTime(activeOption.anchor.anchor, getStoryNow(currentScope));
    }, [activeOption, currentScope, tick]);

    const applyTime = useCallback((target: Date) => {
        setStoryNow(target, currentScope);
        setManualValue(toInputValue(target));
        sync();
    }, [currentScope, sync]);

    const handleApplyManual = useCallback(() => {
        if (!manualValue) return;
        const parsed = new Date(manualValue);
        if (Number.isNaN(parsed.getTime())) return;
        applyTime(parsed);
    }, [applyTime, manualValue]);

    const handleClear = useCallback(() => {
        clearStoryClock(currentScope);
        setManualValue(toInputValue(new Date()));
        sync();
    }, [currentScope, sync]);

    return (
        <div className="flex flex-col gap-6">
            <div className="flex items-center gap-2">
                <Clock size={20} strokeWidth={1.8} className="mx-2 text-black/60" />
                <h2 className="m-0 ts-24 font-bold italic leading-none text-black">Story Clock</h2>
            </div>

            {/* 时间线选择：默认 + 每个剧本各一条 */}
            <div className="flex flex-col gap-2">
                <h3 className="mx-2 text-[13px] font-bold text-black/50">选一条时间线</h3>
                <div className="flex flex-wrap gap-2 px-2">
                    {timelines.map(option => {
                        const active = (option.scope ?? null) === currentScope;
                        const offset = getStoryOffset(option.scope ?? null);
                        return (
                            <button
                                key={option.scope ?? "__default__"}
                                type="button"
                                onClick={() => setSelectedScope(option.scope ?? null)}
                                className="rounded-full border px-3 py-1.5 text-[12px] font-semibold transition"
                                style={{
                                    borderColor: active ? "var(--c-accent, #111)" : "rgba(0,0,0,0.12)",
                                    background: active ? "rgba(0,0,0,0.06)" : "transparent",
                                    color: active ? "#111" : "rgba(0,0,0,0.55)",
                                }}
                            >
                                {option.label}
                                <span className="ml-1.5 opacity-50">{offset ? "已偏移" : "现实"}</span>
                            </button>
                        );
                    })}
                </div>
                <p className="mx-2 m-0 text-[12px] leading-relaxed text-black/40">
                    同一剧本的角色共用一条时间线；不属于任何剧本的角色、以及群聊，走「通用（现实）时间线」。
                </p>
                {timelines.length <= 1 && (
                    <p className="mx-2 m-0 text-[12px] leading-relaxed text-amber-600/80">
                        还没读到剧本分组：群像里走完一段并归档（杀青）之后，这里会按剧本列出各自的线。
                    </p>
                )}
            </div>

            <div className="ui-config-card" style={{ gap: 10 }}>
                <div className="flex items-center justify-between gap-3">
                    <span className="text-[13px] font-semibold text-black/45">剧情时间</span>
                    <span className="text-[15px] font-bold text-black tabular-nums">{formatDateTime(storyNow)}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                    <span className="text-[13px] font-semibold text-black/45">现实时间</span>
                    <span className="text-[13px] font-medium text-black/60 tabular-nums">{formatDateTime(realNow)}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                    <span className="text-[13px] font-semibold text-black/45">偏移</span>
                    <span className="text-[13px] font-medium text-black/60">{describeOffset(offsetMs)}</span>
                </div>
                <p className="m-0 text-[12px] leading-relaxed text-black/40">
                    普通聊天、一起听、归档、界面上的时间都按剧情时间走。历史消息的时间戳不会改，只换算显示。
                </p>
            </div>

            {/* 锚点卡片只对剧本时间线有意义：通用（现实）线没有群像锚点，整块隐藏（2026-11-14） */}
            {currentScope !== null && (
                <div className="flex flex-col gap-3">
                    <h3 className="mx-2 text-[13px] font-bold text-black/50">对齐群像当前锚点</h3>
                    <div className="ui-config-card" style={{ gap: 10 }}>
                        {anchorLoading ? (
                            <span className="text-[13px] text-black/45">读取群像归档…</span>
                        ) : activeOption?.anchor ? (
                            <>
                                <div className="flex items-center gap-1.5 text-[13px] font-semibold text-black">
                                    <Sparkles size={14} strokeWidth={1.8} className="text-black/45" />
                                    <span>{activeOption.anchor.scriptTitle} · {activeOption.anchor.characterName} 的最新群像归档</span>
                                </div>
                                <div className="max-h-[92px] overflow-auto whitespace-pre-wrap rounded-[12px] bg-black/[0.03] p-2 text-[12px] leading-relaxed text-black/55">
                                    {activeOption.anchor.anchor}
                                </div>
                                <div className="flex items-center justify-between gap-3">
                                    <span className="text-[12px] text-black/45">
                                        {anchorTime ? `解析到：${formatDateTime(anchorTime)}` : "这段锚点里没找到日期，改用下面的手动校准"}
                                    </span>
                                    <button
                                        type="button"
                                        disabled={!anchorTime}
                                        onClick={() => anchorTime && applyTime(anchorTime)}
                                        className="ui-btn ui-btn-primary shrink-0 rounded-[20px] disabled:opacity-40"
                                    >
                                        对齐到这个时间
                                    </button>
                                </div>
                            </>
                        ) : (
                            <span className="text-[13px] leading-relaxed text-black/45">
                                这个剧本暂时没找到带「当前锚点」的群像归档，用下面的手动校准。
                            </span>
                        )}
                    </div>
                </div>
            )}

            <div className="flex flex-col gap-3">
                <h3 className="mx-2 text-[13px] font-bold text-black/50">手动校准（{activeOption?.label || "通用（现实）时间线"}）</h3>
                <div className="ui-config-card" style={{ gap: 10 }}>
                    <span className="text-[12px] leading-relaxed text-black/45">
                        告诉 App「这条时间线里现在是几点」，之后都从这里继续走。
                    </span>
                    <input
                        type="datetime-local"
                        value={manualValue}
                        onChange={event => setManualValue(event.target.value)}
                        className="h-10 w-full rounded-[12px] border border-black/10 bg-white px-3 text-[14px] text-black outline-none focus:border-black/30"
                    />
                    <div className="flex items-center gap-2">
                        <button type="button" onClick={handleApplyManual} className="ui-btn ui-btn-primary rounded-[20px]">
                            设为剧情时间
                        </button>
                        <button type="button" onClick={handleClear} className="ui-btn rounded-[20px]">
                            <RotateCcw size={14} strokeWidth={1.8} />
                            回到现实时间
                        </button>
                    </div>
                </div>
            </div>

            {typeof timeAware === "boolean" && onTimeAwareChange && (
                <div className="flex flex-col gap-3">
                    <h3 className="mx-2 text-[13px] font-bold text-black/50">历史时间标注</h3>
                    <div className="ui-config-card" style={{ gap: 10 }}>
                        <div className="flex items-center justify-between gap-3">
                            <div className="flex flex-col gap-1">
                                <span className="text-[14px] font-semibold text-black">在历史事件流里标注时间</span>
                                <span className="text-[12px] leading-relaxed text-black/45">
                                    关掉后喂给 AI 的历史消息不带「几点几分」，TA 就不那么在意时间。原「真实时间感知」开关。
                                </span>
                            </div>
                            <Toggle checked={timeAware} onChange={() => onTimeAwareChange(!timeAware)} className="settings-toggle-control" />
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
