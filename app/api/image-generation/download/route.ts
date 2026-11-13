// app/api/image-generation/download/route.ts
// 只下载已经生成好的原图（不触发生图、不接收 API Key）。
// 客户端直连 CDN 被跨域/防盗链挡住时走这里，避免「重新生成 = 重复计费」。

import { NextRequest, NextResponse } from "next/server";
import { downloadGeneratedImage } from "@/lib/server-image-download";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const input = await request.json().catch(() => null);
  if (typeof input?.url !== "string" || input.url.length > 16000) {
    return NextResponse.json({ error: "缺少有效图片地址" }, { status: 400 });
  }
  try {
    const { bytes, mimeType } = await downloadGeneratedImage(
      input.url,
      AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]),
    );
    return new Response(bytes as BodyInit, {
      headers: { "Content-Type": mimeType, "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "原图下载失败" },
      { status: 502 },
    );
  }
}
