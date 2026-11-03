/**
 * 阿里云智能语音交互 · 服务端封装（只能在服务端 import）
 *
 * 为什么要有这个文件：
 *   1. AccessKey 必须留在服务端（官方安全规范，不能进前端/移动端）
 *   2. 浏览器直连 nls-gateway 会被 CORS 拦（阿里云不返回 CORS 头），
 *      所以识别请求也要走我们自己的 API 路由代理
 *
 * 环境变量：ALIYUN_AK_ID / ALIYUN_AK_SECRET
 */

type CachedToken = { token: string; expireTime: number };

let cached: CachedToken | null = null;
let inflight: Promise<CachedToken> | null = null;

/** 提前 5 分钟视为过期，避免边界失败 */
const REFRESH_MARGIN_SEC = 5 * 60;

const TOKEN_ENDPOINT = "https://nls-meta.cn-shanghai.aliyuncs.com/";
const ASR_ENDPOINT = "https://nls-gateway-cn-shanghai.aliyuncs.com/stream/v1/asr";

export const ALIYUN_ASR_ENDPOINT_LABEL = "nls-gateway-cn-shanghai";

export class AliyunConfigError extends Error {}

function percentEncode(value: string): string {
    return encodeURIComponent(value)
        .replace(/\+/g, "%20")
        .replace(/\*/g, "%2A")
        .replace(/%7E/g, "~");
}

/** 阿里云 RPC 签名（HMAC-SHA1） */
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

function readCredentials(): { akId: string; akSecret: string } {
    const akId = process.env.ALIYUN_AK_ID?.trim();
    const akSecret = process.env.ALIYUN_AK_SECRET?.trim();
    if (!akId || !akSecret) {
        throw new AliyunConfigError("服务端未配置 ALIYUN_AK_ID / ALIYUN_AK_SECRET");
    }
    return { akId, akSecret };
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
    const url = `${TOKEN_ENDPOINT}?Signature=${percentEncode(signature)}&${query}`;

    const res = await fetch(url, { method: "GET", cache: "no-store" });
    const responseBody = await res.text();
    const data = await Promise.resolve().then(() => JSON.parse(responseBody)).catch(() => null) as {
        Token?: { Id?: string; ExpireTime?: number };
        Code?: string;
        Message?: string;
    } | null;

    const id = data?.Token?.Id;
    const expireTime = data?.Token?.ExpireTime;
    if (!res.ok || !id || !expireTime) {
        // 保留上游错误码与完整响应，但不能把凭据或 Token 带回浏览器。
        let diagnostic = responseBody;
        for (const secret of [akId, akSecret, id]) {
            if (secret) diagnostic = diagnostic.split(secret).join("[REDACTED]");
        }
        throw new Error(`CreateToken 失败（HTTP ${res.status}，Code ${data?.Code ?? "未返回"}）：${diagnostic}`);
    }
    return { token: id, expireTime };
}

/** 取 Token（模块级缓存 + 并发去重 + 过期前刷新） */
export async function getAliyunToken(): Promise<CachedToken> {
    const { akId, akSecret } = readCredentials();
    const nowSec = Math.floor(Date.now() / 1000);
    if (cached && cached.expireTime - REFRESH_MARGIN_SEC > nowSec) {
        return cached;
    }
    if (!inflight) {
        inflight = createToken(akId, akSecret).finally(() => { inflight = null; });
    }
    cached = await inflight;
    return cached;
}

/**
 * 一句话识别：把 16k 单声道 WAV 交给阿里云，返回识别文本。
 * appkey 由调用方（前端）传入——它不是密钥，属于项目标识。
 */
export async function recognizeShortSpeech(audio: ArrayBuffer, appKey: string): Promise<string> {
    if (!appKey.trim()) {
        throw new Error("缺少阿里云项目 appkey");
    }
    const { token } = await getAliyunToken();
    const url = `${ASR_ENDPOINT}?appkey=${encodeURIComponent(appKey)}`
        + "&format=wav&sample_rate=16000"
        + "&enable_punctuation_prediction=true"
        + "&enable_inverse_text_normalization=true"
        + "&enable_voice_detection=false";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 55_000);
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "X-NLS-Token": token,
                "Content-Type": "application/octet-stream",
            },
            body: audio,
            signal: controller.signal,
        });
        const responseBody = await res.text();
        const data = await Promise.resolve().then(() => JSON.parse(responseBody)).catch(() => null) as {
            status?: number;
            message?: string;
            result?: string;
        } | null;
        if (!res.ok || !data || data.status !== 20000000) {
            const diagnostic = responseBody.split(token).join("[REDACTED]");
            throw new Error(`阿里云识别失败（HTTP ${res.status}，status ${data?.status ?? "未返回"}）：${diagnostic}`);
        }
        return (data.result ?? "").trim();
    } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
            throw new Error("阿里云识别超时（55 秒无响应）");
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}
