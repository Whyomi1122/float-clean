"use client";

// components/chat/listen-together-bar.tsx
//
// 一起听 = 聊天室顶部的一条状态条（不是独立界面）。
// 2026-11-09 用户口径：
//   · 在聊天室里直接边听边聊，音乐上下文由主聊天注入（now_playing 块里带歌名/歌词）
//   · 结束时间由用户掌控，这条上的「结束」是唯一出口
//   · 切歌时 TA 有 60% 概率主动说一句（不是每次都说，说多了很烦）

import { useCallback, useEffect, useRef, useState } from "react";
import { useMusicPlayer, useMusicControlsOptional } from "@/lib/music-context";
import { requestBackgroundChatReply, isBackgroundReplyGenerating } from "@/lib/follow-up-service";
import { appendListenMarker } from "@/lib/listen-together-markers";
import { endListenSession } from "@/lib/listen-together-session";
import "@/styles/listen-bar.css";

type Props = {
    characterId: string;
    characterName?: string;
    sessionId: string;
};

const AUTO_TALK_CHANCE = 0.6;
const AUTO_TALK_COOLDOWN_MS = 90_000;

function fmt(sec: number) {
    if (!Number.isFinite(sec) || sec < 0) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
}

const ICON_PROPS = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
};

export default function ListenTogetherBar({ characterId, characterName, sessionId }: Props) {
    const music = useMusicPlayer();
    const controls = useMusicControlsOptional();
    const track = music?.currentTrack ?? null;
    const isPlaying = Boolean(music?.isPlaying);
    const currentTime = music?.currentTime ?? 0;
    const duration = music?.duration ?? 0;
    const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;

    const [ending, setEnding] = useState(false);
    const lastTrackRef = useRef<string | null>(null);
    const lastTalkAtRef = useRef(0);

    // 切歌 → 60% 概率让 TA 主动说一句（首帧不触发；90s 内不重复）
    useEffect(() => {
        const id = track?.id ?? null;
        if (!id) return;
        const prev = lastTrackRef.current;
        lastTrackRef.current = id;
        if (!prev || prev === id) return;
        if (Date.now() - lastTalkAtRef.current < AUTO_TALK_COOLDOWN_MS) return;
        if (Math.random() > AUTO_TALK_CHANCE) return;
        if (isBackgroundReplyGenerating(sessionId)) return;
        lastTalkAtRef.current = Date.now();
        void requestBackgroundChatReply(sessionId).catch(() => { /* 静默失败 */ });
    }, [track?.id, sessionId]);

    const handleEnd = useCallback(() => {
        if (ending) return;
        setEnding(true);
        try {
            endListenSession();
            appendListenMarker(characterId, "end");
        } catch { /* ignore */ }
    }, [characterId, ending]);

    return (
        <div className="ltb-bar">
            <div className="ltb-main">
                {track?.coverUrl
                    ? <img className={`ltb-cover ${isPlaying ? "ltb-breath" : ""}`} src={track.coverUrl} alt="" />
                    : <div className={`ltb-cover ltb-cover-empty ${isPlaying ? "ltb-breath" : ""}`}>♪</div>}
                <div className="ltb-meta">
                    <div className="ltb-line1">
                        <span className="ltb-tag">一起听</span>
                        <span className="ltb-title">{track ? track.title : "还没有播放歌曲"}</span>
                    </div>
                    <div className="ltb-line2">
                        {track
                            ? <>
                                <span className="ltb-artist">{track.artist}</span>
                                <span className="ltb-dot">·</span>
                                <span className="ltb-time">{fmt(currentTime)} / {fmt(duration)}</span>
                            </>
                            : <span className="ltb-artist">和 {characterName || "TA"} 去音乐 App 挑一首</span>}
                    </div>
                </div>
                <div className="ltb-ctrls">
                    <button className="ltb-ctrl" onClick={() => controls?.prev()} aria-label="上一首">
                        <svg {...ICON_PROPS}><polygon points="19 20 9 12 19 4" fill="currentColor" stroke="none" /><line x1="5" y1="19" x2="5" y2="5" /></svg>
                    </button>
                    <button className="ltb-ctrl ltb-ctrl-main" onClick={() => controls?.togglePlay()} aria-label={isPlaying ? "暂停" : "播放"}>
                        {isPlaying
                            ? <svg {...ICON_PROPS} fill="currentColor" stroke="none"><rect x="7" y="5" width="3.6" height="14" rx="1.4" /><rect x="13.4" y="5" width="3.6" height="14" rx="1.4" /></svg>
                            : <svg {...ICON_PROPS} fill="currentColor" stroke="none"><path d="M8 5.2v13.6a1 1 0 0 0 1.53.85l10.1-6.8a1 1 0 0 0 0-1.7L9.53 4.35A1 1 0 0 0 8 5.2Z" /></svg>}
                    </button>
                    <button className="ltb-ctrl" onClick={() => controls?.next()} aria-label="下一首">
                        <svg {...ICON_PROPS}><polygon points="5 4 15 12 5 20" fill="currentColor" stroke="none" /><line x1="19" y1="5" x2="19" y2="19" /></svg>
                    </button>
                </div>
                <button className="ltb-end" onClick={handleEnd} disabled={ending}>
                    {ending ? "已结束" : "结束"}
                </button>
            </div>
            <div className="ltb-progress">
                <div className="ltb-progress-fill" style={{ width: `${progress * 100}%` }} />
            </div>
        </div>
    );
}
