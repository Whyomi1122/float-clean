// lib/stt-cloud.ts — 云端语音识别（按住说话）
//
// 非 iOS 设备的通话不再依赖浏览器 Web Speech API（国内安卓基本不可用，且持续
// 开麦会把整页音频会话钉在通话模式）。改为微信式按住说话：按住用 MediaRecorder
// 录一段音，松手后发给 OpenAI 兼容的 /audio/transcriptions 转文字。麦克风只在
// 按住的几秒内打开，松手立刻释放，不再有音频会话残留问题。
// iOS 保持原有 Web Speech 免提方案（见 tts-service.ts 的会话说明）。

import { loadBindingConfig, loadVoiceConfigs, resolveBinding } from "./settings-storage";
import type { VoiceApiConfig } from "./settings-types";

export type CloudSttConfig = {
    baseUrl: string;
    apiKey: string;
    model: string;
    /** 识别通道：openai = OpenAI 兼容 /audio/transcriptions；aliyun = 阿里云一句话识别 */
    provider?: "openai" | "aliyun";
    /** 阿里云智能语音交互项目的 appkey（provider=aliyun 时必填） */
    aliyunAppKey?: string;
    /** 阿里云一句话识别模型：通用/识音石V1 等，默认 general */
    aliyunModel?: string;
};

const DEFAULT_STT_MODEL = "whisper-1";
const TRANSCRIBE_TIMEOUT_MS = 60_000;
// 录音兜底上限：忘记松手/指针事件丢失时自动停，避免无限占用麦克风
const MAX_RECORDING_MS = 60_000;

function toCloudSttConfig(config: VoiceApiConfig | undefined | null): CloudSttConfig | null {
    if (!config || config.enableSTT === false) return null;

    // 阿里云一句话识别：密钥由服务端托管（/api/asr/aliyun-token），
    // 前端只需要 appkey + 系统级 AK 配置是否存在（由路由返回 501 判定）。
    if (config.provider === "Aliyun") {
        const appKey = config.apiKey?.trim();
        if (!appKey) return null;
        return {
            provider: "aliyun",
            baseUrl: "",
            apiKey: "",
            model: "",
            aliyunAppKey: appKey,
            aliyunModel: config.sttModel?.trim() || "general",
        };
    }

    if (config.provider !== "OpenAI") return null;
    if (!config.apiKey?.trim()) return null;
    return {
        provider: "openai",
        baseUrl: (config.baseUrl || "https://api.openai.com/v1").trim().replace(/\/+$/, ""),
        apiKey: config.apiKey.trim(),
        model: config.sttModel?.trim() || DEFAULT_STT_MODEL,
    };
}

/**
 * 解析可用的云端识别配置（STT）。
 *
 * 「识别」与「发声」是两条独立通道：
 *   · TTS  = 角色绑定 voiceConfigId（通常 MiniMax，管音色）
 *   · STT  = 本函数，只要某条语音配置兼容识别即可
 * 所以这里不要求角色绑定哪条——先用绑定那条试试（阿里云 / OpenAI 兼容），
 * 不行再扫全表：**优先阿里云配置**（专用识别），其次 OpenAI 兼容。
 * 这样 Minimax 管角色音色、阿里云管识别，可以同时存在。
 */
export function resolveCloudSttConfig(characterId?: string): CloudSttConfig | null {
    const configs = loadVoiceConfigs();
    if (characterId) {
        const bindings = loadBindingConfig();
        const slot = resolveBinding(bindings, characterId, "chat");
        const bound = configs.find(c => c.id === slot.voiceConfigId);
        const fromBound = toCloudSttConfig(bound);
        if (fromBound) return fromBound;
    }

    // 优先阿里云专用识别配置
    const aliyun = configs.find(c => c.provider === "Aliyun" && c.enableSTT !== false);
    const fromAliyun = toCloudSttConfig(aliyun);
    if (fromAliyun) return fromAliyun;

    for (const config of configs) {
        const cloud = toCloudSttConfig(config);
        if (cloud) return cloud;
    }
    return null;
}

export function isCallRecordingSupported(): boolean {
    return typeof navigator !== "undefined"
        && !!navigator.mediaDevices?.getUserMedia
        && typeof MediaRecorder !== "undefined";
}

export type ActiveCallRecording = {
    /** 松手：停止录音并返回音频（没录到内容返回 null）。 */
    stop: () => Promise<Blob | null>;
    /** 取消：丢弃已录内容，立即释放麦克风。 */
    cancel: () => void;
};

/** 按下开始录音。resolve 时麦克风已经在录；权限被拒等失败会 reject。 */
export async function startCallRecording(): Promise<ActiveCallRecording> {
    if (!isCallRecordingSupported()) throw new Error("当前环境不支持录音");

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {
        throw new Error("麦克风权限被拒绝或不可用");
    });

    // 优先 opus：体积小、转写接口普遍支持
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
        .find(m => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } });
    const recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32_000 })
        : new MediaRecorder(stream);

    const chunks: Blob[] = [];
    let finished = false;
    let cancelled = false;
    let resolveStop: ((blob: Blob | null) => void) | null = null;

    const releaseMic = () => {
        try { stream.getTracks().forEach(track => track.stop()); } catch { /* ignore */ }
    };

    recorder.ondataavailable = event => {
        if (event.data && event.data.size) chunks.push(event.data);
    };
    recorder.onstop = () => {
        if (finished) return;
        finished = true;
        window.clearTimeout(maxTimer);
        releaseMic();
        if (cancelled) { resolveStop?.(null); return; }
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        resolveStop?.(blob.size > 0 ? blob : null);
    };
    recorder.onerror = () => {
        if (finished) return;
        finished = true;
        window.clearTimeout(maxTimer);
        releaseMic();
        resolveStop?.(null);
    };

    const maxTimer = window.setTimeout(() => {
        try { recorder.stop(); } catch { /* ignore */ }
    }, MAX_RECORDING_MS);

    recorder.start();

    return {
        stop: () => new Promise<Blob | null>(resolve => {
            resolveStop = resolve;
            if (finished) { resolve(null); return; }
            try { recorder.stop(); } catch { recorder.onstop?.(new Event("stop") as never); }
        }),
        cancel: () => {
            cancelled = true;
            if (finished) return;
            try { recorder.stop(); } catch {
                finished = true;
                window.clearTimeout(maxTimer);
                releaseMic();
            }
        },
    };
}

/** 调 OpenAI 兼容 /audio/transcriptions 把录音转文字。 */
export async function transcribeAudioBlob(blob: Blob, config: CloudSttConfig): Promise<string> {
    if (config.provider === "aliyun") {
        return transcribeWithAliyun(blob, config);
    }
    const type = (blob.type || "").toLowerCase();
    const ext = type.includes("mp4") ? "mp4"
        : type.includes("ogg") ? "ogg"
        : type.includes("wav") ? "wav"
        : "webm";
    const form = new FormData();
    form.set("model", config.model);
    form.set("file", blob, `speech.${ext}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
    try {
        const res = await fetch(`${config.baseUrl}/audio/transcriptions`, {
            method: "POST",
            headers: { Authorization: `Bearer ${config.apiKey}` },
            body: form,
            signal: controller.signal,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`语音识别 API 错误 ${res.status}: ${text.slice(0, 200)}`);
        }
        const contentType = (res.headers.get("content-type") || "").toLowerCase();
        if (contentType.includes("json")) {
            const data = await res.json() as { text?: unknown };
            return typeof data.text === "string" ? data.text.trim() : "";
        }
        // response_format=text 风格的中转直接回纯文本
        return (await res.text()).trim();
    } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
            throw new Error(`语音识别超时（超过 ${Math.round(TRANSCRIBE_TIMEOUT_MS / 1000)} 秒无响应）`);
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

// ── 阿里云一句话识别（2026-11-02 接入）─────────────────────────
// 链路：录音 blob → 解码重采样成 16k 单声道 WAV
//       → POST /api/asr/aliyun-transcribe（同源代理，服务端带 Token 转发到阿里云）
//       → 文本
// 走代理的原因：浏览器直连 nls-gateway 会被 CORS 拦（报 "Failed to fetch"）。
// AccessKey / Token 全在服务端，前端只带 appkey。

const ALIYUN_TRANSCRIBE_ENDPOINT = "/api/asr/aliyun-transcribe";

/** 16k 单声道 PCM(16bit) 与阿里云格式码对应：pcm；这里统一编码成 wav */
async function blobToWav16kMono(blob: Blob): Promise<Blob> {
    const audioCtx = new AudioContext({ sampleRate: 16000 });
    try {
        const decoded = await audioCtx.decodeAudioData(await blob.arrayBuffer());
        const channels = decoded.numberOfChannels;
        const frames = decoded.length;
        // 多声道下混成单声道
        const mono = new Float32Array(frames);
        for (let ch = 0; ch < channels; ch++) {
            const data = decoded.getChannelData(ch);
            for (let i = 0; i < frames; i++) mono[i] += data[i] / channels;
        }
        // 简单的最近邻重采样到 16k（一句话识别对采样率敏感，AI 语音输入足够用）
        const targetRate = 16000;
        const ratio = decoded.sampleRate / targetRate;
        const outLen = Math.max(1, Math.floor(frames / ratio));
        const pcm = new Int16Array(outLen);
        for (let i = 0; i < outLen; i++) {
            const src = Math.min(frames - 1, Math.floor(i * ratio));
            const sample = Math.max(-1, Math.min(1, mono[src]));
            pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }
        // 组装最小 WAV 头（RIFF / PCM / 16bit / 单声道 / 16k）
        const header = new ArrayBuffer(44);
        const view = new DataView(header);
        const writeStr = (offset: number, str: string) => {
            for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
        };
        const dataSize = pcm.byteLength;
        writeStr(0, "RIFF");
        view.setUint32(4, 36 + dataSize, true);
        writeStr(8, "WAVE");
        writeStr(12, "fmt ");
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);          // PCM
        view.setUint16(22, 1, true);          // 单声道
        view.setUint32(24, targetRate, true);
        view.setUint32(28, targetRate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        writeStr(36, "data");
        view.setUint32(40, dataSize, true);
        return new Blob([header, pcm.buffer], { type: "audio/wav" });
    } finally {
        void audioCtx.close();
    }
}

async function transcribeWithAliyun(blob: Blob, config: CloudSttConfig): Promise<string> {
    const appKey = config.aliyunAppKey?.trim();
    if (!appKey) throw new Error("请先在设置里填写阿里云项目的 appkey");

    // 浏览器直连 nls-gateway 会被 CORS 拦（"Failed to fetch"），
    // 一律走同源代理：/api/asr/aliyun-transcribe（服务端带 Token 转发）
    const wav = await blobToWav16kMono(blob);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
    try {
        const res = await fetch(
            `${ALIYUN_TRANSCRIBE_ENDPOINT}?appkey=${encodeURIComponent(appKey)}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/octet-stream" },
                body: wav,
                signal: controller.signal,
            },
        );
        const data = await res.json().catch(() => null) as {
            text?: string;
            error?: string;
        } | null;
        if (!res.ok) {
            if (res.status === 501) {
                throw new Error("阿里云语音未配置：请在 Vercel 环境变量里设置 ALIYUN_AK_ID / ALIYUN_AK_SECRET，然后重新部署");
            }
            throw new Error(data?.error || `阿里云识别失败（HTTP ${res.status}）`);
        }
        return (data?.text ?? "").trim();
    } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
            throw new Error(`语音识别超时（超过 ${Math.round(TRANSCRIBE_TIMEOUT_MS / 1000)} 秒无响应）`);
        }
        if (e instanceof TypeError) {
            // fetch 本身失败（断网 / 代理路由不存在 / 部署未完成）
            throw new Error("无法连接识别服务，请检查网络或确认最新版本已部署");
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}
