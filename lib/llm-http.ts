// lib/llm-http.ts
// LLM 请求的统一 fetch 出口。所有走 buildProviderRequest 的调用点统一经它发请求：
//  - 普通 provider：浏览器直连（现状不变）；
//  - serverProxy 标记（OpenCode 网关）：改发本站 /api/llm-proxy，由服务端转发，
//    绕过 opencode.ai 未开放浏览器 CORS 的问题。

import type { LlmRequestPayload } from "./llm-provider-adapter";
import { diagnosticEndpoint, recordCallDiagnostic } from "./call-diagnostics";

export type FetchLlmPayloadOptions = {
    signal?: AbortSignal;
};

export function fetchLlmPayload(
    payload: LlmRequestPayload,
    options: FetchLlmPayloadOptions = {},
): Promise<Response> {
    const started = Date.now();
    recordCallDiagnostic(`请求 ${payload.providerKind} ${diagnosticEndpoint(payload.url)} · 模型 ${String(payload.body.model ?? "见模型路径")} · 流式 ${payload.body.stream === true} · 代理 ${!!payload.serverProxy}`);
    const observe = (promise: Promise<Response>) => promise.then(response => {
        recordCallDiagnostic(`HTTP ${response.status} · ${Date.now() - started}ms · ${response.headers.get("content-type") || "未知类型"}`);
        return response;
    }, error => {
        recordCallDiagnostic(`网络请求失败 · ${Date.now() - started}ms · ${error instanceof Error ? error.name : "Error"}`);
        throw error;
    });
    const bodyText = JSON.stringify(payload.body);
    if (payload.serverProxy) {
        return observe(fetch("/api/llm-proxy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                url: payload.url,
                headers: payload.headers,
                body: bodyText,
            }),
            signal: options.signal,
        }));
    }
    return observe(fetch(payload.url, {
        method: "POST",
        headers: payload.headers,
        body: bodyText,
        signal: options.signal,
    }));
}
