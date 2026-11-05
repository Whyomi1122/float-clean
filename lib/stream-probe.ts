// lib/stream-probe.ts — 流式能力自检
//
// 目的：在做「边收边播」之前，先确认配置里的每个模型到底支不支持 stream:true，
// 以及首字要等多久。判定标准：
//   · 收到第一段增量文本 = 支持流式，记录首字耗时（这才是通话开口的真实等待）；
//   · 请求直接抛错 / 返回非 200 = 不支持或被中转拦截。
//
// 实现直接复用 chat-engine 的 sendLLMStreamRequest，保证和真实聊天走同一条通道，
// 避免「自检能过、真聊不行」的假阳性。收到少量文本就主动 abort，省 token。

import { sendLLMStreamRequest } from "@/lib/chat-engine";
import { loadApiConfigs } from "@/lib/settings-storage";
import type { ApiConfig } from "@/lib/settings-types";

export type StreamProbeResult = {
    id: string;
    label: string;
    ok: boolean;
    /** 首字耗时（ms）；0 表示没收到任何增量 */
    firstByteMs: number;
    /** 收到的增量字数 */
    chars: number;
    error?: string;
};

const PROBE_PROMPT = "只回复四个字：收到就好，不要解释。";

export async function probeStreamingConfig(config: ApiConfig, timeoutMs = 25000): Promise<StreamProbeResult> {
    const label = `${config.name || config.provider} · ${config.defaultModel}`;
    const startedAt = Date.now();
    const controller = new AbortController();
    let firstByteMs = 0;
    let chars = 0;
    let abortedByUs = false;

    const timer = setTimeout(() => {
        abortedByUs = true;
        controller.abort();
    }, timeoutMs);

    try {
        await sendLLMStreamRequest(
            config,
            null,
            [{ role: "user", content: PROBE_PROMPT }],
            [],
            {},
            { appId: "diagnose", signal: controller.signal, skipOutputRegex: true, skipTimestampStrip: true },
            {
                onDelta: (text: string) => {
                    if (!text) return;
                    if (!firstByteMs) firstByteMs = Date.now() - startedAt;
                    chars += text.length;
                    // 拿到几个字就够判断了，立即收手
                    if (chars >= 12 && !abortedByUs) {
                        abortedByUs = true;
                        controller.abort();
                    }
                },
            },
        );
        clearTimeout(timer);
        return {
            id: config.id,
            label,
            ok: firstByteMs > 0,
            firstByteMs,
            chars,
            error: firstByteMs > 0 ? undefined : "未收到任何增量文本",
        };
    } catch (error) {
        clearTimeout(timer);
        // 我们自己 abort 的：只要有首字就算通过
        if (firstByteMs > 0 && abortedByUs) {
            return { id: config.id, label, ok: true, firstByteMs, chars };
        }
        return {
            id: config.id,
            label,
            ok: false,
            firstByteMs,
            chars,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/** 逐个探测所有已配置的模型（顺序执行，避免同时打多个中转） */
export async function probeAllStreamingConfigs(): Promise<StreamProbeResult[]> {
    const configs = loadApiConfigs();
    if (!configs.length) return [];
    const results: StreamProbeResult[] = [];
    for (const config of configs) {
        results.push(await probeStreamingConfig(config));
    }
    return results;
}
