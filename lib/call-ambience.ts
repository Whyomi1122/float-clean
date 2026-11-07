"use client";

/**
 * 通话环境音：场景清单 + 本地持久化。
 * 音源放 public/ambience/*.mp3（30-60s 无缝循环，单个 <500KB）。
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
    file: string;
};

export const AMBIENCE_SCENES: AmbienceScene[] = [
    { id: "rain", label: "雨夜", file: "/ambience/rain.mp3" },
    { id: "cafe", label: "咖啡厅", file: "/ambience/cafe.mp3" },
    { id: "street", label: "夜街", file: "/ambience/street.mp3" },
    { id: "car", label: "车内", file: "/ambience/car.mp3" },
    { id: "beach", label: "海边", file: "/ambience/beach.mp3" },
    { id: "bedroom", label: "卧室", file: "/ambience/bedroom.mp3" },
    { id: "station", label: "车站", file: "/ambience/station.mp3" },
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

export function ambienceFileOf(scene: AmbienceSceneId | "off"): string | undefined {
    return AMBIENCE_SCENES.find(item => item.id === scene)?.file;
}
