"use client";

/**
 * 版本弹窗（常驻显示）。
 *
 * 每次进入 float 都弹出，展示最近的更新和当前构建 commit。
 * 便于随时核对线上部署的是哪个 commit（和 Vercel 部署记录对照）。
 * 点「知道了」或遮罩关闭。
 */

import { useEffect, useState } from "react";

import { BUILD_INFO } from "@/lib/build-info";

const SEEN_BUILD_KEY = "ai_phone_seen_build_version_v1";

export function BuildInfoPopup() {
    const [open, setOpen] = useState(false);

    useEffect(() => {
        if (typeof window === "undefined") return;
        let seen = "";
        try { seen = localStorage.getItem(SEEN_BUILD_KEY) || ""; } catch { /* ignore */ }
        // 有新版本才弹；但 commit 对不上本地记录时也弹（说明重新部署了）
        if (seen !== `${BUILD_INFO.version}@${BUILD_INFO.commit}`) setOpen(true);
    }, []);

    const close = () => {
        try { localStorage.setItem(SEEN_BUILD_KEY, `${BUILD_INFO.version}@${BUILD_INFO.commit}`); } catch { /* ignore */ }
        setOpen(false);
    };

    if (!open) return null;

    return (
        <div
            className="fixed inset-0 z-[9999] flex items-center justify-center"
            style={{ background: "rgba(15,23,42,0.42)", backdropFilter: "blur(2px)" }}
            onClick={close}
        >
            <div
                className="w-[86%] max-w-sm rounded-2xl p-5"
                style={{ background: "var(--c-panel, #fff)", border: "1px solid var(--c-panel-border, #e5e7eb)" }}
                onClick={(e) => e.stopPropagation()}
            >
                <p className="ts-11 mb-1" style={{ color: "var(--c-text, #94a3b8)" }}>float · 本次更新</p>

                {BUILD_INFO.entries.slice(0, 2).map((entry) => (
                    <div key={entry.version} className="mb-3">
                        <p className="ts-14 font-semibold mb-1" style={{ color: "var(--c-text-title, #1e293b)" }}>
                            {entry.title}
                        </p>
                        <ul className="pl-4">
                            {entry.items.map((item, i) => (
                                <li key={i} className="ts-12 leading-relaxed" style={{ color: "var(--c-text, #64748b)", listStyle: "disc" }}>
                                    {item}
                                </li>
                            ))}
                        </ul>
                    </div>
                ))}

                <p className="ts-10 mt-2" style={{ color: "var(--c-text, #94a3b8)", fontFamily: "ui-monospace, monospace" }}>
                    版本 {BUILD_INFO.version} · 构建 {BUILD_INFO.commit}
                </p>

                <button
                    className="mt-3 w-full rounded-xl py-2.5 ts-13 font-medium"
                    style={{ background: "var(--c-text-title, #1e293b)", color: "#fff" }}
                    onClick={close}
                >
                    知道了
                </button>
            </div>
        </div>
    );
}
