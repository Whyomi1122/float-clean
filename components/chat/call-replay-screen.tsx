"use client";

// 通话回放页：通话界面的只读副本
// 口径：背景 / 顶栏 / 头像 / 名字 / 台词气泡全部与通话页一致，
// 只把「实时对话」换成「逐条点播」：角色台词右侧 ▶，点一次听一次。
// 不改消息内容、不调 LLM、不走 STT。

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, ChatSession } from "@/lib/chat-storage";
import { updateChatMessage } from "@/lib/chat-storage";
import { prepareChatVoiceAudio } from "@/lib/chat-asset-storage";
import { playAudioBlob, resolveVoiceConfig, synthesizeSpeech, unlockAudioPlayback } from "@/lib/tts-service";
import { speechTextForContent } from "@/lib/call-text";
import { SubtitleText } from "./subtitle-text";
import type { Character } from "@/lib/character-types";

type CallReplayScreenProps = {
    session: ChatSession;
    character: Character;
    messages: ChatMessage[];
    duration: string;
    onClose: () => void;
};

// TTS 取文：剥译本、剥旁白，取不到就回退正文（保证有内容就一定有声音）
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
        unlockAudioPlayback();
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
                const prepared = await prepareChatVoiceAudio(synthesized, text);
                updateChatMessage(msg.id, {
                    mediaType: prepared.mediaType,
                    mediaUrl: prepared.mediaUrl,
                    mediaData: { ...(msg.mediaData || {}), ...prepared.mediaData },
                });
            }
            if (!blob) {
                setError("这句没有可播放的内容");
                setBusyId(null);
                return;
            }
            const { promise, abort } = playAudioBlob(blob);
            abortRef.current = abort;
            setBusyId(null);
            setPlayingId(msg.id);
            try { await promise; } catch { /* 用户停止或播放中断 */ }
            setPlayingId((cur) => (cur === msg.id ? null : cur));
        } catch (e) {
            setError(`播放失败：${e instanceof Error ? e.message : String(e)}`);
            setBusyId(null);
            setPlayingId(null);
        }
    }, [playingId, session.contactId, stop]);

    const visible = messages.filter((m) => m.role !== "system");

    return (
        <div className="absolute inset-0 z-[300] flex flex-col overflow-hidden text-white call-bg-default">
            <div className="call-overlay absolute inset-0 z-0" />
            <button type="button" className="call-back-btn" onClick={() => { stop(); onClose(); }} aria-label="返回">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
            </button>

            <div className="voicecall-controls gcall-body">
                <div className="gcall-topbar">
                    <div className="gcall-topbar-title">{character.name}</div>
                    <div className="gcall-topbar-sub">{duration || "通话记录"} · 通话回放</div>
                </div>

                <div className="flex-none flex justify-center items-center pt-[30px] pb-5 voicecall-avatar-stage">
                    <div className="relative flex items-center justify-center">
                        <div className="voicecall-avatar">
                            {character.avatar
                                ? <img src={character.avatar} alt={character.name} className="w-full h-full object-cover" />
                                : <span className="ts-48">{character.name?.[0] || "?"}</span>}
                        </div>
                    </div>
                </div>

                <div className="text-center ts-18 font-semibold mb-2">{character.name}</div>

                <div className="voicecall-subtitle-mask flex-1 min-h-0 overflow-auto px-5 py-[10px] flex flex-col gap-2 relative">
                    {visible.length === 0 && <div className="call-replay-empty">这通电话没有留下对话</div>}
                    {visible.map((msg) => {
                        const isUser = msg.role === "user";
                        const playable = msg.role === "assistant";
                        const isPlaying = playingId === msg.id;
                        const isBusy = busyId === msg.id;
                        return (
                            <div key={msg.id} className="call-subtitle" data-role={isUser ? "user" : "assistant"}>
                                <span className="call-subtitle-body"><SubtitleText text={msg.content} /></span>
                                {playable && (
                                    <button
                                        type="button"
                                        className="call-subtitle-play"
                                        disabled={!!busyId && !isBusy}
                                        onClick={() => play(msg)}
                                        aria-label={isPlaying ? "停止" : "播放这句"}
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

                <div className="call-replay-footer">只读回放 · 点台词右侧 ▶ 重听</div>
            </div>
        </div>
    );
}
