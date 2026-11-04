"use client";

// 通话「按住说话」共享逻辑（非 iOS 通话输入方案，三个通话界面共用）。
// 按下开始录音，松开停止并送云端转写，太短视为误触直接丢弃。
// 卸载时自动取消录音并释放麦克风。

import { useCallback, useEffect, useRef, useState } from "react";
import {
    resolveCloudSttConfig,
    startCallRecording,
    transcribeAudioBlob,
    type ActiveCallRecording,
} from "@/lib/stt-cloud";
import {
    isStreamingSttSupported,
    startAliyunStreamingStt,
    type ActiveStreamingStt,
} from "@/lib/aliyun-streaming-stt";

export type HoldToTalkRecState = "idle" | "recording" | "transcribing";

const MIN_RECORDING_MS = 400;

export type HoldToTalkOptions = {
    /** 用于按角色绑定解析识别配置 */
    characterId?: string;
    /** 当前是否允许开始录音（如通话状态是否 IDLE） */
    canStart: () => boolean;
    /** 录音真正开始（麦克风已打开） */
    onRecordingStart?: () => void;
    /** 松手后进入转写阶段 */
    onTranscribeStart?: () => void;
    /** 转写成功，text 非空 */
    onTranscript: (text: string) => void;
    /** 录音/转写失败或被丢弃（太短、没声音）。UI 应回到待命态 */
    onError?: (message: string) => void;
    /** 流式识别的实时中间结果（边说话边上屏）；不传则只走松手后的一次性结果 */
    onPartial?: (text: string) => void;
};

export type HoldToTalkHandle = {
    recState: HoldToTalkRecState;
    error: string;
    /** 采集音量 0..1（流式识别时实时更新，供波形 UI） */
    level: number;
    /** 铺到按钮上的指针事件（含防止长按弹菜单） */
    pressHandlers: {
        onPointerDown: (e: React.PointerEvent) => void;
        onPointerUp: (e: React.PointerEvent) => void;
        onPointerCancel: (e: React.PointerEvent) => void;
        onContextMenu: (e: React.MouseEvent) => void;
    };
};

export function useHoldToTalk(options: HoldToTalkOptions): HoldToTalkHandle {
    const [recState, setRecState] = useState<HoldToTalkRecState>("idle");
    const [error, setError] = useState("");
    const [level, setLevel] = useState(0);
    const recordingRef = useRef<ActiveCallRecording | null>(null);
    const streamingRef = useRef<ActiveStreamingStt | null>(null);
    const streamingErrorRef = useRef("");
    const startedAtRef = useRef(0);
    const startingRef = useRef(false);
    const mountedRef = useRef(true);
    const optionsRef = useRef(options);
    optionsRef.current = options;

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            recordingRef.current?.cancel();
            recordingRef.current = null;
            streamingRef.current?.cancel();
            streamingRef.current = null;
        };
    }, []);

    const fail = useCallback((message: string) => {
        if (!mountedRef.current) return;
        setRecState("idle");
        setError(message);
        optionsRef.current.onError?.(message);
    }, []);

    const handlePress = useCallback(async () => {
        if (startingRef.current || recordingRef.current || streamingRef.current) return;
        if (!optionsRef.current.canStart()) return;
        setError("");
        startingRef.current = true;
        const config = resolveCloudSttConfig(optionsRef.current.characterId);

        // 档 2：阿里云实时流式——随说随识别。失败或环境不支持则回退一句话识别。
        if (config?.provider === "aliyun" && config.aliyunAppKey && isStreamingSttSupported()) {
            try {
                const streaming = await startAliyunStreamingStt(config.aliyunAppKey, {
                    onPartial: (text) => { optionsRef.current.onPartial?.(text); },
                    onLevel: (level) => { setLevel(level); },
                    onError: (message) => { streamingErrorRef.current = message; },
                });
                startingRef.current = false;
                if (!mountedRef.current) { streaming.cancel(); return; }
                streamingRef.current = streaming;
                streamingErrorRef.current = "";
                startedAtRef.current = Date.now();
                setRecState("recording");
                optionsRef.current.onRecordingStart?.();
                return;
            } catch (e) {
                // 连接失败：不打断用户，直接走一句话识别
                streamingErrorRef.current = e instanceof Error ? e.message : String(e);
            }
        }

        try {
            const recording = await startCallRecording();
            startingRef.current = false;
            if (!mountedRef.current) { recording.cancel(); return; }
            recordingRef.current = recording;
            startedAtRef.current = Date.now();
            setRecState("recording");
            optionsRef.current.onRecordingStart?.();
        } catch (e) {
            startingRef.current = false;
            fail(e instanceof Error ? e.message : String(e));
        }
    }, [fail]);

    const handleRelease = useCallback(async () => {
        // 流式：松手即收尾，文本已经在 partial 里了
        const streaming = streamingRef.current;
        if (streaming) {
            streamingRef.current = null;
            const heldMs = Date.now() - startedAtRef.current;
            setLevel(0);
            if (heldMs < MIN_RECORDING_MS) {
                streaming.cancel();
                fail("说话时间太短，请按住说完再松开");
                return;
            }
            setRecState("transcribing");
            optionsRef.current.onTranscribeStart?.();
            try {
                const text = await streaming.stop();
                if (!mountedRef.current) return;
                setRecState("idle");
                const finalText = text.trim() || streamingErrorRef.current;
                if (!text.trim()) { fail(streamingErrorRef.current || "没有识别到内容"); return; }
                setError("");
                optionsRef.current.onTranscript(finalText);
            } catch (e) {
                fail(e instanceof Error ? e.message : String(e));
            }
            return;
        }

        const recording = recordingRef.current;
        if (!recording) return;
        recordingRef.current = null;

        const heldMs = Date.now() - startedAtRef.current;
        if (heldMs < MIN_RECORDING_MS) {
            recording.cancel();
            fail("说话时间太短，请按住说完再松开");
            return;
        }

        setRecState("transcribing");
        optionsRef.current.onTranscribeStart?.();
        try {
            const blob = await recording.stop();
            if (!blob) { fail("没有录到声音"); return; }
            const config = resolveCloudSttConfig(optionsRef.current.characterId);
            if (!config) { fail("未找到可用的语音识别配置"); return; }
            const text = await transcribeAudioBlob(blob, config);
            if (!mountedRef.current) return;
            setRecState("idle");
            if (!text.trim()) { fail("没有识别到内容"); return; }
            setError("");
            optionsRef.current.onTranscript(text.trim());
        } catch (e) {
            fail(e instanceof Error ? e.message : String(e));
        }
    }, [fail]);

    return {
        recState,
        error,
        level,
        pressHandlers: {
            onPointerDown: (e) => {
                e.preventDefault();
                try { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
                void handlePress();
            },
            onPointerUp: (e) => {
                e.preventDefault();
                void handleRelease();
            },
            onPointerCancel: (e) => {
                e.preventDefault();
                void handleRelease();
            },
            onContextMenu: (e) => { e.preventDefault(); },
        },
    };
}
