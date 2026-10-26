"use client";

// 悬浮球宿主:始终渲染新版多功能悬浮球。
// 旧版 music-float 组件保留在代码库中但不再启用。

import MultiFloatBall from "@/components/multi-float-ball";

export default function FloatModeHost({ hidden }: { hidden: boolean }) {
    return <MultiFloatBall hidden={hidden} />;
}
