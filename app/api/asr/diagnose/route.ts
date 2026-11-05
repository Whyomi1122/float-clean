// app/api/asr/diagnose/route.ts
//
// 语音识别自检：在实机上点「通话诊断 D1 → 测语音识别」时调用。
// 只返回「是否配置 / 连通性 / 状态码 / 错误原文」，不返回任何密钥。

import { NextResponse } from "next/server";
import { AliyunConfigError, getAliyunToken } from "@/lib/aliyun-nls-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

export async function GET() {
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

    return NextResponse.json(report, { headers: { "cache-control": "no-store" } });
}
