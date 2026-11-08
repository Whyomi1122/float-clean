"use client";

import { useEffect, useRef } from "react";

import { ambienceFilesOf, type AmbienceSceneId } from "@/lib/call-ambience";
import { recordCallDiagnostic } from "@/lib/call-diagnostics";

/** 用户按住说话时环境音自动压低到这个比例，避免麦克风把背景音收进识别 */
const DUCK_RATIO = 0.2;
/** 起停淡入淡出秒数，避免爆音 */
const FADE_SEC = 0.6;
/** 音量/ducking 的参数平滑时间常数 */
const DUCK_TAU = 0.12;
/** 解码后的 PCM 缓存条数（30s 单声道约 2.6MB，不许多留） */
const CACHE_LIMIT = 2;

const bufferCache = new Map<string, AudioBuffer>();
let sharedCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
    if (typeof window === "undefined") return null;
    if (sharedCtx && sharedCtx.state !== "closed") return sharedCtx;
    const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
        sharedCtx = new Ctor();
        return sharedCtx;
    } catch {
        return null;
    }
}

async function decodeUrl(ctx: AudioContext, url: string): Promise<AudioBuffer | null> {
    const cached = bufferCache.get(url);
    if (cached) return cached;
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const buf = await ctx.decodeAudioData(await res.arrayBuffer());
        if (bufferCache.size >= CACHE_LIMIT) {
            const oldest = bufferCache.keys().next().value;
            if (oldest) bufferCache.delete(oldest);
        }
        bufferCache.set(url, buf);
        return buf;
    } catch {
        return null;
    }
}

/** 按优先级探测候选音源，解不出就试下一个；全都没有返回 null（静默降级） */
async function loadFirstAvailable(ctx: AudioContext, urls: string[]): Promise<AudioBuffer | null> {
    for (const url of urls) {
        const buf = await decodeUrl(ctx, url);
        if (buf) return buf;
    }
    return null;
}

type CallAmbiencePlayerProps = {
    /** 是否应该出声：接通 + 扬声器开 + 通话页可见 */
    active: boolean;
    scene: AmbienceSceneId | "off";
    /** 0-1 */
    volume: number;
    /** 用户正在说话（按住说话 / 录音中） */
    ducked?: boolean;
};

/**
 * 环境音循环播放器：走 Web Audio（decodeAudioData + AudioBufferSourceNode.loop），
 * 循环点是解码后 PCM 的采样级首尾相接，不受容器格式的编码填充影响。
 * 音源缺失（public/ambience 里没放文件）或自动播放被拦时静默降级，不影响通话。
 */
export function CallAmbiencePlayer({ active, scene, volume, ducked = false }: CallAmbiencePlayerProps) {
    const gainRef = useRef<GainNode | null>(null);
    const sourceRef = useRef<AudioBufferSourceNode | null>(null);
    const ctxRef = useRef<AudioContext | null>(null);
    const tokenRef = useRef(0);
    const targetVolume = Math.min(1, Math.max(0, volume)) * (ducked ? DUCK_RATIO : 1);
    const targetRef = useRef(targetVolume);
    targetRef.current = targetVolume;

    // 开关 / 换场景
    useEffect(() => {
        if (typeof window === "undefined") return;
        const urls = ambienceFilesOf(scene);
        const ctx = active && urls.length > 0 ? getAudioContext() : null;
        const token = ++tokenRef.current;

        // 先把上一条淡出丢掉，避免接缝处爆音
        const prevSource = sourceRef.current;
        const prevGain = gainRef.current;
        const prevCtx = ctxRef.current;
        sourceRef.current = null;
        gainRef.current = null;
        if (prevSource && prevGain && prevCtx) {
            const now = prevCtx.currentTime;
            try {
                prevGain.gain.cancelScheduledValues(now);
                prevGain.gain.setValueAtTime(prevGain.gain.value, now);
                prevGain.gain.linearRampToValueAtTime(0, now + FADE_SEC);
                prevSource.stop(now + FADE_SEC + 0.05);
            } catch {
                try {
                    prevSource.stop();
                } catch {
                    /* 已停止 */
                }
            }
        }

        if (!ctx) return;
        ctxRef.current = ctx;
        // 通话按钮链路上已经是用户手势，这里可以直接尝试解锁
        if (ctx.state === "suspended") void ctx.resume().catch(() => {});
        recordCallDiagnostic(`环境音 ${scene}：ctx=${ctx.state} 候选 ${urls.length} 个`);

        let cancelled = false;
        void (async () => {
            const buffer = await loadFirstAvailable(ctx, urls);
            if (cancelled || tokenRef.current !== token || !buffer) {
                if (!buffer) recordCallDiagnostic(`环境音 ${scene}：音源缺失或解码失败（试过 ${urls.length} 个后缀）`);
                return;
            }
            if (ctx.state === "suspended") await ctx.resume().catch(() => {});
            const src = ctx.createBufferSource();
            src.buffer = buffer;
            src.loop = true;
            const gain = ctx.createGain();
            const now = ctx.currentTime;
            gain.gain.setValueAtTime(0, now);
            gain.gain.linearRampToValueAtTime(targetRef.current, now + FADE_SEC);
            src.connect(gain);
            gain.connect(ctx.destination);
            src.start(now);
            sourceRef.current = src;
            gainRef.current = gain;
            recordCallDiagnostic(
                `环境音 ${scene}：已播放 ${buffer.duration.toFixed(1)}s / 音量 ${Math.round(targetRef.current * 100)}% / ctx=${ctx.state}`
            );
        })();

        return () => {
            cancelled = true;
        };
    }, [active, scene]);

    // 音量 / ducking 实时生效，平滑过渡，不重启播放
    useEffect(() => {
        const gain = gainRef.current;
        const ctx = ctxRef.current;
        if (!gain || !ctx) return;
        const now = ctx.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.setTargetAtTime(targetVolume, now, DUCK_TAU);
    }, [targetVolume]);

    // 移动端自动播放策略：AudioContext 可能挂在 suspended，任意一次点击就解锁
    useEffect(() => {
        if (!active) return;
        const unlock = () => {
            const ctx = ctxRef.current;
            if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => {});
        };
        document.addEventListener("pointerdown", unlock);
        return () => document.removeEventListener("pointerdown", unlock);
    }, [active]);

    // 卸载清理
    useEffect(() => () => {
        tokenRef.current += 1;
        const src = sourceRef.current;
        const ctx = ctxRef.current;
        sourceRef.current = null;
        gainRef.current = null;
        ctxRef.current = null;
        try {
            src?.stop();
        } catch {
            /* 已停止 */
        }
        if (ctx && sharedCtx === ctx) {
            sharedCtx = null;
            void ctx.close().catch(() => {});
        }
    }, []);

    return null;
}
