// lib/aliyun-streaming-stt.ts — 阿里云实时语音识别（流式，档 2）
//
// 为什么不再用一句话识别：一句话识别必须等整段音频上传完才返回结果，
// 「按住 → 松手 → 等识别」至少要 1–3 秒，做不到随说随识别。
// 实时识别走 WebSocket：边说话边分片上传 PCM，服务端持续返回中间结果。
//
// 链路：
//   浏览器 AudioContext 采集 PCM(16k/16bit/mono，每 100ms 一片)
//     → wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1?token=xxx&appkey=yyy
//     → 发 StartTranscription（format=pcm / sample_rate=16000 / enable_intermediate_result=true）
//     → 收 TranscriptionResultChanged（中间结果，实时上屏）
//     → 收 SentenceEnd（一句结束）
//     → 发 StopTranscription
//
// 说明：
// · WebSocket 不受 CORS 限制，所以不会再出现一句话识别直连时的 "Failed to fetch"。
// · Token 由服务端 /api/asr/aliyun-token 发放（AccessKey 不下发浏览器），24h 有效。
// · 采集用 ScriptProcessor（兼容性比 AudioWorklet 好，国内安卓 WebView 更稳），
//   代价是主线程回调，但 100ms 一次、每片 1600 个采样，开销可接受。
// · 网络/协议任何一步失败都抛错，由上层回退到一句话识别（transcribeAudioBlob）。

const ALIYUN_WS_ENDPOINT = "wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1";
const TOKEN_ENDPOINT = "/api/asr/aliyun-token";
const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 1600; // 100ms
const SILENCE_AUTO_STOP_MS = 1200; // 说完自动收尾（流式特有的"说完即识别"）
const MAX_STREAM_MS = 60_000;

export type StreamingSttHandlers = {
    /** 中间结果（会不断被替换） */
    onPartial?: (text: string) => void;
    /** 一句结束的最终文本（可能一句通话里出现多次） */
    onSentence?: (text: string) => void;
    /** 采集音量，0..1，用于 UI 波形 */
    onLevel?: (level: number) => void;
    /** 连接或识别出错（上层据此回退一句话识别） */
    onError?: (message: string) => void;
};

export type ActiveStreamingStt = {
    /** 停止并返回最终文本（可能为空） */
    stop: () => Promise<string>;
    /** 放弃：不返回结果，立即释放麦克风 */
    cancel: () => void;
};

// ── Token ────────────────────────────────────────────────
let cachedToken: { token: string; expireTime: number } | null = null;

async function fetchToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (cachedToken && cachedToken.expireTime - now > 120) return cachedToken.token;
    const res = await fetch(TOKEN_ENDPOINT, { cache: "no-store" });
    const data = await res.json().catch(() => null) as { token?: string; expireTime?: number; error?: string } | null;
    if (!res.ok || !data?.token) {
        throw new Error(data?.error || `获取识别 Token 失败（HTTP ${res.status}）`);
    }
    cachedToken = { token: data.token, expireTime: data.expireTime ?? now + 3600 };
    return data.token;
}

// ── 音频采集 ──────────────────────────────────────────────
type Capture = {
    stream: MediaStream;
    ctx: AudioContext;
    node: ScriptProcessorNode;
    source: MediaStreamAudioSourceNode;
    release: () => void;
};

async function startCapture(onPcm: (pcm: Int16Array, level: number) => void): Promise<Capture> {
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    }).catch(() => { throw new Error("麦克风权限被拒绝或不可用"); });

    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    // 某些浏览器 AudioContext 会以硬件采样率启动，需读回真实值做重采样
    const actualRate = ctx.sampleRate;
    const source = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(4096, 1, 1);

    let carry = new Float32Array(0);
    node.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        const merged = new Float32Array(carry.length + input.length);
        merged.set(carry, 0);
        merged.set(input, carry.length);

        const ratio = actualRate / SAMPLE_RATE;
        const outLen = Math.floor(merged.length / ratio);
        if (outLen <= 0) { carry = merged; return; }
        const pcm = new Int16Array(outLen);
        let peak = 0;
        for (let i = 0; i < outLen; i++) {
            const src = merged[Math.floor(i * ratio)] ?? 0;
            const clamped = Math.max(-1, Math.min(1, src));
            peak = Math.max(peak, Math.abs(clamped));
            pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
        }
        const consumed = Math.floor(outLen * ratio);
        carry = merged.slice(consumed);
        onPcm(pcm, Math.min(1, peak * 3));
    };

    source.connect(node);
    // 必须接到 destination 才会触发回调；输出静音，不会真的出声
    node.connect(ctx.destination);
    if (ctx.state === "suspended") { try { await ctx.resume(); } catch { /* ignore */ } }

    const release = () => {
        try { node.disconnect(); } catch { /* ignore */ }
        try { source.disconnect(); } catch { /* ignore */ }
        try { stream.getTracks().forEach(t => t.stop()); } catch { /* ignore */ }
        void ctx.close().catch(() => { /* ignore */ });
    };

    return { stream, ctx, node, source, release };
}

// ── WebSocket 会话 ───────────────────────────────────────
type NlsMessage = {
    header?: { name?: string; status?: number; status_text?: string; message_id?: string };
    payload?: {
        result?: string;
        index?: number;
        output?: string;
        msg?: string;
        format?: string;
        audio_address?: string;
    };
};

export async function startAliyunStreamingStt(
    appKey: string,
    handlers: StreamingSttHandlers = {},
): Promise<ActiveStreamingStt> {
    if (!appKey?.trim()) throw new Error("请先填写阿里云项目的 appkey");
    if (typeof WebSocket === "undefined") throw new Error("当前环境不支持流式识别");

    const token = await fetchToken();
    const url = `${ALIYUN_WS_ENDPOINT}?token=${encodeURIComponent(token)}&appkey=${encodeURIComponent(appKey.trim())}`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";

    let closed = false;
    let stopTimer: number | null = null;
    let silenceTimer: number | null = null;
    let sentences: string[] = [];
    let partial = "";
    let lastAudioAt = 0;
    let taskStarted = false;
    let resolveDone: ((text: string) => void) | null = null;
    let capture: Capture | null = null;
    let pendingAudio: Int16Array[] = [];
    let fatalError: Error | null = null;

    const fail = (message: string) => {
        if (closed) return;
        fatalError = new Error(message);
        handlers.onError?.(message);
    };

    const sendJson = (payload: object) => {
        try { ws.send(JSON.stringify(payload)); } catch { /* ignore */ }
    };

    const finish = (text: string) => {
        if (closed) return;
        closed = true;
        if (stopTimer) window.clearTimeout(stopTimer);
        if (silenceTimer) window.clearInterval(silenceTimer);
        capture?.release();
        capture = null;
        try { if (ws.readyState === WebSocket.OPEN) ws.close(); } catch { /* ignore */ }
        resolveDone?.(text.trim());
        resolveDone = null;
    };

    const flushAudio = () => {
        if (!taskStarted || ws.readyState !== WebSocket.OPEN) return;
        for (const chunk of pendingAudio) ws.send(chunk.buffer);
        pendingAudio = [];
    };

    const wsReady = new Promise<void>((resolve, reject) => {
        const openTimer = window.setTimeout(() => reject(new Error("流式识别连接超时")), 8000);
        ws.onopen = () => {
            window.clearTimeout(openTimer);
            sendJson({
                header: {
                    appkey: appKey.trim(),
                    message_id: crypto.randomUUID(),
                    task: "transcription",
                },
                payload: {
                    format: "pcm",
                    sample_rate: SAMPLE_RATE,
                    enable_intermediate_result: true,
                    enable_punctuation_prediction: true,
                    enable_inverse_text_normalization: true,
                },
            });
            resolve();
        };
        ws.onerror = () => {
            window.clearTimeout(openTimer);
            reject(new Error("流式识别连接失败"));
        };
    });

    ws.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        let data: NlsMessage;
        try { data = JSON.parse(event.data) as NlsMessage; } catch { return; }
        const name = data.header?.name || "";
        const status = data.header?.status ?? 20000000;
        const result = data.payload?.result ?? "";

        if (status !== 20000000 && status !== 20000001) {
            fail(`${name || "识别"}失败（${status}）：${data.header?.status_text || data.payload?.msg || "未知错误"}`);
            finish(sentences.join(""));
            return;
        }

        if (name === "TranscriptionStarted") {
            taskStarted = true;
            flushAudio();
            return;
        }
        if (name === "TranscriptionResultChanged") {
            partial = result;
            handlers.onPartial?.(sentences.join("") + result);
            return;
        }
        if (name === "SentenceEnd") {
            if (result.trim()) sentences.push(result.trim());
            partial = "";
            handlers.onSentence?.(sentences.join(""));
            return;
        }
        if (name === "TranscriptionCompleted") {
            if (result.trim()) sentences.push(result.trim());
            finish(sentences.join(""));
            return;
        }
        if (name === "TaskFailed") {
            fail(`流式识别失败：${data.header?.status_text || data.payload?.msg || "未知错误"}`);
            finish(sentences.join(""));
        }
    };

    ws.onclose = () => {
        if (!closed) finish(sentences.join(""));
    };

    await wsReady;

    capture = await startCapture((pcm, level) => {
        handlers.onLevel?.(level);
        if (pcm.length === 0) return;
        lastAudioAt = Date.now();
        if (!taskStarted || ws.readyState !== WebSocket.OPEN) {
            pendingAudio.push(pcm);
            return;
        }
        try { ws.send(pcm.buffer); } catch { /* ignore */ }
    });

    // 说完自动收尾：连续静音一段时间就把这句话交出去（UI 上是"不用松手也识别"）
    silenceTimer = window.setInterval(() => {
        if (lastAudioAt && Date.now() - lastAudioAt > SILENCE_AUTO_STOP_MS && sentences.length + partial.length > 0) {
            handlers.onSentence?.(sentences.join(""));
            lastAudioAt = 0;
        }
    }, 400);

    stopTimer = window.setTimeout(() => {
        sendJson({ header: { appkey: appKey.trim(), message_id: crypto.randomUUID(), task: "StopTranscription" } });
    }, MAX_STREAM_MS);

    return {
        stop: () => new Promise<string>((resolve) => {
            resolveDone = resolve;
            if (closed) { resolve(sentences.join("").trim()); return; }
            sendJson({ header: { appkey: appKey.trim(), message_id: crypto.randomUUID(), task: "StopTranscription" } });
            // 等 TranscriptionCompleted；3 秒还没回就自己收
            window.setTimeout(() => { if (!closed) finish(sentences.join("") + partial); }, 3000);
            if (fatalError) finish(sentences.join(""));
        }),
        cancel: () => {
            finish("");
        },
    };
}

/** 当前环境是否支持流式识别（WebSocket + 麦克风 + AudioContext） */
export function isStreamingSttSupported(): boolean {
    return typeof window !== "undefined"
        && typeof WebSocket !== "undefined"
        && typeof AudioContext !== "undefined"
        && !!navigator.mediaDevices?.getUserMedia;
}
