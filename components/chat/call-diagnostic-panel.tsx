"use client";

import { useEffect, useState } from "react";
import { enableCallDiagnostics, disableCallDiagnostics, getCallDiagnostics, subscribeCallDiagnostics } from "@/lib/call-diagnostics";
import * as buildInfo from "@/lib/build-info";

export function CallDiagnosticPanel() {
    const [open, setOpen] = useState(false);
    const [report, setReport] = useState("");
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        enableCallDiagnostics();
        const update = () => setReport([
            "float 手机通话诊断 · D1",
            JSON.stringify(buildInfo),
            `浏览器：${navigator.userAgent}`,
            ...getCallDiagnostics().map(entry => `${entry.time} ${entry.detail}`),
        ].join("\n"));
        update();
        const unsubscribe = subscribeCallDiagnostics(update);
        return () => { unsubscribe(); disableCallDiagnostics(); };
    }, []);
    return <div style={{ padding: "4px 20px", textAlign: "center", fontSize: 12 }}>
        <button type="button" onClick={() => setOpen(value => !value)} style={{ opacity: .75, padding: "6px 12px" }}>通话诊断 D1{open ? " · 收起" : ""}</button>
        {open && <div style={{ borderRadius: 14, padding: 12, background: "var(--background, #f7f7f7)", color: "var(--foreground, #333)", textAlign: "left", maxHeight: "35dvh", overflow: "auto", position: "relative", zIndex: 30 }}>
            <p>展开后照常发一句话，再复制报告。只记录请求地址、模型、状态和字数，不记录密钥或聊天正文。</p>
            <textarea aria-label="通话诊断报告" readOnly value={report} onFocus={event => event.currentTarget.select()} style={{ width: "100%", height: 120, fontSize: 11, background: "transparent", color: "inherit", wordBreak: "break-all" }} />
            <button type="button" onClick={async () => {
                try { await navigator.clipboard.writeText(report); setCopied(true); }
                catch { setCopied(false); }
            }} style={{ padding: "8px 12px" }}>{copied ? "已复制" : "复制报告（也可长按文本复制）"}</button>
        </div>}
    </div>;
}
