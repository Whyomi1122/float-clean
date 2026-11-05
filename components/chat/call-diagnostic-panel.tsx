"use client";

import { useEffect, useState } from "react";
import { enableCallDiagnostics, disableCallDiagnostics, getCallDiagnostics, recordCallDiagnostic, subscribeCallDiagnostics } from "@/lib/call-diagnostics";
import { playAudioBlob, resolveVoiceConfig, synthesizeSpeech, unlockAudioPlayback } from "@/lib/tts-service";
import * as buildInfo from "@/lib/build-info";

export function CallDiagnosticPanel({ characterId }: { characterId?: string }) {
    const [open, setOpen] = useState(false);
    const [report, setReport] = useState("");
    const [copied, setCopied] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);

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

    /** ① 语音合成 + 播放自检：定位「角色没声音」到底卡在哪一步 */
    const runTtsTest = async () => {
        if (busy) return;
        setBusy("tts");
        try {
            unlockAudioPlayback();
            recordCallDiagnostic("— 语音合成自检开始 —");
            const config = resolveVoiceConfig(characterId || "chat");
            if (!config) {
                recordCallDiagnostic("✗ 未找到语音配置：角色没绑定语音（角色设置 → 语音）");
                return;
            }
            recordCallDiagnostic(`配置：${JSON.stringify(config).replace(/(key|token|secret)[^,}]*/gi, "$1:***").slice(0, 200)}`);
            const started = Date.now();
            const blob = await synthesizeSpeech("测试语音，一二三四五。", config);
            recordCallDiagnostic(`合成完成 ${Date.now() - started}ms · ${blob ? `${blob.size} 字节 · ${blob.type}` : "空音频"}`);
            if (!blob || blob.size < 1000) {
                recordCallDiagnostic("✗ 合成返回空/过小音频，检查音色 ID、模型、额度");
                return;
            }
            recordCallDiagnostic("开始播放（请确认媒体音量为非 0）…");
            const { promise } = playAudioBlob(blob);
            await promise;
            recordCallDiagnostic("✓ 播放流程走完：若此刻没听到声音，就是设备静音/媒体音量/系统播放通道问题");
        } catch (e) {
            recordCallDiagnostic(`✗ 合成或播放失败：${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setBusy(null);
        }
    };

    /** ② 语音识别自检：服务端配置 + 阿里云连通性 + 本机麦克风 */
    const runSttTest = async () => {
        if (busy) return;
        setBusy("stt");
        try {
            recordCallDiagnostic("— 语音识别自检开始 —");
            try {
                const res = await fetch("/api/asr/diagnose", { cache: "no-store" });
                const data = await res.json();
                const env = data?.env || {};
                recordCallDiagnostic(`服务端 AK：id=${env.hasAkId ? "有" : "缺"} secret=${env.hasAkSecret ? "有" : "缺"} tail=${env.akIdTail || "-"} region=${data?.region || "-"}`);
                recordCallDiagnostic(`Token：${data?.token?.ok ? `✓ ${data.token.ms}ms` : `✗ ${data?.token?.error || "未知"}`}`);
                for (const p of data?.probes || []) {
                    recordCallDiagnostic(`连通性 ${p.url} → ${p.ok ? `✓ ${p.status}` : `✗ ${p.error || p.status}`} (${p.ms}ms)${p.cause ? ` cause=${p.cause}` : ""}`);
                }
            } catch (e) {
                recordCallDiagnostic(`✗ /api/asr/diagnose 请求失败：${e instanceof Error ? e.message : String(e)}（部署未更新或路由报错）`);
            }
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                const track = stream.getAudioTracks()[0];
                const settings = (track.getSettings ? track.getSettings() : {}) as MediaTrackSettings;
                recordCallDiagnostic(`麦克风：${track.label || "未知设备"} · ${settings.sampleRate || "?"}Hz · 状态 ${track.readyState}`);
                stream.getTracks().forEach(t => t.stop());
            } catch (e) {
                const err = e as { name?: string; message?: string };
                recordCallDiagnostic(`✗ 麦克风失败：${err?.name || ""} ${err?.message || String(e)}`);
            }
        } finally {
            setBusy(null);
        }
    };

    return <div style={{ padding: "4px 20px", textAlign: "center", fontSize: 12 }}>
        <button type="button" onClick={() => setOpen(value => !value)} style={{ opacity: .75, padding: "6px 12px" }}>通话诊断 D1{open ? " · 收起" : ""}</button>
        {open && <div style={{ borderRadius: 14, padding: 12, background: "var(--background, #f7f7f7)", color: "var(--foreground, #333)", textAlign: "left", maxHeight: "42dvh", overflow: "auto", position: "relative", zIndex: 30 }}>
            <p style={{ marginBottom: 8 }}>先点两个自检按钮，再照常发一句话；报告里只记配置概况和状态，不含密钥与正文。</p>
            <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                <button type="button" disabled={busy === "tts"} onClick={runTtsTest} style={{ padding: "8px 12px", borderRadius: 10, background: "rgba(0,0,0,.06)" }}>
                    {busy === "tts" ? "测语音合成…" : "测语音合成"}
                </button>
                <button type="button" disabled={busy === "stt"} onClick={runSttTest} style={{ padding: "8px 12px", borderRadius: 10, background: "rgba(0,0,0,.06)" }}>
                    {busy === "stt" ? "测语音识别…" : "测语音识别"}
                </button>
            </div>
            <textarea aria-label="通话诊断报告" readOnly value={report} onFocus={event => event.currentTarget.select()} style={{ width: "100%", height: 150, fontSize: 11, background: "transparent", color: "inherit", wordBreak: "break-all" }} />
            <button type="button" onClick={async () => {
                try { await navigator.clipboard.writeText(report); setCopied(true); }
                catch { setCopied(false); }
            }} style={{ padding: "8px 12px" }}>{copied ? "已复制" : "复制报告（也可长按文本复制）"}</button>
        </div>}
    </div>;
}
