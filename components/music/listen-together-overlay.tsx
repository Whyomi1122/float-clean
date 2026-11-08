"use client";

// 一起听全屏浮层 —— 从悬浮球音乐 Tab 进入
// 上半:播放器(复用 music-context 播放状态);下半:与角色的听歌聊天流
// AI 回应走 listen-together-engine(绑定槽 listen,注入 now_playing)

import { useCallback, useEffect, useRef, useState } from "react";
import { useMusicControlsOptional, useMusicPlayerOptional } from "@/lib/music-context";
import { generateListenReply, type ListenReplyAction } from "@/lib/listen-together-engine";
import { unifiedSearch } from "@/lib/music-service";
import { neteaseResultToTrack } from "@/lib/tool-executor";
import {
    loadListenMessages,
    appendListenMessage,
    clearListenMessages,
    genListenMsgId,
    loadListenQueueMarks,
    markListenQueueTrack,
    type ListenMessage,
    type ListenQueueMark,
} from "@/lib/listen-together-storage";
import type { Character } from "@/lib/character-types";
import type { MusicTrack } from "@/lib/music-storage";
import "./../../styles/listen-together.css";

type Props = {
    character: Character;
    userName: string;
    userAvatar?: string;
    onClose: () => void;
};

export default function ListenTogetherOverlay({ character, userName, userAvatar, onClose }: Props) {
    const controls = useMusicControlsOptional();
    const player = useMusicPlayerOptional();
    const track = controls?.currentTrack ?? null;
    const isPlaying = controls?.isPlaying ?? false;
    const currentTime = player?.currentTime ?? 0;

    const [messages, setMessages] = useState<ListenMessage[]>([]);
    const [input, setInput] = useState("");
    const [thinking, setThinking] = useState(false);
    const [marks, setMarks] = useState<ListenQueueMark[]>([]);
    const listRef = useRef<HTMLDivElement>(null);
    /** 防止切歌自动触发重复请求 */
    const lastAutoTrackId = useRef<string | null>(null);

    // 载入历史
    useEffect(() => {
        setMessages(loadListenMessages(character.id));
    }, [character.id]);

    // 队列归属:每次换歌重新读一遍,这样 TA 刚排进来的歌能立刻显示「TA 放的」
    useEffect(() => {
        setMarks(loadListenQueueMarks(character.id));
    }, [character.id, track?.id]);

    const ownerOf = (trackId?: string) => marks.find(item => item.trackId === trackId);

    /** 用户在浮层里点歌 = 你放的 */
    const playAsUser = (item: MusicTrack) => {
        markListenQueueTrack(character.id, { trackId: item.id, by: "user", addedAt: new Date().toISOString() });
        setMarks(loadListenQueueMarks(character.id));
        controls?.playTrack(item);
    };

    const queue = controls?.queue ?? [];
    const currentIndex = track ? queue.findIndex(item => item.id === track.id) : -1;
    const upNext = (currentIndex >= 0 ? queue.slice(currentIndex + 1) : queue).slice(0, 5);
    const currentOwner = ownerOf(track?.id);

    // 自动滚动到底
    useEffect(() => {
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
    }, [messages, thinking]);

    const pushCharMessage = useCallback((text: string) => {
        const msg: ListenMessage = { id: genListenMsgId(), role: "char", text, createdAt: new Date().toISOString() };
        appendListenMessage(character.id, msg);
        setMessages(prev => [...prev, msg]);
    }, [character.id]);

    /** 角色通过标签点的动作：真的去执行，并记成「TA 放的」 */
    const runCharAction = useCallback(async (action: ListenReplyAction, note: string) => {
        if (!controls) return;
        try {
            if (action.kind === "next") {
                controls.next();
                return;
            }
            const results = await unifiedSearch(action.query);
            const first = results.find(result => (result.source === "local" ? result.localTrack : result.neteaseResult));
            if (!first) return;
            const target: MusicTrack | null = first.source === "local" && first.localTrack
                ? first.localTrack
                : first.neteaseResult
                    ? neteaseResultToTrack(first.neteaseResult)
                    : null;
            if (!target) return;
            if (action.kind === "play") {
                controls.playTrack(target);
            } else {
                const cur = controls.queue ?? [];
                if (!cur.some(item => item.id === target.id)) controls.setQueue([...cur, target]);
            }
            markListenQueueTrack(character.id, {
                trackId: target.id,
                by: "character",
                note: note.slice(0, 40),
                addedAt: new Date().toISOString(),
            });
            setMarks(loadListenQueueMarks(character.id));
        } catch (err) {
            console.warn("[ListenTogether] 角色动作执行失败:", err);
        }
    }, [character.id, controls]);

    /** 触发一次 AI 回应(自动场景时 userText 为空) */
    const requestReply = useCallback(async (userText: string, contextHint?: string) => {
        if (thinking) return;
        setThinking(true);
        try {
            const history = loadListenMessages(character.id);
            const reply = await generateListenReply(character, userName, history, userText, contextHint);
            if (reply.text) pushCharMessage(reply.text);
            for (const action of reply.actions) {
                void runCharAction(action, reply.text || userText || "给你放一首");
            }
        } catch (err) {
            pushCharMessage(err instanceof Error ? `(!) ${err.message}` : "(!) 网络好像不太好,再试一次?");
        } finally {
            setThinking(false);
        }
    }, [character, userName, thinking, pushCharMessage, runCharAction]);

    // 切歌自动触发:60% 概率让角色说一句
    useEffect(() => {
        if (!track || !isPlaying) return;
        if (lastAutoTrackId.current === track.id) return;
        const prevId = lastAutoTrackId.current;
        lastAutoTrackId.current = track.id;
        if (!prevId) return; // 首次进入不触发
        if (Math.random() > 0.6) return;
        void requestReply("", `刚切到一首新歌:《${track.title}》- ${track.artist}`);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [track?.id, isPlaying]);

    const handleSend = () => {
        const text = input.trim();
        if (!text || thinking) return;
        setInput("");
        const msg: ListenMessage = { id: genListenMsgId(), role: "user", text, createdAt: new Date().toISOString() };
        appendListenMessage(character.id, msg);
        setMessages(prev => [...prev, msg]);
        void requestReply(text);
    };

    // 点角色头像 = 喊 TA 说话
    const handlePoke = () => {
        if (thinking) return;
        void requestReply("", `${userName}碰了碰你的肩膀,想听你说说这首歌`);
    };

    const fmt = (s: number) => {
        if (!Number.isFinite(s) || s < 0) s = 0;
        const m = Math.floor(s / 60), sec = Math.floor(s % 60);
        return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    };

    return (
        <div className="lt-overlay">
            {/* 顶栏 */}
            <div className="lt-header">
                <button className="lt-back" onClick={onClose}>‹</button>
                <span className="lt-title">一起听</span>
                <button
                    className="lt-clear"
                    title="清空这段听歌记录"
                    onClick={() => {
                        if (confirm("清空和 TA 的这段听歌记录?")) {
                            clearListenMessages(character.id);
                            setMessages([]);
                        }
                    }}
                >⋯</button>
            </div>

            {/* 双头像 */}
            <div className="lt-avatars">
                <div className="lt-avatar-col">
                    {userAvatar ? <img className="lt-avatar" src={userAvatar} alt="" /> : <div className="lt-avatar lt-avatar-empty">{userName.slice(0, 1)}</div>}
                    <span className="lt-avatar-name">{userName}</span>
                    <span className="lt-avatar-status">{isPlaying ? "正在播放" : "已暂停"}</span>
                </div>
                <span className="lt-heart">❤</span>
                <div className="lt-avatar-col">
                    <button className="lt-avatar-btn" onClick={handlePoke} title="戳一下 TA">
                        {character.avatar ? <img className="lt-avatar" src={character.avatar} alt="" /> : <div className="lt-avatar lt-avatar-empty">{character.name.slice(0, 1)}</div>}
                    </button>
                    <span className="lt-avatar-name">{character.name}</span>
                    <span className="lt-avatar-status">{thinking ? "正在输入…" : "在线"}</span>
                </div>
            </div>

            {/* 播放卡片 */}
            <div className="lt-player">
                {track ? (
                    <>
                        <div className="lt-player-row">
                            {track.coverUrl
                                ? <img className={`lt-player-cover ${isPlaying ? "lt-spin" : ""}`} src={track.coverUrl} alt="" />
                                : <div className={`lt-player-cover lt-cover-empty ${isPlaying ? "lt-spin" : ""}`}>♪</div>}
                            <div className="lt-player-meta">
                                <div className="lt-player-title">{track.title}</div>
                                <div className="lt-player-artist">{track.artist}</div>
                                {currentOwner && (
                                    <div className={`lt-owner ${currentOwner.by === "character" ? "lt-owner-char" : "lt-owner-user"}`}>
                                        {currentOwner.by === "character" ? `${character.name} 放的` : "你放的"}
                                        {currentOwner.note ? ` · 「${currentOwner.note}」` : ""}
                                    </div>
                                )}
                            </div>
                        </div>
                        <div className="lt-progress"><div className="lt-progress-fill" style={{ width: `${track.duration > 0 ? Math.min(currentTime / track.duration, 1) * 100 : 0}%` }} /></div>
                        <div className="lt-time"><span>{fmt(currentTime)}</span><span>{fmt(track.duration)}</span></div>
                        <div className="lt-ctrls">
                            <button className="lt-ctrl" onClick={() => player?.prev()}>⏮</button>
                            <button className="lt-ctrl lt-ctrl-main" onClick={() => controls?.togglePlay()}>{isPlaying ? "⏸" : "▶"}</button>
                            <button className="lt-ctrl" onClick={() => player?.next()}>⏭</button>
                        </div>
                    </>
                ) : (
                    <div className="lt-player-idle">
                        <div>还没有播放歌曲</div>
                        <div className="lt-player-idle-sub">从音乐 App 挑一首开始吧</div>
                    </div>
                )}
            </div>

            {/* 接下来：列表真源还是 music-context 的队列，这里只补「谁放的」 */}
            {upNext.length > 0 && (
                <div className="lt-upnext">
                    <div className="lt-upnext-head">接下来 · {upNext.length} 首</div>
                    {upNext.map(item => {
                        const owner = ownerOf(item.id);
                        return (
                            <button key={item.id} className="lt-upnext-item" onClick={() => playAsUser(item)}>
                                <span className="lt-upnext-name">{item.title}</span>
                                <span className="lt-upnext-artist">{item.artist}</span>
                                {owner && (
                                    <span className={`lt-upnext-badge ${owner.by === "character" ? "is-char" : "is-user"}`}>
                                        {owner.by === "character" ? "TA" : "你"}
                                    </span>
                                )}
                            </button>
                        );
                    })}
                </div>
            )}

            {/* 聊天流 */}
            <div className="lt-chat" ref={listRef}>
                {messages.length === 0 && (
                    <div className="lt-chat-empty">这是我们第一次一起听歌<br /><span>戳一下 TA 的头像,或者直接说点什么</span></div>
                )}
                {messages.map(m => (
                    <div key={m.id} className={`lt-msg lt-msg-${m.role}`}>
                        {m.role === "char" && character.avatar && <img className="lt-msg-avatar" src={character.avatar} alt="" />}
                        <div className="lt-msg-bubble">{m.text}</div>
                    </div>
                ))}
                {thinking && (
                    <div className="lt-msg lt-msg-char">
                        {character.avatar && <img className="lt-msg-avatar" src={character.avatar} alt="" />}
                        <div className="lt-msg-bubble lt-typing"><i /><i /><i /></div>
                    </div>
                )}
            </div>

            {/* 输入框 */}
            <div className="lt-input-bar">
                <input
                    className="lt-input"
                    value={input}
                    placeholder="说点什么…"
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") handleSend(); }}
                />
                <button className="lt-send" onClick={handleSend} disabled={!input.trim() || thinking}>➤</button>
            </div>
        </div>
    );
}
