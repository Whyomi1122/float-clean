"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { ChatSession, ChatMessage, loadChatMessages, pushChatMessage, getLatestCharacterStateValues, updateChatMessage, deleteChatMessage } from "@/lib/chat-storage";
import { prepareChatVoiceAudio } from "@/lib/chat-asset-storage";
import { getStatusRegionConfig, isCustomStatusRegionActive } from "@/lib/chat-status-region";
import type { StateValue } from "@/lib/chat-storage";
import { parseStateValues, mergeStateValues } from "@/lib/state-value-parser";
import { parseAIResponse } from "@/lib/rich-message-parser";
import { generateChatCompletion, flattenCompletionResult, ChatEngineError } from "@/lib/chat-engine";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { cancelFollowUp } from "@/lib/follow-up-service";
import { createSTTSession, type STTSession } from "@/lib/stt-service";
import { resolveVoiceConfig, synthesizeSpeech, playAudioBlob, setCallAudioSessionActive, unlockAudioPlayback } from "@/lib/tts-service";
import { isCallRecordingSupported, resolveCloudSttConfig } from "@/lib/stt-cloud";
import { useHoldToTalk } from "./use-hold-to-talk";
import { suspendKeepAliveForCall, resumeKeepAliveAfterCall } from "@/lib/use-weixin-bridge";
import { SubtitleText } from "./subtitle-text";
import { splitNarration, speechTextForContent, splitSpeechChunks } from "@/lib/call-text";
import type { Character } from "@/lib/character-types";
import { useCallKeyboardOffsetStyle } from "./use-call-keyboard-offset";
import { CallSttWarningDialog, hideCallSttWarningPermanently, isCallSttWarningHidden } from "./call-stt-warning-dialog";
import { isAndroidBrowser, isIOSDevice } from "./voice-input-platform";
import { CallVolumeControl } from "./call-volume-control";
import { startIncomingCallVibration } from "@/lib/call-vibration";
import { CallDiagnosticPanel } from "./call-diagnostic-panel";
import { recordCallDiagnostic } from "@/lib/call-diagnostics";

// ── Types ───────────────────────────────────────────

type CallState =
    | "CONNECTING"
    | "IDLE"
    | "USER_SPEAKING"
    | "PROCESSING"
    | "AI_SPEAKING"
    | "ENDED";

type SubtitleEntry = {
    id: string;
    role: "user" | "assistant";
    /** 台词部分（会朗读） */
    text: string;
    /** 旁白部分（只上屏、居中灰字、不朗读） */
    narration?: string;
};

type VoiceCallScreenProps = {
    session: ChatSession;
    character: Character;
    onEnd: () => void;
    onConnect?: () => void;
    initiator?: "user" | "character";
    /** 通话是否处于缩小的悬浮窗状态：暂停麦克风监听/计时/语音播放，仅显示背景+名字 */
    minimized?: boolean;
    /** 点击左上角返回键：请求缩小为悬浮窗（通话逻辑冻结，不挂断） */
    onMinimize?: () => void;
    /** 点击悬浮窗：请求恢复为全屏通话界面 */
    onRestore?: () => void;
};

// 旁白判定 / TTS 取文统一在 lib/call-text.ts：旁白必须「正向识别」，
// 整段没有「名|」前缀时一律当正文，避免正文被掏空、角色哑掉。
function stripNarrationForSpeech(text: string): string {
    return speechTextForContent(text);
}

// 字幕拆分：有真旁白时抽出来单独淡字显示，台词留在 text（朗读 + 气泡）
function splitSubtitleContent(content: string): { text: string; narration?: string } {
    const { dialogue, narration } = splitNarration(content);
    const text = dialogue.trim();
    return { text, ...(narration ? { narration } : {}) };
}

// ── Component ───────────────────────────────────────

export function VoiceCallScreen({ session, character, onEnd, onConnect, initiator = "user", minimized = false, onMinimize, onRestore }: VoiceCallScreenProps) {
    // iOS 保留 Web Speech 免提 + Web Audio 播放（麦克风会话共存的老方案）；
    // 其余设备改「按住说话 + 云端转写」，播放走媒体元素（音量键可控、无静音拨键坑）。
    // 没配 OpenAI 兼容识别时回落旧行为（安卓=文字输入）。
    const iosDeviceRef = useRef(isIOSDevice());
    const iosDevice = iosDeviceRef.current;
    const holdToTalkRef = useRef(
        !iosDeviceRef.current && isCallRecordingSupported() && resolveCloudSttConfig(session.contactId) !== null,
    );
    const holdToTalk = holdToTalkRef.current;
    const androidTextInputOnlyRef = useRef(isAndroidBrowser() && !holdToTalkRef.current);
    const androidTextInputOnly = androidTextInputOnlyRef.current;
    // 统一用 WebAudio 播放：通话中语音是「延迟几秒」才播的，
    // <audio> 元素在移动端容易被自动播放策略拦掉（表现为完全无声但不报错）。
    const playCallAudio = playAudioBlob;
    const { style: keyboardOffsetStyle, offset: kbOffset } = useCallKeyboardOffsetStyle();
    const [callState, setCallState] = useState<CallState>("CONNECTING");
    const hasConnectedRef = useRef(false);
    const [callDuration, setCallDuration] = useState(0);
    const [subtitles, setSubtitles] = useState<SubtitleEntry[]>([]);
    const [interimText, setInterimText] = useState("");
    const [isMuted, setIsMuted] = useState(false);
    const [inputMode, setInputMode] = useState<"voice" | "text">(() => androidTextInputOnly ? "text" : "voice");
    const [typedText, setTypedText] = useState("");
    const [bgImageResolved, setBgImageResolved] = useState<string | null>(null);
    const [showSttWarning, setShowSttWarning] = useState(false);
    const pendingRef = useRef<string[]>([]);
    const busyRef = useRef(false);
    const [pendingCount, setPendingCount] = useState(0);
    const [autoChat, setAutoChat] = useState(false);
    const [autoCount, setAutoCount] = useState(0);
    const [selectedSubtitle, setSelectedSubtitle] = useState<SubtitleEntry | null>(null);
    const [editText, setEditText] = useState("");
    const [editingSubtitle, setEditingSubtitle] = useState(false);
    const [callMenuOpen, setCallMenuOpen] = useState(false);
    const [subtitlesHidden, setSubtitlesHidden] = useState(false);
    const [speakingId, setSpeakingId] = useState<string | null>(null);
    // 语音合成侧的可见提示（没绑语音 / 合成失败），避免"角色没声但毫无提示"
    const [ttsNotice, setTtsNotice] = useState<string | null>(null);
    // 通话偏好：接通后谁先开口（参考视频口径）。默认随发起方：我打的=我先说，她打来的=她先说。
    const [firstSpeaker, setFirstSpeaker] = useState<"user" | "character">(initiator === "character" ? "character" : "user");
    const firstSpeakerRef = useRef(firstSpeaker);
    useEffect(() => { firstSpeakerRef.current = firstSpeaker; }, [firstSpeaker]);
    const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const latestReplyIdsRef = useRef<string[]>([]);
    const [miniPosition, setMiniPosition] = useState<{ left: number; top: number } | null>(null);
    const miniDragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
    const turnRef = useRef<(text?: string) => Promise<void>>(async () => {});

    const sttRef = useRef<STTSession | null>(null);
    const audioAbortRef = useRef<(() => void) | null>(null);
    // 扬声器 = 出声总开关（参考设计的核心心智模型）：关 = TTS 全部跳过播放，只出字幕。
    // 环境音将来也挂这个开关下。
    const [speakerOn, setSpeakerOn] = useState(true);
    const speakerOnRef = useRef(true);
    useEffect(() => { speakerOnRef.current = speakerOn; }, [speakerOn]);
    const toggleSpeaker = useCallback(() => {
        setSpeakerOn(prev => {
            const next = !prev;
            speakerOnRef.current = next;
            if (!next && audioAbortRef.current) {
                audioAbortRef.current();
                audioAbortRef.current = null;
            }
            return next;
        });
    }, []);
    const requestAbortRef = useRef<AbortController | null>(null);
    const timerRef = useRef<NodeJS.Timeout | null>(null);
    const callStartRef = useRef<number>(0);
    const minimizedRef = useRef(false);
    const stateRef = useRef<string>("CONNECTING");
    const interimTextRef = useRef<string>("");  // ref 版本，闭包安全
    const sttWarningShownRef = useRef(false);
    const subtitleScrollRef = useRef<HTMLDivElement>(null);
    const messagesRef = useRef<ChatMessage[]>([]);
    const _initUi = resolveUserIdentity(session.contactId, "chat", session.userIdentityId);
    const userNameRef = useRef<string>(_initUi?.name || "你");

    // Keep refs in sync
    useEffect(() => { stateRef.current = callState; }, [callState]);
    useEffect(() => { minimizedRef.current = minimized; }, [minimized]);

    // 缩小时暂停收音以免误录；当前回复和计时继续。
    useEffect(() => {
        if (!minimized) return;
        if (sttRef.current) { sttRef.current.abort(); sttRef.current = null; }
        setInterimText("");
    }, [minimized]);

    // 来电等待接听：循环振动（开关在聊天主页，iOS 网页不支持自动无效果）
    useEffect(() => {
        if (initiator !== "character" || callState !== "CONNECTING") return;
        const stop = startIncomingCallVibration();
        return stop;
    }, [initiator, callState]);

    // Pause WeChat keep-alive while the call holds the mic/audio; restore on exit.
    useEffect(() => {
        suspendKeepAliveForCall();
        return () => { resumeKeepAliveAfterCall(); };
    }, []);

    // 通话音频会话 + 卸载兜底：不经挂断键退出（返回聊天页/切会话/组件被销毁）时，
    // 把识别、在途播放与音频会话全部释放。此前识别的自动重启循环在卸载后条件
    // 恒成立（stateRef 停在 IDLE），会在后台无限自我重启，麦克风永不归还，
    // 整页音频被钉在通话模式（语音条/试听音量巨大且音量键失灵）。
    useEffect(() => {
        setCallAudioSessionActive(true);
        return () => {
            stateRef.current = "ENDED";
            requestAbortRef.current?.abort();
            if (longPressRef.current) clearTimeout(longPressRef.current);
            if (sttRef.current) { sttRef.current.abort(); sttRef.current = null; }
            if (audioAbortRef.current) { audioAbortRef.current(); audioAbortRef.current = null; }
            setCallAudioSessionActive(false);
        };
    }, []);
    useEffect(() => { interimTextRef.current = interimText; }, [interimText]);

    const showSttCompatibilityWarning = useCallback(() => {
        if (androidTextInputOnly) {
            setInputMode("text");
            return;
        }
        if (sttWarningShownRef.current || isCallSttWarningHidden()) return;
        sttWarningShownRef.current = true;
        setShowSttWarning(true);
    }, [androidTextInputOnly]);

    const handleNeverShowSttWarning = useCallback(() => {
        hideCallSttWarningPermanently();
        setShowSttWarning(false);
    }, []);

    // Scroll subtitles to bottom on change
    useEffect(() => {
        if (subtitleScrollRef.current) {
            subtitleScrollRef.current.scrollTop = subtitleScrollRef.current.scrollHeight;
        }
    }, [subtitles, interimText]);

    // ── Resolve voiceBackground from IndexedDB ──────

    useEffect(() => {
        if (!session.voiceBackground) {
            setBgImageResolved(null);
            return;
        }
        if (session.voiceBackground.startsWith("data:") || session.voiceBackground.startsWith("http")) {
            setBgImageResolved(session.voiceBackground);
            return;
        }
        // IndexedDB ID
        import("@/lib/chat-asset-storage").then(({ getChatImageFromIndexedDB }) => {
            getChatImageFromIndexedDB(session.voiceBackground!).then(dataUrl => {
                if (dataUrl) setBgImageResolved(dataUrl);
            });
        });
    }, [session.voiceBackground]);

    // ── Call timer ───────────────────────────────────

    useEffect(() => {
        if (callState === "CONNECTING" || callState === "ENDED") return;

        if (!callStartRef.current) {
            callStartRef.current = Date.now();
        }


        timerRef.current = setInterval(() => {
            setCallDuration(Math.floor((Date.now() - callStartRef.current) / 1000));
        }, 1000);

        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [callState, minimized]);

    // ── Connecting animation (3s fake dial) ─────────

    useEffect(() => {
        cancelFollowUp(session.id);

        // Resolve user name
        const ui = resolveUserIdentity(session.contactId, "chat", session.userIdentityId);
        userNameRef.current = ui?.name || "你";

        // Load existing messages for context
        messagesRef.current = loadChatMessages(session.id);

        // Insert system message (skip if a call is already open)
        // 只向前找"最近一次通话的开始/结束"，避免重挂载时因最后一条是普通消息而重复插入，
        // 造成聊天流出现两张通话卡片、消息被拆成两组。
        const initRole = initiator === "character" ? "assistant" : "user";
        const hasOpenCallMarker = (() => {
            for (let mi = messagesRef.current.length - 1; mi >= 0; mi--) {
                const c = messagesRef.current[mi].content || "";
                if (c.includes("挂断了语音通话") || c.includes("拒绝了语音通话") || c.includes("取消了语音通话")) return false;
                if (c.includes("发起了语音通话")) return true;
            }
            return false;
        })();
        if (!hasOpenCallMarker) {
            const callMsg = initiator === "character"
                ? `[我向${userNameRef.current}发起了语音通话]`
                : `[我向${character.name}发起了语音通话]`;
            const sysMsg = pushChatMessage({
                sessionId: session.id,
                role: initRole,
                content: callMsg,
            });
            messagesRef.current = [...messagesRef.current, sysMsg];
        }

        // User-initiated: auto-connect after 3s fake dial
        // Character-initiated: wait for user to accept
        let connectTimer: NodeJS.Timeout | undefined;
        if (initiator !== "character") {
            connectTimer = setTimeout(() => {
                setCallState("IDLE");
            }, 3000);
        }

        return () => {
            if (connectTimer) clearTimeout(connectTimer);
            if (timerRef.current) clearInterval(timerRef.current);
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Track first connect + 通话偏好"对方先说"
    useEffect(() => {
        if (callState !== "CONNECTING" && !hasConnectedRef.current) {
            hasConnectedRef.current = true;
            // 接通瞬间（仍在用户点击的同一轮交互里）解锁音频播放，避免后续 TTS 被自动播放策略静音
            unlockAudioPlayback();
            // 接通瞬间：偏好"对方先说"且本轮还没有角色台词 → 立刻让她开口（不等用户说话，也不等自动搭话）
            const hasCallDialogue = messagesRef.current.some(m =>
                m.role === "assistant" && m.content && !m.content.includes("发起了语音通话") && !m.content.startsWith("[")
            );
            if (firstSpeakerRef.current === "character" && !hasCallDialogue) {
                void turnRef.current();
            }
        }
    }, [callState]);

    // ── Format time MM:SS ───────────────────────────

    const formatTime = (seconds: number) => {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    };

    // ── State label ─────────────────────────────────

    const stateLabel = (): string => {
        switch (callState) {
            case "CONNECTING": return initiator === "character" ? "来电..." : "正在呼叫...";
            case "IDLE": return isMuted ? "已静音" : "通话中";
            case "USER_SPEAKING": return "正在聆听...";
            case "PROCESSING": return "对方正在思考...";
            case "AI_SPEAKING": return "对方正在说话...";
            case "ENDED": return "通话已结束";
        }
    };

    // ── AI response processing (same logic as chat-room) ──

    const processAIResponse = useCallback((aiResponseText: string): { cleanParts: string[]; stateValues: StateValue[] } => {
        // Use shared parseAIResponse for full rich media support (stickers, quotes, etc.)
        const previousState = getLatestCharacterStateValues(session.contactId);

        const { parts, stateValues, freshStateValues, statusPanel, innerMonologue } = parseAIResponse(aiResponseText, previousState);

        // 自定义状态栏渲染戳：不盖的话 custom 模式下 [状态栏] 原文按 markdown 渲染，看着像掉格式
        const statusRegionMode = statusPanel && isCustomStatusRegionActive(getStatusRegionConfig(session.id))
            ? ("custom" as const)
            : undefined;

        // Filter out non-chat action types (voice_call, video_call, poke, etc.)
        const chatParts = parts.filter(p =>
            !p.mediaType || !["voice_call", "video_call", "poke", "accept_red_packet", "decline_red_packet", "accept_transfer", "decline_transfer", "accept_payment_request", "decline_payment_request"].includes(p.mediaType)
        ).map(p => p.mediaType === "audio"
            ? { ...p, content: p.mediaData?.label || p.content, mediaType: undefined, mediaData: undefined }
            : p);

        // Save messages to storage
        if (chatParts.length === 0 && (statusPanel || innerMonologue)) {
            const aiMsg = pushChatMessage({
                sessionId: session.id,
                role: "assistant",
                content: "",
                statusPanel,
                statusRegionMode,
                innerMonologue,
                stateValues: stateValues.length > 0 ? stateValues : undefined,
                freshStateValues,
            });
            messagesRef.current = [...messagesRef.current, aiMsg];
        } else {
            const newMsgs = chatParts.map((part, idx) =>
                pushChatMessage({
                    sessionId: session.id,
                    role: "assistant",
                    content: part.content,
                    mediaType: part.mediaType,
                    mediaData: part.mediaData,
                    statusPanel: idx === 0 && statusPanel ? statusPanel : undefined,
                    statusRegionMode: idx === 0 && statusPanel ? statusRegionMode : undefined,
                    innerMonologue: idx === 0 && innerMonologue ? innerMonologue : undefined,
                    stateValues: idx === 0 && stateValues.length > 0 ? stateValues : undefined,
                    freshStateValues: idx === 0 ? freshStateValues : undefined,
                })
            );
            messagesRef.current = [...messagesRef.current, ...newMsgs];
            setSubtitles(prev => [...prev, ...newMsgs.filter(m => !m.mediaType && m.content.trim()).map(m => ({ id: m.id, role: "assistant" as const, ...splitSubtitleContent(m.content) }))]);
        }

        // Return clean text parts for TTS (exclude rich media content)
        const cleanParts = chatParts
            .filter(p => !p.mediaType && p.content.trim())
            .map(p => p.content);

        return { cleanParts, stateValues };
    }, [session.id, session.contactId]);

    // ── Full conversation turn ──────────────────────

    const runConversationTurn = useCallback(async (userText?: string) => {
        if (stateRef.current === "ENDED" || busyRef.current) return;
        busyRef.current = true;
        const request = new AbortController();
        requestAbortRef.current = request;
        sttRef.current?.abort();
        sttRef.current = null;
        // 1. Save user message (skip for initial greeting)
        if (userText) {
            const userMsg = pushChatMessage({
                sessionId: session.id,
                role: "user",
                content: userText,
            });
            messagesRef.current = [...messagesRef.current, userMsg];

            // Add user subtitle
            setSubtitles(prev => [...prev, { id: userMsg.id, role: "user", text: userText }]);
        }

        // 2. Switch to PROCESSING
        setCallState("PROCESSING");
        setInterimText("");
        setTtsNotice(null);

        try {
            recordCallDiagnostic(`通话开始请求 · 输入 ${userText?.length ?? 0} 字 · 历史 ${messagesRef.current.length} 条 · 安卓文字降级 ${androidTextInputOnly}`);
            // 3. Generate AI response
            const aiResponseText = flattenCompletionResult(await generateChatCompletion(session, messagesRef.current, {
                appTags: ["chat", "voice"],
                signal: request.signal,
            }));

            // Bail if call ended during generation
            if (stateRef.current === "ENDED") return;

            // 4. Process response
            const previousIds = new Set(messagesRef.current.map(m => m.id));
            const { cleanParts } = processAIResponse(aiResponseText);
            const displayText = cleanParts.join("\n");
            recordCallDiagnostic(`模型返回 ${aiResponseText.length} 字 · 解析字幕 ${cleanParts.length} 段 / ${displayText.length} 字`);
            const speechText = stripNarrationForSpeech(displayText);

            if (!displayText.trim()) {
                throw new Error("本次通话回复没有可显示的文字，请重试或检查模型返回内容。");
            }

            const replyMessages = messagesRef.current.filter(m => !previousIds.has(m.id) && !m.mediaType && m.content.trim());
            latestReplyIdsRef.current = replyMessages.map(m => m.id);
            recordCallDiagnostic(`本轮新消息 ${replyMessages.length} 条${replyMessages.length ? "" : "（已回退用解析文本朗读）"}`);

            // 兜底：新消息没入库（解析/过滤失配）时也必须出声，直接用本轮解析出的文本
            const ttsTargets = replyMessages.length > 0
                ? replyMessages.map(m => ({ id: m.id, content: m.content }))
                : [{ id: `live-${Date.now()}`, content: speechText || displayText }];

            // 6. TTS
            setCallState("AI_SPEAKING");

            const voiceConfig = resolveVoiceConfig(session.contactId);
            if (!voiceConfig) {
                setTtsNotice("未绑定语音：本次通话只有字幕（去角色设置里配一个 MiniMax 音色）");
                recordCallDiagnostic("TTS 跳过：resolveVoiceConfig 返回空（角色未绑定语音）");
            }
            if (voiceConfig) {
                try {
                    for (const message of ttsTargets) {
                        if (stateRef.current === "ENDED") break;
                        if (!speakerOnRef.current) {
                            recordCallDiagnostic("扬声器关闭：跳过合成与播放（只出字幕）");
                            continue;
                        }
                        setSpeakingId(message.id);
                        const spoken = stripNarrationForSpeech(message.content);
                        recordCallDiagnostic(`TTS 取文 ${spoken.length} 字：${spoken.slice(0, 40)}`);
                        const chunks = splitSpeechChunks(spoken);
                        const audioParts: Blob[] = [];
                        let pendingChunk: Promise<Blob | null> | null = null;
                        for (let i = 0; i < chunks.length; i++) {
                            if (stateRef.current === "ENDED") break;
                            const chunkStartedAt = Date.now();
                            const audioBlob = pendingChunk ? await pendingChunk : await synthesizeSpeech(chunks[i], voiceConfig);
                            // 播放这一句的同时，先把下一句送去合成
                            pendingChunk = i + 1 < chunks.length
                                ? synthesizeSpeech(chunks[i + 1], voiceConfig).catch(() => null)
                                : null;
                            recordCallDiagnostic(`合成第 ${i + 1}/${chunks.length} 段：${Date.now() - chunkStartedAt}ms · ${chunks[i].length} 字`);
                            if (stateRef.current === "ENDED") break;
                            if (!audioBlob) {
                                setTtsNotice("语音合成返回空音频（检查音色配置 / 额度）");
                                recordCallDiagnostic(`TTS 第 ${i + 1} 段返回空音频`);
                                continue;
                            }
                            audioParts.push(audioBlob);
                            // 扬声器总开关（参考设计）：关 = 只出字幕不出声，直接跳过播放
                            if (!speakerOnRef.current) continue;
                            const { promise, abort } = playCallAudio(audioBlob);
                            audioAbortRef.current = abort;
                            const playStarted = Date.now();
                            try {
                                await promise;
                                recordCallDiagnostic(`播放完成：${Date.now() - playStarted}ms · ${audioBlob.size} bytes · ${audioBlob.type || "未知类型"}`);
                            } catch (playError: any) {
                                recordCallDiagnostic(`播放失败：${playError?.message || String(playError)}`);
                                setTtsNotice(`语音播放失败：${playError?.message || String(playError)}`);
                            }
                            audioAbortRef.current = null;
                        }
                        // 分段音频拼成整条，仍按原逻辑存为「角色原音」供回放/重听
                        if (audioParts.length) {
                            try {
                                const current = loadChatMessages(session.id).find(m => m.id === message.id);
                                if (current?.content === message.content) {
                                    const merged = new Blob(audioParts, { type: audioParts[0].type || "audio/mpeg" });
                                    const audio = await prepareChatVoiceAudio(merged, message.content);
                                    updateChatMessage(message.id, { ...audio, mediaData: { ...audio.mediaData, synthesizedFromText: spoken } });
                                    messagesRef.current = loadChatMessages(session.id);
                                }
                            } catch (error) { console.warn("[VoiceCall] 保存原音失败", error); }
                        }
                        setSpeakingId(null);
                    }
                } catch (e: any) {
                    console.warn("[VoiceCall] TTS failed:", e);
                    setTtsNotice(`语音合成失败：${e?.message || String(e)}`);
                    recordCallDiagnostic(`TTS 失败：${e?.message || String(e)}`);
                }
            }
            setSpeakingId(null);

            if (stateRef.current !== "ENDED") {
                setCallState("IDLE");
            }
        } catch (error: any) {
            console.error("[VoiceCall] Error:", error);
            if (stateRef.current !== "ENDED") {
                setSubtitles(prev => [...prev, {
                    id: `err-${Date.now()}`,
                    role: "assistant",
                    text: `⚠️ ${error?.message || "发送失败"}`,
                }]);
                setCallState("IDLE");
            }
        } finally {
            busyRef.current = false;
            if (stateRef.current !== "ENDED" && pendingRef.current.length > 0) {
                const next = pendingRef.current.shift()!;
                setPendingCount(pendingRef.current.length);
                queueMicrotask(() => { void turnRef.current(next); });
            }
        }
    }, [session, processAIResponse, playCallAudio]);
    turnRef.current = runConversationTurn;

    // ── Auto-listen: 进入 IDLE 自动开始监听 ────────

    const startListening = useCallback(() => {
        if (holdToTalk) return; // 按住说话模式不用 Web Speech 自动监听
        if (androidTextInputOnly) {
            setInputMode("text");
            return;
        }
        if (sttRef.current) {
            sttRef.current.abort();
            sttRef.current = null;
        }
        setInterimText("");
        interimTextRef.current = "";

        const stt = createSTTSession({
            onInterim: (text) => {
                setInterimText(text);
                interimTextRef.current = text;
                // 有中间结果 → 切到 USER_SPEAKING
                if (stateRef.current === "IDLE") {
                    setCallState("USER_SPEAKING");
                }
            },
            onFinal: (text) => {
                sttRef.current = null;
                if (text.trim()) {
                    runConversationTurn(text.trim());
                } else {
                    setInterimText("");
                    setCallState("IDLE");
                }
            },
            onError: (error) => {
                console.warn("[VoiceCall] STT error:", error);
                sttRef.current = null;
                setInterimText("");
                showSttCompatibilityWarning();
                // 严重错误，回到 IDLE（会触发重新监听）
                if (stateRef.current === "USER_SPEAKING" || stateRef.current === "IDLE") {
                    setCallState("IDLE");
                }
            },
            onNoSpeech: () => {
                // 没检测到语音 → 静默重新开始监听
                sttRef.current = null;
                showSttCompatibilityWarning();
                if (stateRef.current === "IDLE" || stateRef.current === "USER_SPEAKING") {
                    // 短暂延迟后重启，避免快速循环
                    setTimeout(() => {
                        if (stateRef.current === "IDLE") {
                            startListening();
                        }
                    }, 300);
                }
            },
            onEnd: () => {
                // 没有 finalText 也没有 no-speech → 用 interimRef 兜底
                sttRef.current = null;
                if (stateRef.current === "USER_SPEAKING" || stateRef.current === "IDLE") {
                    const fallback = interimTextRef.current;
                    if (fallback.trim()) {
                        runConversationTurn(fallback.trim());
                    } else {
                        setInterimText("");
                        setCallState("IDLE");
                    }
                }
            },
        }, "zh-CN");

        sttRef.current = stt;

        if (stt.isSupported) {
            stt.start();
        } else {
            sttRef.current = null;
            showSttCompatibilityWarning();
        }
    }, [androidTextInputOnly, holdToTalk, runConversationTurn, session.contactId, showSttCompatibilityWarning]);

    // IDLE 时自动开启监听（按住说话模式无自动监听，识别只在按住期间发生）
    useEffect(() => {
        if (holdToTalk) return;
        if (inputMode === "text" && sttRef.current) {
            sttRef.current.abort();
            sttRef.current = null;
            setInterimText("");
        }
        if (!androidTextInputOnly && inputMode === "voice" && callState === "IDLE" && !isMuted && !minimized) {
            // 短暂延迟让 UI 过渡完成
            const timer = setTimeout(() => {
                if (stateRef.current === "IDLE" && !minimizedRef.current) {
                    startListening();
                }
            }, 500);
            return () => clearTimeout(timer);
        }
        // 静音时停止监听
        if (isMuted && sttRef.current) {
            sttRef.current.abort();
            sttRef.current = null;
        }
    }, [androidTextInputOnly, holdToTalk, callState, isMuted, inputMode, minimized, startListening]);

    const handleInputModeToggle = useCallback(() => {
        if (androidTextInputOnly) {
            if (sttRef.current) {
                sttRef.current.abort();
                sttRef.current = null;
            }
            setInterimText("");
            if (stateRef.current === "USER_SPEAKING") setCallState("IDLE");
            setInputMode("text");
            return;
        }
        if (inputMode === "voice") {
            if (sttRef.current) {
                sttRef.current.abort();
                sttRef.current = null;
            }
            setInterimText("");
            if (stateRef.current === "USER_SPEAKING") setCallState("IDLE");
            setInputMode("text");
        } else {
            setInputMode("voice");
        }
    }, [androidTextInputOnly, inputMode]);

    const handleTextSubmit = useCallback(() => {
        const text = typedText.trim();
        if (!text || callState === "CONNECTING" || callState === "ENDED") return;
        if (busyRef.current) {
            if (pendingRef.current.length >= 5) return;
            pendingRef.current.push(text);
            setPendingCount(pendingRef.current.length);
            setTypedText("");
            return;
        }
        if (sttRef.current) {
            sttRef.current.abort();
            sttRef.current = null;
        }
        setTypedText("");
        runConversationTurn(text);
    }, [typedText, callState, runConversationTurn]);

    // 输入框左侧的"重回"键：不发送新内容，直接让对方基于当前上下文重新回复一次
    const handleRegenerate = useCallback(() => {
        if (callState !== "IDLE") return;
        if (sttRef.current) {
            sttRef.current.abort();
            sttRef.current = null;
        }
        runConversationTurn();
    }, [callState, runConversationTurn]);

    // 按住说话（非 iOS）：按下录音，松开转写后走对话轮
    const holdInput = useHoldToTalk({
        characterId: session.contactId,
        canStart: () => stateRef.current === "IDLE",
        onRecordingStart: () => {
            setInterimText("");
            if (stateRef.current === "IDLE") setCallState("USER_SPEAKING");
        },
        onTranscribeStart: () => {
            if (stateRef.current === "USER_SPEAKING") setCallState("PROCESSING");
        },
        onTranscript: (text) => { void runConversationTurn(text); },
        onError: () => {
            if (stateRef.current === "USER_SPEAKING" || stateRef.current === "PROCESSING") {
                setCallState("IDLE");
            }
        },
    });

    useEffect(() => {
        if (!autoChat || autoCount >= 3 || callState !== "IDLE" || pendingCount > 0 || typedText.trim() || minimized) return;
        const timer = setTimeout(() => {
            if (busyRef.current || stateRef.current !== "IDLE") return;
            sttRef.current?.abort();
            sttRef.current = null;
            setAutoCount(count => count + 1);
            void turnRef.current();
        }, 45000 + Math.random() * 30000);
        return () => clearTimeout(timer);
    }, [autoChat, autoCount, callState, pendingCount, typedText, minimized]);

    // 台词编辑：允许保存为空（清空 = 放弃用户创作，空台词只是中间态）；
    // regenerate=true 表示"清空后按发送键让角色重说"——删除本轮 AI 台词并重新开一轮。
    const applySubtitleEdit = (regenerate = false) => {
        if (!selectedSubtitle) return;
        const next = editText.trim();
        if (regenerate && next) return; // 重新生成只针对已清空的台词
        updateChatMessage(selectedSubtitle.id, { content: next, mediaType: undefined, mediaUrl: undefined, mediaData: undefined });
        messagesRef.current = loadChatMessages(session.id);
        setSubtitles(items => items.map(item => item.id === selectedSubtitle.id ? { ...item, text: next } : item));
        setSelectedSubtitle(null);
        setEditingSubtitle(false);
        if (regenerate) {
            // 与原"重新生成"一致：删掉本轮 AI 台词（含这条已清空的），再开一轮
            const ids = new Set(latestReplyIdsRef.current);
            ids.add(selectedSubtitle.id);
            for (const id of ids) deleteChatMessage(id);
            messagesRef.current = loadChatMessages(session.id);
            setSubtitles(items => items.filter(item => !ids.has(item.id)));
            void turnRef.current();
        }
    };

    // ── Hangup ──────────────────────────────────────

    const handleHangup = useCallback(() => {
        if (stateRef.current === "ENDED") return;
        stateRef.current = "ENDED";
        pendingRef.current = [];
        requestAbortRef.current?.abort();
        setPendingCount(0);
        setCallState("ENDED");

        // Stop any ongoing STT
        if (sttRef.current) {
            sttRef.current.abort();
            sttRef.current = null;
        }

        // Stop any ongoing audio playback
        if (audioAbortRef.current) {
            audioAbortRef.current();
            audioAbortRef.current = null;
        }

        // Stop browser TTS
        if (window.speechSynthesis) {
            window.speechSynthesis.cancel();
        }

        const endMsg = pushChatMessage({
            sessionId: session.id,
            role: "user",
            content: `[我挂断了语音通话]`,
            mediaData: { callDuration: formatTime(callDuration) },
        });
        messagesRef.current = [...messagesRef.current, endMsg];

        // Delay then close
        setTimeout(() => onEnd(), 1500);
    }, [session.id, callDuration, onEnd]);

    // ── Render ──────────────────────────────────────

    if (minimized) {
        return (
            <div className="call-mini-window call-mini-compact" style={miniPosition ? { left: miniPosition.left, top: miniPosition.top, bottom: "auto", right: "auto" } : undefined}>
                <div className="call-mini-drag" aria-label="拖动通话小窗" onPointerDown={e => {
                    if (!e.isPrimary || e.button !== 0) return;
                    e.preventDefault();
                    const box = e.currentTarget.parentElement!;
                    miniDragRef.current = { x: e.clientX, y: e.clientY, left: box.offsetLeft, top: box.offsetTop };
                    e.currentTarget.setPointerCapture(e.pointerId);
                }} onPointerMove={e => {
                    const drag = miniDragRef.current;
                    if (!drag) return;
                    const box = e.currentTarget.parentElement!;
                    const parent = box.offsetParent as HTMLElement | null;
                    setMiniPosition({ left: Math.max(0, Math.min((parent?.clientWidth ?? innerWidth) - box.offsetWidth, drag.left + e.clientX - drag.x)), top: Math.max(0, Math.min((parent?.clientHeight ?? innerHeight) - box.offsetHeight, drag.top + e.clientY - drag.y)) });
                }} onPointerUp={e => {
                    miniDragRef.current = null;
                    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
                }} onPointerCancel={() => { miniDragRef.current = null; }} onLostPointerCapture={() => { miniDragRef.current = null; }}><span /></div>
                <button type="button" className="call-mini-restore" onClick={onRestore} aria-label={`返回与${character.name}的语音通话`}>
                    {character.avatar && <img src={character.avatar} alt="" />}
                    <span><strong>{character.name}</strong><small>{formatTime(callDuration)} · {stateLabel()}</small></span>
                </button>
                <form className="call-mini-reply" onSubmit={e => { e.preventDefault(); handleTextSubmit(); }}>
                    <input aria-label="通话快捷回复" value={typedText} onChange={e => setTypedText(e.target.value)} placeholder={pendingCount ? `${pendingCount} 条待发送` : "说点什么…"} />
                    <button type="submit" disabled={!typedText.trim() || callState === "CONNECTING" || callState === "ENDED"}>发送</button>
                    <button type="button" onClick={handleHangup} aria-label="挂断通话">挂断</button>
                </form>
            </div>
        );
    }

    return (
        <div
            className="absolute inset-0 z-[100] flex flex-col text-white overflow-hidden call-bg-default call-keyboard-shift"
            data-keyboard={kbOffset > 0 ? "" : undefined}
            onPointerDown={() => { unlockAudioPlayback(); recordCallDiagnostic("手势解锁音频上下文"); }}
            style={bgImageResolved ? { ...keyboardOffsetStyle, background: `url(${bgImageResolved}) center/cover no-repeat` } : keyboardOffsetStyle}
        >
            {/* Dark overlay for readability */}
            <div
                className="call-overlay absolute inset-0 z-0"
                {...(bgImageResolved ? { "data-has-image": "" } : {})}
            />

            {onMinimize && callState !== "ENDED" && (
                <button
                    type="button"
                    className="call-back-btn"
                    onClick={onMinimize}
                    aria-label="缩小通话"
                    title="缩小通话"
                >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M15 18l-6-6 6-6" />
                    </svg>
                </button>
            )}

            {/* Content wrapper — force white text so themes don't override call UI */}
            <div className="voicecall-controls gcall-body">
                {/* Top: Duration + Status + 「···」通话菜单（自动搭话 / 字幕显隐；通话偏好将来也放这） */}
                <div className="gcall-topbar">
                    <div className="gcall-topbar-title">
                        {character.name}
                    </div>
                    <div
                        className="gcall-topbar-sub"
                        {...(callState === "CONNECTING" || callState === "PROCESSING" ? { "data-anim": "" } : {})}
                    >
                        {callState !== "CONNECTING" && callState !== "ENDED" ? `${formatTime(callDuration)} · ` : ""}
                        {stateLabel()}
                    </div>
                    <button
                        type="button"
                        className="call-more-btn"
                        onClick={() => setCallMenuOpen(value => !value)}
                        aria-expanded={callMenuOpen}
                        aria-label="通话选项"
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                            <circle cx="5" cy="12" r="1.9" /><circle cx="12" cy="12" r="1.9" /><circle cx="19" cy="12" r="1.9" />
                        </svg>
                    </button>
                    {callMenuOpen && (
                        <>
                            <div className="call-more-backdrop" onClick={() => setCallMenuOpen(false)} aria-hidden="true" />
                            <div className="call-more-panel" role="menu" aria-label="通话选项">
                                <p className="call-more-title">通话偏好</p>
                                {(() => {
                                    const speakerLocked = !hasConnectedRef.current || subtitles.some(s => s.role === "assistant" && s.text);
                                    const setSpeaker = (v: "character" | "user") => {
                                        if (speakerLocked || v === firstSpeaker) return;
                                        setFirstSpeaker(v);
                                    };
                                    return (
                                        <>
                                            <button
                                                type="button"
                                                role="menuitemradio"
                                                aria-checked={firstSpeaker === "character"}
                                                disabled={speakerLocked}
                                                onClick={() => setSpeaker("character")}
                                            >
                                                <span className="call-more-ico" aria-hidden="true">
                                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                                        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
                                                    </svg>
                                                </span>
                                                <span className="call-more-main">
                                                    <b>对方先说</b>
                                                    <small>等待对方先开口{speakerLocked ? " · 已定" : ""}</small>
                                                </span>
                                                {firstSpeaker === "character" && (
                                                    <span className="call-more-check" aria-hidden="true">
                                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                                                    </span>
                                                )}
                                            </button>
                                            <button
                                                type="button"
                                                role="menuitemradio"
                                                aria-checked={firstSpeaker === "user"}
                                                disabled={speakerLocked}
                                                onClick={() => setSpeaker("user")}
                                            >
                                                <span className="call-more-ico" aria-hidden="true">
                                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                                                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                                        <path d="M12 19v3" />
                                                    </svg>
                                                </span>
                                                <span className="call-more-main">
                                                    <b>你先说</b>
                                                    <small>由你先发起对话{speakerLocked ? " · 已定" : ""}</small>
                                                </span>
                                                {firstSpeaker === "user" && (
                                                    <span className="call-more-check" aria-hidden="true">
                                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                                                    </span>
                                                )}
                                            </button>
                                        </>
                                    );
                                })()}
                                <div className="call-more-divider" aria-hidden="true" />
                                <button
                                    type="button"
                                    role="menuitemcheckbox"
                                    aria-checked={!subtitlesHidden}
                                    onClick={() => setSubtitlesHidden(value => !value)}
                                >
                                    <span className="call-more-ico" aria-hidden="true">
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                            <rect x="2" y="5" width="20" height="14" rx="3" />
                                            <path d="M6 15h4" /><path d="M12 15h6" /><path d="M6 11h12" />
                                        </svg>
                                    </span>
                                    <span className="call-more-main">
                                        <b>字幕显示</b>
                                        <small>在台词区展示文字内容</small>
                                    </span>
                                    <span className={`call-more-switch ${subtitlesHidden ? "" : "on"}`} aria-hidden="true"><i /></span>
                                </button>
                                <button
                                    type="button"
                                    role="menuitemcheckbox"
                                    aria-checked={autoChat}
                                    onClick={() => setAutoChat(value => !value)}
                                >
                                    <span className="call-more-ico" aria-hidden="true">
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" />
                                            <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" />
                                        </svg>
                                    </span>
                                    <span className="call-more-main">
                                        <b>自动搭话</b>
                                        <small>安静时替你接话{autoChat ? ` · 最多 3 次` : ""}</small>
                                    </span>
                                    <span className={`call-more-switch ${autoChat ? "on" : ""}`} aria-hidden="true"><i /></span>
                                </button>
                                {autoChat && <p className="call-more-hint">安静 45–75 秒后开口，本次通话最多 3 次</p>}
                            </div>
                        </>
                    )}
                </div>

                {/* Center: Avatar + connecting ring */}
                <div className="flex-none flex justify-center items-center pt-[30px] pb-5 voicecall-avatar-stage">
                    <div className="relative flex items-center justify-center">
                        <div
                            className="voicecall-avatar"
                            {...(callState === "AI_SPEAKING" ? { "data-speaking": "" } : {})}
                        >
                            {character.avatar ? (
                                <img
                                    src={character.avatar}
                                    alt={character.name}
                                    className="w-full h-full object-cover"
                                />
                            ) : (
                                <span className="ts-48 text-[var(--c-icon)]">
                                    {character.name?.[0] || "?"}
                                </span>
                            )}
                        </div>
                        {callState === "CONNECTING" && (
                            <>
                                <div
                                    className="absolute w-[160px] h-[160px] rounded-full pointer-events-none"
                                    style={{
                                        border: "2px solid rgba(255,255,255,0.2)",
                                        animation: "voicecall-ring 1.5s ease-out infinite",
                                    }}
                                />
                                <div
                                    className="absolute w-[160px] h-[160px] rounded-full pointer-events-none"
                                    style={{
                                        border: "2px solid rgba(255,255,255,0.2)",
                                        animation: "voicecall-ring 1.5s ease-out infinite 0.5s",
                                    }}
                                />
                            </>
                        )}
                    </div>
                </div>

                <div className="text-center ts-18 font-semibold mb-2">
                    {character.name}
                </div>

                {pendingCount > 0 && (
                    <div className="text-center ts-12 opacity-80 px-5">
                        {pendingCount} 条待发送
                    </div>
                )}

                {/* Subtitle area — top fade via mask（字幕可隐藏；长按已取消，编辑走台词旁 ✏️） */}
                <div
                    ref={subtitleScrollRef}
                    className="voicecall-subtitle-mask flex-1 min-h-0 overflow-auto px-5 py-[10px] flex flex-col gap-2 relative"
                    {...(callState !== "CONNECTING" && callState !== "ENDED" ? { "data-text-input": "" } : {})}
                >
                    {subtitlesHidden && subtitles.length > 0 && (
                        <div className="call-subtitle" data-subtitles-hidden="">
                            字幕已隐藏 · 可在右上「···」恢复
                        </div>
                    )}
                    {!subtitlesHidden && subtitles.map((sub) => {
                        const isEditing = editingSubtitle && selectedSubtitle?.id === sub.id;
                        const isLatestAssistant = sub.role === "assistant" && !!sub.text && subtitles.filter(s => s.role === "assistant" && s.text).slice(-1)[0]?.id === sub.id;
                        return (
                            <div key={sub.id} className="call-subtitle" data-role={sub.role} data-speaking={speakingId === sub.id || undefined}>
                                {isEditing ? (
                                    <textarea
                                        className="call-subtitle-edit"
                                        autoFocus
                                        value={editText}
                                        onChange={e => setEditText(e.target.value)}
                                        placeholder="编辑台词（自动保存）；清空后按发送键让角色重说"
                                    />
                                ) : (
                                    <>
                                        {!sub.text && !sub.narration && <span className="call-subtitle-cleared">（已清空 · 按发送键让角色重说）</span>}
                                        {sub.text && (
                                            <span className="call-subtitle-body"><SubtitleText text={sub.text} /></span>
                                        )}
                                        {sub.narration && (
                                            <div className="call-subtitle-narration">{sub.narration}</div>
                                        )}
                                    </>
                                )}
                                {isLatestAssistant && !editingSubtitle && callState !== "ENDED" && !callMenuOpen && !!sub.text && (
                                    <button
                                        type="button"
                                        className="call-subtitle-edit-btn"
                                        aria-label="编辑台词"
                                        onClick={() => { setSelectedSubtitle(sub); setEditText(sub.text); setEditingSubtitle(true); }}
                                    >
                                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M12 20h9" />
                                            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                                        </svg>
                                    </button>
                                )}
                            </div>
                        );
                    })}

                    {/* Interim STT text */}
                    {interimText && callState === "USER_SPEAKING" && (
                        <div className="call-subtitle" data-interim="">
                            {interimText}
                        </div>
                    )}
                </div>

                {/* 常驻文字输入框（参考设计：通话界面始终可打字，语音与文字混用不用切模式） */}
                {callState !== "CONNECTING" && callState !== "ENDED" && (
                    <form
                        className="call-text-input-panel voicecall-text-input-panel call-text-input-row"
                        onSubmit={(e) => {
                            e.preventDefault();
                            // 编辑态独占发送键：非空 = 完成编辑；空 = 让角色重说（重新生成）
                            if (editingSubtitle && selectedSubtitle) {
                                applySubtitleEdit(!editText.trim());
                                return;
                            }
                            handleTextSubmit();
                        }}
                    >
                        <div className="call-text-input-shell">
                            <input
                                value={typedText}
                                onChange={e => setTypedText(e.target.value)}
                                className="call-text-input"
                                placeholder={editingSubtitle ? "编辑台词中（在上方气泡里改）…" : pendingCount >= 5 ? "待发已满，文字会保留" : busyRef.current ? "输入后排队发送…" : "输入你想说的话…"}
                                tabIndex={editingSubtitle ? -1 : 0}
                            />
                            <button
                                type="submit"
                                className="call-text-send-btn"
                                {...(editingSubtitle ? { "data-editing": "" } : {})}
                                disabled={editingSubtitle ? false : (!typedText.trim() || pendingCount >= 5)}
                                aria-label={editingSubtitle ? (editText.trim() ? "完成编辑" : "让角色重说") : "发送"}
                            >
                                {editingSubtitle && !editText.trim() ? (
                                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M21 12a9 9 0 1 1-3.5-7.1" />
                                        <polyline points="21 3 21 9 15 9" />
                                    </svg>
                                ) : editingSubtitle ? (
                                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                                        <polyline points="20 6 9 17 4 12" />
                                    </svg>
                                ) : (
                                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M12 19V5" />
                                        <path d="M5 12l7-7 7 7" />
                                    </svg>
                                )}
                            </button>
                        </div>
                    </form>
                )}

                {/* 编辑态提示条：点它 = 自动保存并退出（生成唯一入口是发送键，见下方表单） */}
                {editingSubtitle && selectedSubtitle && (
                    <button
                        type="button"
                        className="call-subtitle-edit-hint"
                        onClick={() => applySubtitleEdit(false)}
                    >
                        正在编辑台词 · 点此自动保存{editText.trim() ? "" : "；或按发送键让角色重说"}
                    </button>
                )}

                {/* 按住说话提示/错误行 */}
                {ttsNotice && (
                    <div className="text-center ts-12 px-5" style={{ color: "#ffc2c2" }}>{ttsNotice}</div>
                )}
                {!editingSubtitle && holdToTalk && inputMode === "voice" && callState !== "CONNECTING" && callState !== "ENDED" && (
                    <div className="text-center ts-12 opacity-80 px-5">
                        {holdInput.recState === "recording" ? "松开发送"
                            : holdInput.recState === "transcribing" ? "识别中…"
                            : holdInput.error || "按住下方麦克风说话"}
                    </div>
                )}

                {!editingSubtitle && <CallDiagnosticPanel characterId={session.contactId} />}

                {/* Bottom controls */}
                <div
                    className="call-bottom-controls relative flex justify-center items-center gap-[26px] px-4 py-5"
                    data-compact={editingSubtitle ? "" : undefined}
                >
                    {callState !== "ENDED" && callState !== "CONNECTING" ? holdToTalk ? (
                        <>
                            {/* 静音（按住说话模式下静音 = 禁用麦克风按键） */}
                            <button
                                onClick={() => setIsMuted(!isMuted)}
                                className="ui-call-btn ui-call-btn-muted"
                                {...(isMuted ? { "data-checked": "" } : {})}
                                aria-label={isMuted ? "取消静音" : "静音"}
                            >
                                {isMuted ? (
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <line x1="1" y1="1" x2="23" y2="23" />
                                        <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
                                        <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.48-.35 2.15" />
                                        <line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" />
                                    </svg>
                                ) : (
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                        <line x1="12" y1="19" x2="12" y2="22" />
                                    </svg>
                                )}
                            </button>

                            {/* 按住说话主按钮（常驻输入框上方的文字输入不冲突：想说就按住，想打就打字） */}
                            <button
                                className="ui-call-mic ui-call-mic-lg"
                                style={{ touchAction: "none" }}
                                disabled={isMuted}
                                data-state={
                                    isMuted ? "idle-muted"
                                        : holdInput.recState === "recording" ? "speaking"
                                        : callState === "IDLE" ? "idle"
                                        : "busy"
                                }
                                aria-label={isMuted ? "已静音" : "按住说话"}
                                title={isMuted ? "已静音" : "按住说话"}
                                {...(isMuted ? {} : holdInput.pressHandlers)}
                            >
                                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                    <line x1="12" y1="19" x2="12" y2="22" />
                                </svg>
                            </button>

                            {/* Hangup */}
                            <button
                                onClick={handleHangup}
                                className="ui-call-btn ui-call-btn-danger"
                                aria-label="挂断"
                            >
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
                                    <line x1="23" y1="1" x2="1" y2="23" />
                                </svg>
                            </button>

                            {/* 扬声器 = 出声总开关：关 = 角色只出字幕不出声（环境音将来也挂这里） */}
                            <button
                                onClick={toggleSpeaker}
                                className="ui-call-btn ui-call-btn-muted"
                                {...(speakerOn ? {} : { "data-checked": "" })}
                                aria-label={speakerOn ? "关闭声音（只看字幕）" : "开启声音"}
                                title={speakerOn ? "关闭声音（只看字幕）" : "开启声音"}
                            >
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                                    {speakerOn ? (
                                        <path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14" />
                                    ) : (
                                        <><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></>
                                    )}
                                </svg>
                            </button>
                        </>
                    ) : androidTextInputOnly ? (
                        <>
                        <span aria-hidden="true" style={{ width: 56, height: 56 }} />
                        <button
                            onClick={handleHangup}
                            className="ui-call-btn ui-call-btn-danger"
                            aria-label="挂断"
                        >
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
                                <line x1="23" y1="1" x2="1" y2="23" />
                            </svg>
                        </button>
                        <CallVolumeControl inBottomBar />
                        </>
                    ) : (
                        <>
                            {/* Mute button */}
                            <button
                                onClick={() => setIsMuted(!isMuted)}
                                className="ui-call-btn ui-call-btn-muted"
                                {...(isMuted ? { "data-checked": "" } : {})}
                            >
                                {isMuted ? (
                                    /* Muted: mic with diagonal */
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <line x1="1" y1="1" x2="23" y2="23" />
                                        <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
                                        <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.48-.35 2.15" />
                                        <line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" />
                                    </svg>
                                ) : (
                                    /* Active mic */
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                        <line x1="12" y1="19" x2="12" y2="22" />
                                    </svg>
                                )}
                            </button>

                            {/* Mic button — input mode toggle with voice-state indicator */}
                            <button
                                onClick={handleInputModeToggle}
                                className="ui-call-mic ui-call-mic-lg"
                                data-state={
                                    inputMode === "text" ? "text"
                                        : callState === "USER_SPEAKING" ? "speaking"
                                        : callState === "IDLE" ? (isMuted ? "idle-muted" : "idle")
                                        : "busy"
                                }
                                aria-label={androidTextInputOnly ? "文字输入" : inputMode === "voice" ? "切换到文字输入" : "切换到语音输入"}
                                title={androidTextInputOnly ? "安卓浏览器使用文字输入" : inputMode === "voice" ? "切换到文字输入" : "切换到语音输入"}
                            >
                                {inputMode === "text" ? (
                                    <span className="ui-call-input-text-icon">Aa</span>
                                ) : (
                                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                        <line x1="12" y1="19" x2="12" y2="22" />
                                    </svg>
                                )}
                            </button>

                            {/* Hangup button */}
                            <button
                                onClick={handleHangup}
                                className="ui-call-btn ui-call-btn-danger"
                            >
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
                                    <line x1="23" y1="1" x2="1" y2="23" />
                                </svg>
                            </button>

                            {/* Speaker (volume) control */}
                            <CallVolumeControl inBottomBar />
                        </>
                    ) : callState === "CONNECTING" && initiator === "character" ? (
                        /* Incoming call: accept + decline */
                        <>
                            <button
                                onClick={() => {
                                    pushChatMessage({
                                        sessionId: session.id,
                                        role: "user",
                                        content: `[我拒绝了语音通话]`,
                                    });
                                    onEnd();
                                }}
                                className="ui-call-btn ui-call-btn-danger"
                            >
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
                                    <line x1="23" y1="1" x2="1" y2="23" />
                                </svg>
                            </button>
                            <button
                                onClick={() => setCallState("IDLE")}
                                className="ui-call-btn ui-call-btn-success"
                            >
                                {/* Phone pick-up icon */}
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
                                </svg>
                            </button>
                        </>
                    ) : callState === "CONNECTING" ? (
                        /* User-initiated: show cancel only */
                        <button
                            onClick={() => {
                                pushChatMessage({
                                    sessionId: session.id,
                                    role: "user",
                                    content: `[我取消了语音通话]`,
                                });
                                onEnd();
                            }}
                            className="ui-call-btn ui-call-btn-danger"
                        >
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
                                <line x1="23" y1="1" x2="1" y2="23" />
                            </svg>
                        </button>
                    ) : (
                        /* ENDED state: show nothing, will auto-close */
                        <div className="ts-14 opacity-70">通话已结束</div>
                    )}
                </div>
            </div>

            {!androidTextInputOnly && showSttWarning && (
                <CallSttWarningDialog
                    onClose={() => setShowSttWarning(false)}
                    onNeverShow={handleNeverShowSttWarning}
                />
            )}

        </div>
    );
}
