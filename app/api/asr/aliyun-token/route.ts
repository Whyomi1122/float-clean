// app/api/asr/aliyun-token/route.ts
//
// 阿里云智能语音交互 Token 代理。
// 官方口径：AccessKey 只放服务端，Token 由服务端调 CreateToken 换取，有效期 24h。
// 具体签名与缓存逻辑在 lib/aliyun-nls-server.ts（识别代理共用同一份缓存）。

import { NextResponse } from "next/server";
import { AliyunConfigError, getAliyunToken } from "@/lib/aliyun-nls-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
    try {
        const { token, expireTime } = await getAliyunToken();
        return NextResponse.json({ token, expireTime });
    } catch (err) {
        if (err instanceof AliyunConfigError) {
            return NextResponse.json({ error: err.message }, { status: 501 });
        }
        return NextResponse.json(
            { error: err instanceof Error ? err.message : "获取阿里云 Token 失败" },
            { status: 502 },
        );
    }
}
