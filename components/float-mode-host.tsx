"use client";

// 悬浮球模式宿主:根据 localStorage "ai_phone_float_mode" 决定渲染新版多功能悬浮球还是旧版音乐挂件。
// 旧版组件原封不动保留,随时可切回。

import { useEffect, useState } from "react";
import MusicFloat from "@/components/music/music-float";
import MultiFloatBall from "@/components/multi-float-ball";

type Mode = "ball" | "legacy";

const MODE_KEY = "ai_phone_float_mode";

export default function FloatModeHost({ hidden }: { hidden: boolean }) {
    const [mode, setMode] = useState<Mode | null>(null);

    useEffect(() => {
        const saved = localStorage.getItem(MODE_KEY) as Mode | null;
        setMode(saved ?? "ball");
    }, []);

    const switchMode = (m: Mode) => {
        localStorage.setItem(MODE_KEY, m);
        setMode(m);
    };

    if (mode === null) return null; // 首帧避免闪烁

    return mode === "legacy"
        ? <MusicFloat hidden={hidden} />
        : <MultiFloatBall hidden={hidden} onSwitchMode={switchMode} />;
}
