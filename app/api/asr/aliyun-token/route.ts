// app/api/asr/aliyun-token/route.ts
//
// 阿里云智能语音交互 Token 代理。
// 官方口径：AccessKey 只放服务端，Token 由服务端调 CreateToken 换取，有效期 24h。
// 这里在模块级缓存 token，全站共用一个，过期前 5 分钟自动刷新，
// 避免每次识别都去阿里云换一次（CreateToken 有 QPS 限制）。
//
// 环境变量（Vercel → Settings → Environment Variables）：
//   ALIYUN_AK_ID      阿里云 RAM AccessKeyId
//   ALIYUN_AK_SECRET  阿里云 RAM AccessKeySecret
// 未配置时返回 501，前端会提示"未配置阿里云密钥"并回落到旧的识别通道。

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CachedToken = { token: string; expireTime: number };

// 模块级缓存：Vercel 同一个实例内复用；实例冷启动会重新换一次，代价可忽略
let cached: CachedToken | null = null;
let inflight: Promise<CachedToken> | null = null;

/** 提前 5 分钟视为过期，避免卡片过期瞬间的边界失败 */
const REFRESH_MARGIN_SEC = 5 * 60;

function percentEncode(value: string): string {
    return encodeURIComponent(value)
        .replace(/\+/g, "%20")
        .replace(/\*/g, "%2A")
        .replace(/%7E/g, "~");
}

/** 阿里云 RPC 签名（HMAC-SHA1），签名规格见官方文档 */
async function signRpc(params: Record<string, string>, secret: string): Promise<string> {
    const canonical = Object.keys(params)
        .sort()
        .map(key => `${percentEncode(key)}=${percentEncode(params[key])}`)
        .join("&");
    const stringToSign = `GET&${percentEncode("/")}&${percentEncode(canonical)}`;
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(`${secret}&`),
        { name: "HMAC", hash: "SHA-1" },
        false,
        ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(stringToSign));
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

async function createToken(akId: string, akSecret: string): Promise<CachedToken> {
    const params: Record<string, string> = {
        AccessKeyId: akId,
        Action: "CreateToken",
        Format: "JSON",
        RegionId: "cn-shanghai",
        SignatureMethod: "HMAC-SHA1",
        SignatureNonce: crypto.randomUUID(),
        SignatureVersion: "1.0",
        Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        Version: "2019-02-28",
    };
    const signature = await signRpc(params, akSecret);
    const query = Object.keys(params)
        .sort()
        .map(key => `${percentEncode(key)}=${percentEncode(params[key])}`)
        .join("&");
    const url = `https://nls-meta.cn-shanghai.aliyuncs.com/?Signature=${percentEncode(signature)}&${query}`;

    const res = await fetch(url, { method: "GET", cache: "no-store" });
    const data = await res.json().catch(() => null) as {
        Token?: { Id?: string; ExpireTime?: number };
        Code?: string;
        Message?: string;
    } | null;

    const id = data?.Token?.Id;
    const expireTime = data?.Token?.ExpireTime;
    if (!res.ok || !id || !expireTime) {
        throw new Error(data?.Message || data?.Code || `阿里云 CreateToken 失败（HTTP ${res.status}）`);
    }
    return { token: id, expireTime };
}

export async function GET() {
    const akId = process.env.ALIYUN_AK_ID?.trim();
    const akSecret = process.env.ALIYUN_AK_SECRET?.trim();
    if (!akId || !akSecret) {
        return NextResponse.json(
            { error: "服务端未配置 ALIYUN_AK_ID / ALIYUN_AK_SECRET" },
            { status: 501 },
        );
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (cached && cached.expireTime - REFRESH_MARGIN_SEC > nowSec) {
        return NextResponse.json({ token: cached.token, expireTime: cached.expireTime });
    }

    try {
        // 并发去重：同时来多个请求只换一次
        if (!inflight) {
            inflight = createToken(akId, akSecret).finally(() => { inflight = null; });
        }
        const fresh = await inflight;
        cached = fresh;
        return NextResponse.json({ token: fresh.token, expireTime: fresh.expireTime });
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : "获取阿里云 Token 失败" },
            { status: 502 },
        );
    }
}
