"use client";

import { useEffect, useRef } from "react";

import { ambienceFileOf, type AmbienceSceneId } from "@/lib/call-ambience";

/** 用户按住说话时环境音自动压低到这个比例，避免麦克风把背景音收进识别 */
const DUCK_RATIO = 0.2;

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
 * 环境音循环播放器：独立 <audio>，浏览器自动与角色人声混音。
 * 音源缺失（public/ambience 里没放文件）或浏览器拦截自动播放时静默降级。
 */
export function CallAmbiencePlayer({ active, scene, volume, ducked = false }: CallAmbiencePlayerProps) {
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const srcRef = useRef<string>("");
    const src = ambienceFileOf(scene);
    const targetVolume = Math.min(1, Math.max(0, volume)) * (ducked ? DUCK_RATIO : 1);

    // 开关 / 换场景
    useEffect(() => {
        if (typeof window === "undefined") return;
        if (!active || !src) {
            const el = audioRef.current;
            if (el) el.pause();
            return;
        }
        let el = audioRef.current;
        if (!el) {
            el = new Audio();
            el.loop = true;
            el.preload = "auto";
            el.volume = targetVolume;
            audioRef.current = el;
        }
        if (srcRef.current !== src) {
            srcRef.current = src;
            el.src = src;
            try {
                el.currentTime = 0;
            } catch {
                /* 未加载完成时忽略 */
            }
        }
        el.play().catch(() => {
            /* 文件缺失或需要用户手势，静默忽略 */
        });
        // targetVolume 只在这里做首帧赋值，后续由下面的 effect 实时同步
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, src]);

    // 音量 / ducking 实时生效，不重启播放
    useEffect(() => {
        const el = audioRef.current;
        if (el) el.volume = targetVolume;
    }, [targetVolume]);

    // 卸载清理
    useEffect(() => () => {
        const el = audioRef.current;
        if (el) {
            el.pause();
            el.src = "";
        }
        audioRef.current = null;
        srcRef.current = "";
    }, []);

    return null;
}
