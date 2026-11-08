"use client";

/**
 * 通话环境音：场景清单 + 本地持久化。
 * 音源放 public/ambience/{scene}.wav|.mp3|.ogg（30-60s 无缝循环）。
 * 文件缺失时播放器静默降级，不影响通话。
 */

export type AmbienceSceneId =
    | "rain"
    | "cafe"
    | "street"
    | "car"
    | "beach"
    | "bedroom"
    | "station";

export type AmbienceScene = {
    id: AmbienceSceneId;
    label: string;
    /** 候选音源，按优先顺序探测第一个存在的 */
    files: string[];
};

/**
 * 音源后缀优先级：WAV → MP3 → OGG。
 * WAV(PCM) 没有编码器填充，配合 Web Audio 的 AudioBufferSourceNode.loop 是采样级无缝；
 * MP3 有编码填充（解码器一般能吃掉）；OGG 在 iOS Safari 不支持，只作最后兜底。
 */
function ambienceCandidates(id: AmbienceSceneId): string[] {
    return [`/ambience/${id}.wav`, `/ambience/${id}.mp3`, `/ambience/${id}.ogg`];
}

export const AMBIENCE_SCENES: AmbienceScene[] = [
    { id: "rain", label: "雨夜", files: ambienceCandidates("rain") },
    { id: "cafe", label: "咖啡厅", files: ambienceCandidates("cafe") },
    { id: "street", label: "夜街", files: ambienceCandidates("street") },
    { id: "car", label: "车内", files: ambienceCandidates("car") },
    { id: "beach", label: "海边", files: ambienceCandidates("beach") },
    { id: "bedroom", label: "卧室", files: ambienceCandidates("bedroom") },
    { id: "station", label: "车站", files: ambienceCandidates("station") },
];

export type AmbienceSettings = {
    /** off = 不播放 */
    scene: AmbienceSceneId | "off";
    /** 0-1 */
    ambientVolume: number;
};

export const DEFAULT_AMBIENCE: AmbienceSettings = {
    scene: "off",
    ambientVolume: 0.35,
};

const STORAGE_KEY = "ai_phone_call_ambience_v1";

export function loadAmbienceSettings(): AmbienceSettings {
    if (typeof window === "undefined") return DEFAULT_AMBIENCE;
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return DEFAULT_AMBIENCE;
        const parsed = JSON.parse(raw) as Partial<AmbienceSettings>;
        const scene = parsed.scene;
        const validScene =
            scene === "off" || AMBIENCE_SCENES.some(item => item.id === scene)
                ? (scene as AmbienceSceneId | "off")
                : DEFAULT_AMBIENCE.scene;
        const volume =
            typeof parsed.ambientVolume === "number" && Number.isFinite(parsed.ambientVolume)
                ? Math.min(1, Math.max(0, parsed.ambientVolume))
                : DEFAULT_AMBIENCE.ambientVolume;
        return { scene: validScene, ambientVolume: volume };
    } catch {
        return DEFAULT_AMBIENCE;
    }
}

export function saveAmbienceSettings(next: AmbienceSettings): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
        /* 忽略配额/隐私模式错误 */
    }
}

/** 该场景的全部候选音源（优先顺序），off 返回空数组 */
export function ambienceFilesOf(scene: AmbienceSceneId | "off"): string[] {
    return AMBIENCE_SCENES.find(item => item.id === scene)?.files ?? [];
}

export function ambienceFileOf(scene: AmbienceSceneId | "off"): string | undefined {
    return ambienceFilesOf(scene)[0];
}
