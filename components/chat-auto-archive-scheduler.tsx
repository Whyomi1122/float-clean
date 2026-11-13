"use client";

// 后台自动归档的定时器 + 结果 toast。
// 挂在桌面壳根部：不管用户停在哪个 App，归档跑完都能看见「【已生成】」。

import { useEffect, useRef, useState } from "react";
import {
    CHAT_AUTO_ARCHIVE_EVENT,
    runChatAutoArchive,
    type ChatAutoArchiveDetail,
} from "@/lib/chat-auto-archive";

const TICK_MS = 3 * 60 * 1000;
const FIRST_TICK_MS = 90 * 1000;

type ToastEntry = { id: number; text: string };

export function ChatAutoArchiveScheduler() {
    const [toasts, setToasts] = useState<ToastEntry[]>([]);
    const seq = useRef(0);

    useEffect(() => {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const tick = async () => {
            if (stopped) return;
            try {
                await runChatAutoArchive();
            } catch { /* 后台失败不打扰用户 */ }
            if (!stopped) timer = setTimeout(tick, TICK_MS);
        };

        timer = setTimeout(() => { void tick(); }, FIRST_TICK_MS);
        return () => {
            stopped = true;
            if (timer) clearTimeout(timer);
        };
    }, []);

    useEffect(() => {
        const timers: ReturnType<typeof setTimeout>[] = [];
        const onDone = (event: Event) => {
            const detail = (event as CustomEvent<ChatAutoArchiveDetail>).detail;
            if (!detail?.characterName) return;
            const id = ++seq.current;
            const text = detail.updated
                ? `【已生成】${detail.characterName} · 归档已更新`
                : `【已生成】${detail.characterName} · 归档已建立`;
            setToasts(prev => [...prev, { id, text }].slice(-2));
            timers.push(setTimeout(() => {
                setToasts(prev => prev.filter(item => item.id !== id));
            }, 4000));
        };
        window.addEventListener(CHAT_AUTO_ARCHIVE_EVENT, onDone);
        return () => {
            window.removeEventListener(CHAT_AUTO_ARCHIVE_EVENT, onDone);
            for (const t of timers) clearTimeout(t);
        };
    }, []);

    if (toasts.length === 0) return null;
    return (
        <div
            style={{
                position: "fixed",
                left: "50%",
                top: "calc(env(safe-area-inset-top, 0px) + 44px)",
                transform: "translateX(-50%)",
                zIndex: 3000,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 6,
                pointerEvents: "none",
            }}
        >
            {toasts.map(item => (
                <div className="wp-toast" style={{ position: "static" }} key={item.id}>{item.text}</div>
            ))}
        </div>
    );
}
