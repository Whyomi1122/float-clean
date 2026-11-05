// app/api/asr/diagnose/route.ts
//
// 语音识别自检：在实机上点「通话诊断 D1 → 测语音识别」时调用。
// 只返回「是否配置 / 连通性 / 状态码 / 错误原文」，不返回任何密钥。

import { NextResponse } from "next/server";
import { AliyunConfigError, getAliyunToken } from "@/lib/aliyun-nls-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 自检要跑 Token + 连通性 + 端到端识别，给足时间
export const maxDuration = 60;

const TOKEN_ENDPOINT = "https://nls-meta.cn-shanghai.aliyuncs.com/";
const ASR_ENDPOINT = "https://nls-gateway-cn-shanghai.aliyuncs.com/stream/v1/asr";

async function probe(url: string, init?: RequestInit) {
    const started = Date.now();
    try {
        const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
        const body = await res.text().catch(() => "");
        return {
            url,
            ok: res.ok,
            status: res.status,
            ms: Date.now() - started,
            body: body.slice(0, 240),
        };
    } catch (e: unknown) {
        const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
        return {
            url,
            ok: false,
            ms: Date.now() - started,
            error: `${err?.name || "Error"}: ${err?.message || String(e)}`,
            cause: err?.cause?.code || err?.cause?.message || null,
        };
    }
}

export async function GET(request: Request) {
    const appkey = new URL(request.url).searchParams.get("appkey")?.trim() || "";
    const akId = process.env.ALIYUN_AK_ID?.trim() || "";
    const akSecret = process.env.ALIYUN_AK_SECRET?.trim() || "";

    const report: Record<string, unknown> = {
        time: new Date().toISOString(),
        region: process.env.VERCEL_REGION || "(local)",
        env: {
            hasAkId: Boolean(akId),
            hasAkSecret: Boolean(akSecret),
            akIdTail: akId ? akId.slice(-4) : "",
        },
        token: null,
        probes: [] as unknown[],
    };

    // 1) 项目自己的 CreateToken 逻辑（真实调用）
    const tokenStarted = Date.now();
    try {
        const { expireTime } = await getAliyunToken();
        report.token = { ok: true, ms: Date.now() - tokenStarted, expireTime };
    } catch (e) {
        if (e instanceof AliyunConfigError) {
            report.token = { ok: false, ms: Date.now() - tokenStarted, error: e.message, kind: "config" };
        } else {
            report.token = {
                ok: false,
                ms: Date.now() - tokenStarted,
                error: e instanceof Error ? e.message : String(e),
                kind: "unknown",
            };
        }
    }

    // 2) 直连阿里云两个域名的连通性（这一步失败基本就是网络/DNS 问题）
    report.probes = [
        await probe(TOKEN_ENDPOINT),
        await probe(ASR_ENDPOINT, { method: "GET" }),
    ];

    // 3) 真实跑一次一句话识别（1 秒静音 WAV）：验证「服务端 → 阿里云识别接口」整条链路
    if (appkey) {
        const started = Date.now();
        try {
            const { recognizeShortSpeech } = await import("@/lib/aliyun-nls-server");
            const result = await recognizeShortSpeech(silentWav(1), appkey);
            report.transcribe = {
                ok: true,
                ms: Date.now() - started,
                result: result || "(静音，识别为空属正常)",
            };
        } catch (e) {
            const cause = (e as { cause?: { code?: string; message?: string } } | null)?.cause;
            report.transcribe = {
                ok: false,
                ms: Date.now() - started,
                error: e instanceof Error ? e.message : String(e),
                cause: cause?.code || cause?.message || null,
            };
        }
    } else {
        report.transcribe = { skipped: "未提供 appkey，跳过真实识别测试" };
    }

    return NextResponse.json(report, { headers: { "cache-control": "no-store" } });
}

/** 生成 N 秒 16k/16bit 单声道静音 WAV */
function silentWav(seconds: number): ArrayBuffer {
    const sampleRate = 16000;
    const samples = Math.floor(sampleRate * seconds);
    const buffer = new ArrayBuffer(44 + samples * 2);
    const view = new DataView(buffer);
    const write = (offset: number, text: string) => {
        for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
    };
    write(0, "RIFF");
    view.setUint32(4, 36 + samples * 2, true);
    write(8, "WAVE");
    write(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    write(36, "data");
    view.setUint32(40, samples * 2, true);
    return buffer;
}
