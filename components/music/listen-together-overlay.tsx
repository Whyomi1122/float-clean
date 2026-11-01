"use client";

// 一起听全屏浮层 —— 从悬浮球音乐 Tab 进入
// 上半:播放器(复用 music-context 播放状态);下半:与角色的听歌聊天流
// AI 回应走 listen-together-engine(绑定槽 listen,注入 now_playing)

import { useCallback, useEffect, useRef, useState } from "react";
import { useMusicControlsOptional } from "@/lib/music-context";
import { generateListenReply } from "@/lib/listen-together-engine";
import {
    loadListenMessages,
    appendListenMessage,
    clearListenMessages,
    genListenMsgId,
    type ListenMessage,
} from "@/lib/listen-together-storage";
import type { Character } from "@/lib/character-types";
import "./../../styles/listen-together.css";

type Props = {
    character: Character;
    userName: string;
    userAvatar?: string;
    onClose: () => void;
};

export default function ListenTogetherOverlay({ character, userName, userAvatar, onClose }: Props) {
    const controls = useMusicControlsOptional();
    const track = controls?.currentTrack ?? null;
    const isPlaying = controls?.isPlaying ?? false;

    const [messages, setMessages] = useState<ListenMessage[]>([]);
    const [input, setInput] = useState("");
    const [thinking, setThinking] = useState(false);
    const listRef = useRef<HTMLDivElement>(null);
    /** 防止切歌自动触发重复请求 */
    const lastAutoTrackId = useRef<string | null>(null);

    // 载入历史
    useEffect(() => {
        setMessages(loadListenMessages(character.id));
    }, [character.id]);

    // 自动滚动到底
    useEffect(() => {
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
    }, [messages, thinking]);

    const pushCharMessage = useCallback((text: string) => {
        const msg: ListenMessage = { id: genListenMsgId(), role: "char", text, createdAt: new Date().toISOString() };
        appendListenMessage(character.id, msg);
        setMessages(prev => [...prev, msg]);
    }, [character.id]);

    /** 触发一次 AI 回应(自动场景时 userText 为空) */
    const requestReply = useCallback(async (userText: string, contextHint?: string) => {
        if (thinking) return;
        setThinking(true);
        try {
            const history = loadListenMessages(character.id);
            const reply = await generateListenReply(character, userName, history, userText, contextHint);
            if (reply) pushCharMessage(reply);
        } catch (err) {
            pushCharMessage(err instanceof Error ? `(!) ${err.message}` : "(!) 网络好像不太好,再试一次?");
        } finally {
            setThinking(false);
        }
    }, [character, userName, thinking, pushCharMessage]);

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
                            </div>
                        </div>
                        <div className="lt-progress"><div className="lt-progress-fill" style={{ width: `${track.duration > 0 ? Math.min((controls?.currentTime ?? 0) / track.duration, 1) * 100 : 0}%` }} /></div>
                        <div className="lt-time"><span>{fmt(controls?.currentTime ?? 0)}</span><span>{fmt(track.duration)}</span></div>
                        <div className="lt-ctrls">
                            <button className="lt-ctrl" onClick={() => controls?.playPrev()}>⏮</button>
                            <button className="lt-ctrl lt-ctrl-main" onClick={() => controls?.togglePlay()}>{isPlaying ? "⏸" : "▶"}</button>
                            <button className="lt-ctrl" onClick={() => controls?.playNext()}>⏭</button>
                        </div>
                    </>
                ) : (
                    <div className="lt-player-idle">
                        <div>还没有播放歌曲</div>
                        <div className="lt-player-idle-sub">从音乐 App 挑一首开始吧</div>
                    </div>
                )}
            </div>

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
