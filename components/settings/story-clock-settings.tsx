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
    isStoryClockFrozen,
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
    const frozen = useMemo(() => {
        void tick;
        return isStoryClockFrozen(currentScope);
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
                <h2 className="m-0 mx-2 ts-28 font-bold italic leading-none text-black">Story Clock</h2>
            </div>

            {/* 时间线选择：默认 + 每个剧本各一条 */}
            <div className="prefs-block">
                <span className="prefs-block-label">Timeline</span>
                <div className="flex flex-wrap gap-2 py-3">
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
                                    borderColor: active ? "var(--c-primary)" : "rgba(0,0,0,0.12)",
                                    background: active ? "var(--c-primary-soft)" : "transparent",
                                    color: active ? "var(--c-primary-ink)" : "rgba(0,0,0,0.55)",
                                }}
                            >
                                {option.label}
                                <span className="ml-1.5 opacity-50">{isStoryClockFrozen(option.scope ?? null) ? "已冻结" : offset ? "跟随现实" : "现实"}</span>
                            </button>
                        );
                    })}
                </div>
                <div className="pb-3">
                    <p className="m-0 ts-11 leading-relaxed text-[var(--c-text)] opacity-70">
                        同一剧本的角色共用一条时间线；不属于任何剧本的角色、以及群聊，走「通用（现实）时间线」。
                    </p>
                    {timelines.length <= 1 && (
                        <p className="m-0 mt-1 ts-11 leading-relaxed text-amber-600/80">
                            还没读到剧本分组：群像里走完一段并归档（杀青）之后，这里会按剧本列出各自的线。
                        </p>
                    )}
                </div>
            </div>

            <div className="prefs-block">
                <span className="prefs-block-label">Story Time</span>
                <div className="prefs-row">
                    <span className="flex-1 text-left ts-14 font-semibold text-[var(--c-text-title)]">主线剧情时间</span>
                    <span className="ts-14 font-bold text-[var(--c-text-title)] tabular-nums">{formatDateTime(storyNow)}</span>
                </div>
                <div className="prefs-row">
                    <span className="flex-1 text-left ts-14 font-semibold text-[var(--c-text-title)]">现实时间</span>
                    <span className="ts-13 text-[var(--c-text)] opacity-70 tabular-nums">{formatDateTime(realNow)}</span>
                </div>
                <div className="prefs-row">
                    <span className="flex-1 text-left ts-14 font-semibold text-[var(--c-text-title)]">状态</span>
                    <span className="ts-13 font-semibold text-[var(--c-text-title)]">
                        {frozen ? "已冻结 · 推进剧情才走" : "跟随现实时间"}
                    </span>
                </div>
                <div className="prefs-row">
                    <span className="flex-1 text-left ts-14 font-semibold text-[var(--c-text-title)]">老消息日期换算</span>
                    <span className="ts-13 text-[var(--c-text)] opacity-70">{describeOffset(offsetMs)}</span>
                </div>
                <div className="pb-3">
                    <p className="m-0 ts-11 leading-relaxed text-[var(--c-text)] opacity-70">
                        主线剧情时间是主线剧本里的钟：不玩就停住，玩到哪儿算哪儿；现实时间只在上面的「现实时间」那行给你看。老消息的日期不会变。番外（if 线/支线）有自己的时间线，在各番外剧本的「剧本设置 → 番外专属」里单独拨，这里不管、也不会被它们影响。
                    </p>
                </div>
            </div>

            {/* 锚点卡片只对剧本时间线有意义：通用（现实）线没有群像锚点，整块隐藏（2026-11-14） */}
            {currentScope !== null && (
                <div className="prefs-block">
                    <span className="prefs-block-label">Align To Anchor</span>
                    <div className="flex flex-col gap-3 py-2">
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

            <div className="prefs-block">
                <span className="prefs-block-label">Manual Calibration</span>
                <div className="flex flex-col gap-3 py-2">
                    <span className="ts-11 leading-relaxed text-[var(--c-text)] opacity-70">
                        告诉 App「这条时间线里现在是几点」。设好之后钟就停在这一刻，只有剧情推进才会往前走。（{activeOption?.label || "通用（现实）时间线"}）
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
                <div className="prefs-block">
                    <span className="prefs-block-label">History Timestamps</span>
                    <div className="prefs-row">
                        <div className="flex flex-col flex-1 min-w-0 text-left gap-0.5">
                            <span className="ts-14 font-semibold text-[var(--c-text-title)]">在历史事件流里标注时间</span>
                            <span className="ts-11 leading-relaxed text-[var(--c-text)] opacity-70">
                                关掉后喂给 AI 的历史消息不带「几点几分」，TA 就不那么在意时间。原「真实时间感知」开关。
                            </span>
                        </div>
                        <Toggle checked={timeAware} onChange={() => onTimeAwareChange(!timeAware)} className="settings-toggle-control" />
                    </div>
                </div>
            )}
        </div>
    );
}
