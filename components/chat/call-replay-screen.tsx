"use client";

// 通话回放页：同一通话页的只读态
// 口径（2026-11-03 定稿，见《语音通话 · 参考视频口径.md》三之三）：
// - 顶栏：‹ 返回 + 中央通话总时长 + 右侧角色头像；无底部操作栏
// - 每条角色台词右侧 ▶ 逐条点播；用户台词只有文字（STT 不存录音）
// - 无进度条 / 暂停 / 倍速 / 连续播放；回放不响环境音
// - 优先用消息里已缓存的原音；没有则按需合成并回写（扬声器关闭期间的通话没有预合成）
// - 只读：不调 LLM、不走 STT、不改消息内容

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, ChatSession } from "@/lib/chat-storage";
import { updateChatMessage } from "@/lib/chat-storage";
import { prepareChatVoiceAudio } from "@/lib/chat-asset-storage";
import { resolveVoiceConfig, synthesizeSpeech, playAudioBlobViaMediaElement } from "@/lib/tts-service";
import { splitBilingualText } from "@/lib/bilingual-text";
import { speechTextForContent } from "@/lib/call-text";
import type { Character } from "@/lib/character-types";

type CallReplayScreenProps = {
    session: ChatSession;
    character: Character;
    messages: ChatMessage[];
    duration: string;
    onClose: () => void;
};

// 只保留台词部分用于 TTS：剥掉译本行与旁白行（旁白不配音是硬口径）
// 与通话页共用 lib/call-text.ts，保证「有内容就一定有声音」
function pickSpokenText(content: string): string {
    return speechTextForContent(content);
}

export default function CallReplayScreen({ session, character, messages, duration, onClose }: CallReplayScreenProps) {
    const [playingId, setPlayingId] = useState<string | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<(() => void) | null>(null);

    useEffect(() => () => { abortRef.current?.(); }, []);

    const stop = useCallback(() => {
        abortRef.current?.();
        abortRef.current = null;
        setPlayingId(null);
    }, []);

    const play = useCallback(async (msg: ChatMessage) => {
        if (playingId === msg.id) { stop(); return; }
        abortRef.current?.();
        setError(null);
        setBusyId(msg.id);
        try {
            let blob: Blob | null = null;
            const text = msg.mediaData?.synthesizedFromText || pickSpokenText(msg.content);
            if (msg.mediaUrl && msg.mediaType === "audio") {
                try {
                    const res = await fetch(msg.mediaUrl);
                    blob = await res.blob();
                } catch { blob = null; }
            }
            if (!blob && text) {
                const voiceConfig = resolveVoiceConfig(session.contactId);
                if (!voiceConfig) {
                    setError("未配置语音合成（TTS）");
                    setBusyId(null);
                    return;
                }
                const synthesized = await synthesizeSpeech(text, voiceConfig);
                if (!synthesized) {
                    setError("语音生成失败（TTS 配置或额度问题）");
                    setBusyId(null);
                    return;
                }
                blob = synthesized;
                // 回写缓存，之后点播零合成
                const prepared = await prepareChatVoiceAudio(synthesized, text);
                updateChatMessage(msg.id, {                    mediaType: prepared.mediaType,
                    mediaUrl: prepared.mediaUrl,
                    mediaData: { ...(msg.mediaData || {}), ...prepared.mediaData },
                });
            }
            if (!blob) {
                setError("这句没有可播放的内容");
                setBusyId(null);
                return;
            }
            const { promise, abort } = playAudioBlobViaMediaElement(blob);
            abortRef.current = abort;
            setBusyId(null);
            setPlayingId(msg.id);
            try { await promise; } catch { /* 用户停止或播放中断 */ }
            setPlayingId((cur) => (cur === msg.id ? null : cur));
        } catch {
            setError("播放失败，请重试");
            setBusyId(null);
            setPlayingId(null);
        }
    }, [playingId, session.contactId, session.id, stop]);

    const visible = messages.filter((m) => m.role !== "system");

    return (
        <div className="call-replay-screen">
            <div className="call-replay-topbar">
                <button type="button" className="call-replay-back" onClick={() => { stop(); onClose(); }} aria-label="返回">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
                </button>
                <div className="call-replay-title">
                    <div className="call-replay-duration">{duration || "通话记录"}</div>
                    <div className="call-replay-sub">通话回放</div>
                </div>
                {character.avatar
                    ? <img className="call-replay-avatar" src={character.avatar} alt="" />
                    : <span className="call-replay-avatar call-replay-avatar-fallback">{character.name.slice(0, 1)}</span>}
            </div>

            <div className="call-replay-body">
                {visible.length === 0 && <div className="call-replay-empty">这通电话没有留下对话</div>}
                {visible.map((msg) => {
                    const isUser = msg.role === "user";
                    const isAssistant = msg.role === "assistant";
                    const playable = isAssistant;
                    const isPlaying = playingId === msg.id;
                    const isBusy = busyId === msg.id;
                    return (
                        <div key={msg.id} className={`call-replay-row ${isUser ? "call-replay-row-user" : "call-replay-row-assistant"}`}>
                            <div className={`call-replay-bubble ${isUser ? "call-replay-bubble-user" : "call-replay-bubble-assistant"}`}>
                                <MessagePlain content={msg.content} />
                            </div>
                            {playable && (
                                <button
                                    type="button"
                                    className={`call-replay-play ${isPlaying ? "call-replay-play-active" : ""}`}
                                    disabled={!!busyId && !isBusy}
                                    onClick={() => play(msg)}
                                    aria-label={isPlaying ? "停止" : "播放"}
                                >
                                    {isBusy
                                        ? <span className="call-replay-spinner" />
                                        : isPlaying
                                            ? <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.2" /><rect x="14" y="5" width="4" height="14" rx="1.2" /></svg>
                                            : <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z" /></svg>}
                                </button>
                            )}
                        </div>
                    );
                })}
                {error && <div className="call-replay-error">{error}</div>}
            </div>
        </div>
    );
}

// 朗读用纯台词的占位工具：旁白任务接入后用于统一取文；当前未引用
function spokenStorageText(_msg: ChatMessage, spoken: string) {
    return spoken;
}
void spokenStorageText;

// 简单渲染：只保留台词；旁白行样式在旁白任务上线后再接入
function MessagePlain({ content }: { content: string }) {
    const split = splitBilingualText(content);
    return <span className="call-replay-text">{split ? split.original : content}</span>;
}
