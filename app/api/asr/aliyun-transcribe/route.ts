// app/api/asr/aliyun-transcribe/route.ts
//
// 阿里云一句话识别代理。
// 为什么需要代理：浏览器直连 nls-gateway 会被 CORS 拦（阿里云不返回 CORS 头），
// 前端会看到 "Failed to fetch"。改由服务端转发，同源调用，彻底避开 CORS。
//
// 请求：POST /api/asr/aliyun-transcribe?appkey=xxx
//       body = 16k 单声道 WAV 二进制
// 响应：{ text: "识别结果" }

import { NextResponse } from "next/server";
import { AliyunConfigError, recognizeShortSpeech } from "@/lib/aliyun-nls-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 一句话识别单段 ≤60s，16k 单声道 WAV 约 1.9MB，留足余量
export const maxDuration = 60;

export async function POST(request: Request) {
    const appKey = new URL(request.url).searchParams.get("appkey")?.trim();
    if (!appKey) {
        return NextResponse.json({ error: "缺少 appkey 参数" }, { status: 400 });
    }

    let audio: ArrayBuffer;
    try {
        audio = await request.arrayBuffer();
    } catch {
        return NextResponse.json({ error: "读取音频数据失败" }, { status: 400 });
    }
    if (audio.byteLength < 1000) {
        return NextResponse.json({ error: "音频太短，请按住说话再松手" }, { status: 400 });
    }

    try {
        const text = await recognizeShortSpeech(audio, appKey);
        return NextResponse.json({ text });
    } catch (err) {
        if (err instanceof AliyunConfigError) {
            return NextResponse.json({ error: err.message }, { status: 501 });
        }
        return NextResponse.json(
            { error: err instanceof Error ? err.message : "阿里云识别失败" },
            { status: 502 },
        );
    }
}
