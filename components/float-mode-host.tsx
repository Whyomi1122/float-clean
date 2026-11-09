"use client";

// 悬浮球宿主:始终渲染新版多功能悬浮球。
// 旧版 music-float 组件保留在代码库中但不再启用。
// 2026-11-09：一起听改成"聊天室里的状态"，不再需要知道当前所在 App（去掉 currentApp）。

import MultiFloatBall from "@/components/multi-float-ball";

export default function FloatModeHost({ hidden }: { hidden: boolean }) {
    return <MultiFloatBall hidden={hidden} />;
}
