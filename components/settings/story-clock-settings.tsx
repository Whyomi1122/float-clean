"use client";

// 剧情时间设置（2026-11-12，用户拍板「全局都是剧情时间」）
// 群像剧情停在 07-19 晚，普通聊天/归档/界面时间都要跟着这条线走。
// 做法：只存一个偏移量，剧情时间 = 现实时间 + 偏移；没设置过 = 与以前完全一致。

import { useCallback, useEffect, useMemo, useState } from "react";
import { Clock, RotateCcw, Sparkles } from "lucide-react";
import { Toggle } from "@/components/ui/form";
import { findLatestEnsembleAnchor } from "@/lib/archive-context-pack";
import {
    clearStoryClock,
    getStoryNow,
    getStoryOffset,
    parseAnchorStoryTime,
    setStoryNow,
    subscribeStoryClock,
} from "@/lib/story-clock";

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

type AnchorHit = { characterName: string; anchor: string; updatedAt: string };

type StoryClockSettingsProps = {
    /** 原「真实时间感知」开关（2026-11-13 并进本页，主页不再单列一张卡） */
    timeAware?: boolean;
    onTimeAwareChange?: (next: boolean) => void;
};

export function StoryClockSettings({ timeAware, onTimeAwareChange }: StoryClockSettingsProps) {
    const [offsetMs, setOffsetMs] = useState(0);
    const [tick, setTick] = useState(0);
    const [anchor, setAnchor] = useState<AnchorHit | null>(null);
    const [anchorLoading, setAnchorLoading] = useState(true);
    const [manualValue, setManualValue] = useState("");

    const sync = useCallback(() => {
        setOffsetMs(getStoryOffset());
        setTick(t => t + 1);
    }, []);

    useEffect(() => {
        sync();
        const unsubscribe = subscribeStoryClock(sync);
        const timer = window.setInterval(() => setTick(t => t + 1), 30000);
        return () => {
            unsubscribe();
            window.clearInterval(timer);
        };
    }, [sync]);

    useEffect(() => {
        let alive = true;
        findLatestEnsembleAnchor()
            .then(found => {
                if (!alive) return;
                setAnchor(found);
                setAnchorLoading(false);
            })
            .catch(() => {
                if (alive) setAnchorLoading(false);
            });
        return () => {
            alive = false;
        };
    }, []);

    // tick/offsetMs 变化时重算「现在」
    const storyNow = useMemo(() => {
        void tick;
        void offsetMs;
        return getStoryNow();
    }, [tick, offsetMs]);
    const realNow = useMemo(() => {
        void tick;
        return new Date();
    }, [tick]);

    useEffect(() => {
        if (!manualValue) setManualValue(toInputValue(getStoryNow()));
    }, [manualValue]);

    const anchorTime = useMemo(() => {
        if (!anchor) return null;
        return parseAnchorStoryTime(anchor.anchor, getStoryNow());
    }, [anchor, offsetMs]);

    const applyTime = useCallback((target: Date) => {
        setStoryNow(target);
        setManualValue(toInputValue(target));
        sync();
    }, [sync]);

    const handleApplyManual = useCallback(() => {
        if (!manualValue) return;
        const parsed = new Date(manualValue);
        if (Number.isNaN(parsed.getTime())) return;
        applyTime(parsed);
    }, [applyTime, manualValue]);

    const handleClear = useCallback(() => {
        clearStoryClock();
        setManualValue(toInputValue(new Date()));
        sync();
    }, [sync]);

    return (
        <div className="flex flex-col gap-6">
            <div className="flex items-center gap-2">
                <Clock size={20} strokeWidth={1.8} className="mx-2 text-black/60" />
                <h2 className="m-0 ts-24 font-bold italic leading-none text-black">Story Clock</h2>
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

            <div className="flex flex-col gap-3">
                <h3 className="mx-2 text-[13px] font-bold text-black/50">对齐群像当前锚点</h3>
                <div className="ui-config-card" style={{ gap: 10 }}>
                    {anchorLoading ? (
                        <span className="text-[13px] text-black/45">读取群像归档…</span>
                    ) : anchor ? (
                        <>
                            <div className="flex items-center gap-1.5 text-[13px] font-semibold text-black">
                                <Sparkles size={14} strokeWidth={1.8} className="text-black/45" />
                                <span>{anchor.characterName} 的最新群像归档</span>
                            </div>
                            <div className="max-h-[92px] overflow-auto whitespace-pre-wrap rounded-[12px] bg-black/[0.03] p-2 text-[12px] leading-relaxed text-black/55">
                                {anchor.anchor}
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
                        <span className="text-[13px] text-black/45">
                            还没找到带「当前锚点」的群像归档。先把群像跑完一轮并归档，或者用下面的手动校准。
                        </span>
                    )}
                </div>
            </div>

            <div className="flex flex-col gap-3">
                <h3 className="mx-2 text-[13px] font-bold text-black/50">手动校准</h3>
                <div className="ui-config-card" style={{ gap: 10 }}>
                    <span className="text-[12px] leading-relaxed text-black/45">
                        告诉 App「剧情里现在是几点」，之后所有时间都从这里继续走。
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
