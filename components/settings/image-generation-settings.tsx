"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AlertCircle, Camera, ChevronDown, Image, Info, Plus, RefreshCw, Sparkles, Trash2, Upload } from "lucide-react";
import type { ImageGenerationSettings as ImageGenerationSettingsType, NovelAiPreset, OpenAiImagePreset } from "@/lib/settings-types";
import {
    DEFAULT_IMAGE_GENERATION_SETTINGS,
    DEFAULT_NOVELAI_PRESET,
    loadImageGenerationSettings,
    saveImageGenerationSettings,
} from "@/lib/settings-storage";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { getChatImageFromIndexedDB, saveChatImageToIndexedDB } from "@/lib/chat-asset-storage";
import {
    composeImagePrompt,
    fetchImageGenerationModels,
    fetchNovelAiModels,
    filterLikelyImageModels,
    generateImageFromConfiguredApi,
} from "@/lib/image-generation-service";
import { Alert } from "@/components/ui/feedback";
import { Input, Select, Textarea, Toggle } from "@/components/ui/form";
import { ConfirmDialog } from "@/components/ui/modal";
import {
    NOVELAI_COMMON_MODELS,
    NOVELAI_NOISE_SCHEDULE_OPTIONS,
    NOVELAI_RESOLUTION_OPTIONS,
    NOVELAI_SAMPLER_OPTIONS,
} from "@/lib/novelai-image-config";

const SIZE_OPTIONS = ["auto", "1024x1024", "1024x1536", "1536x1024"];
const QUALITY_OPTIONS = ["auto", "low", "medium", "high"];

// Some relay APIs (e.g. dzzi 的 gpt-image-2) ignore the `size` param and pick
// their own aspect ratio. As a fallback we append a natural-language ratio hint
// to the prompt, which these models DO respect. The marker lets us replace the
// previously-appended hint instead of stacking them when the size changes.
const RATIO_HINT_MARKER = "【画面比例】";
const SIZE_RATIO_HINTS: Record<string, string> = {
    "1024x1024": "正方形 1:1 构图，square 1:1 composition",
    "1024x1536": "竖向 2:3 构图，vertical portrait composition",
    "1536x1024": "横向 3:2 构图，horizontal landscape composition",
};

// Remove any auto-appended ratio hint line(s), preserving the user's own text.
function stripRatioHint(text: string): string {
    return text.replace(new RegExp(`\\s*${RATIO_HINT_MARKER}[^\\n]*`, "g"), "").replace(/\s+$/, "");
}

// Return the prompt with the ratio hint for `size` appended (replacing any
// previous hint). `auto` strips the hint entirely.
function withRatioHint(extraPrompt: string, size: string): string {
    const base = stripRatioHint(extraPrompt);
    const hint = SIZE_RATIO_HINTS[size];
    if (!hint) return base;
    return base ? `${base}\n${RATIO_HINT_MARKER}${hint}` : `${RATIO_HINT_MARKER}${hint}`;
}
const IMAGE_HOSTING_PROVIDER_OPTIONS = [
    { value: "none", label: "不使用图床" },
    { value: "imgbb", label: "ImgBB" },
] as const;
const imageGenerationIconStyle = { "--icon-color": "#0EA5E9" } as CSSProperties;

type Status = { success: boolean; message: string };

export function ImageGenerationSettings() {
    const [settings, setSettings] = useState<ImageGenerationSettingsType>(DEFAULT_IMAGE_GENERATION_SETTINGS);
    const [characters, setCharacters] = useState<Character[]>([]);
    const [referencePreviews, setReferencePreviews] = useState<Record<string, string>>({});
    const [models, setModels] = useState<string[]>([]);
    const [isFetchingModels, setIsFetchingModels] = useState(false);
    const [naiModels, setNaiModels] = useState<string[]>(NOVELAI_COMMON_MODELS);
    const [isFetchingNaiModels, setIsFetchingNaiModels] = useState(false);
    const [isTesting, setIsTesting] = useState(false);
    const [status, setStatus] = useState<Status | null>(null);
    const [naiTokenStatus, setNaiTokenStatus] = useState<Status | null>(null);
    const [testPreviewUrl, setTestPreviewUrl] = useState<string | null>(null);
    const [pendingDeletePresetId, setPendingDeletePresetId] = useState<string | null>(null);
    const [pendingDeleteOpenAiPresetId, setPendingDeleteOpenAiPresetId] = useState<string | null>(null);
    /** 正在编辑专属外观提示词 / 人脸框选的角色 */
    const [profileEditorId, setProfileEditorId] = useState<string | null>(null);
    const openaiPresets = useMemo<OpenAiImagePreset[]>(() => (
        settings.openaiPresets?.length ? settings.openaiPresets : [{
            id: "preset_openai_default",
            name: "默认方案",
            requestMode: settings.requestMode,
            apiKey: settings.apiKey,
            baseUrl: settings.baseUrl,
            model: settings.model,
            size: settings.size,
            quality: settings.quality,
            extraPrompt: settings.extraPrompt,
        }]
    ), [settings]);
    const activeOpenAiPresetId = settings.activeOpenAiPresetId && openaiPresets.some(p => p.id === settings.activeOpenAiPresetId)
        ? settings.activeOpenAiPresetId
        : openaiPresets[0].id;
    const activeOpenAiPreset = openaiPresets.find(p => p.id === activeOpenAiPresetId) || openaiPresets[0];

    useEffect(() => {
        // Sync the ratio hint to the saved size on load, so the hint is present
        // by default (not only after the user manually switches the size).
        const loaded = loadImageGenerationSettings();
        const syncedExtra = withRatioHint(loaded.extraPrompt, loaded.size);
        if (syncedExtra !== loaded.extraPrompt) {
            const next = { ...loaded, extraPrompt: syncedExtra };
            saveImageGenerationSettings(next);
            setSettings(next);
        } else {
            setSettings(loaded);
        }
        setCharacters(loadCharacters());
    }, []);

    useEffect(() => {
        let cancelled = false;
        const refs = settings.characterReferences || {};
        Promise.all(Object.entries(refs).map(async ([characterId, ref]) => {
            const dataUrl = ref.assetId ? await getChatImageFromIndexedDB(ref.assetId) : null;
            return [characterId, dataUrl] as const;
        })).then(entries => {
            if (cancelled) return;
            const next: Record<string, string> = {};
            for (const [characterId, dataUrl] of entries) {
                if (dataUrl) next[characterId] = dataUrl;
            }
            setReferencePreviews(next);
        });
        return () => { cancelled = true; };
    }, [settings.characterReferences]);

    useEffect(() => {
        return () => {
            if (testPreviewUrl) URL.revokeObjectURL(testPreviewUrl);
        };
    }, [testPreviewUrl]);

    const persist = useCallback((next: ImageGenerationSettingsType) => {
        setSettings(next);
        saveImageGenerationSettings(next);
    }, []);

    const updateSettings = useCallback((patch: Partial<ImageGenerationSettingsType>) => {
        persist({ ...settings, ...patch });
    }, [persist, settings]);

    const updateOpenAiPreset = useCallback((patch: Partial<OpenAiImagePreset>) => {
        const nextPresets = openaiPresets.map(preset => preset.id === activeOpenAiPresetId ? { ...preset, ...patch } : preset);
        const active = nextPresets.find(preset => preset.id === activeOpenAiPresetId) || nextPresets[0];
        persist({ ...settings, openaiPresets: nextPresets, activeOpenAiPresetId, requestMode: active.requestMode, apiKey: active.apiKey, baseUrl: active.baseUrl, model: active.model, size: active.size, quality: active.quality, extraPrompt: active.extraPrompt, extraPromptNegative: active.extraPromptNegative });
    }, [activeOpenAiPresetId, openaiPresets, persist, settings]);

    const addOpenAiPreset = useCallback(() => {
        const newId = `preset_openai_${Date.now()}`;
        const newPreset = { ...activeOpenAiPreset, id: newId, name: `${activeOpenAiPreset.name || "默认方案"}（副本）` };
        persist({ ...settings, openaiPresets: [...openaiPresets, newPreset], activeOpenAiPresetId: newId, requestMode: newPreset.requestMode, apiKey: newPreset.apiKey, baseUrl: newPreset.baseUrl, model: newPreset.model, size: newPreset.size, quality: newPreset.quality, extraPrompt: newPreset.extraPrompt, extraPromptNegative: newPreset.extraPromptNegative });
    }, [activeOpenAiPreset, openaiPresets, persist, settings]);

    const deleteOpenAiPreset = useCallback(() => {
        if (openaiPresets.length <= 1) return;
        const next = openaiPresets.filter(preset => preset.id !== activeOpenAiPresetId);
        const active = next[0];
        persist({ ...settings, openaiPresets: next, activeOpenAiPresetId: active.id, requestMode: active.requestMode, apiKey: active.apiKey, baseUrl: active.baseUrl, model: active.model, size: active.size, quality: active.quality, extraPrompt: active.extraPrompt, extraPromptNegative: active.extraPromptNegative });
    }, [activeOpenAiPresetId, openaiPresets, persist, settings]);

    const selectOpenAiPreset = useCallback((id: string) => {
        const active = openaiPresets.find(preset => preset.id === id);
        if (!active) return;
        persist({ ...settings, activeOpenAiPresetId: id, requestMode: active.requestMode, apiKey: active.apiKey, baseUrl: active.baseUrl, model: active.model, size: active.size, quality: active.quality, extraPrompt: active.extraPrompt, extraPromptNegative: active.extraPromptNegative });
    }, [openaiPresets, persist, settings]);

    // NovelAI 预设管理与状态
    const naiSettings = useMemo(() => {
        const nai = settings.novelai;
        const presets = nai?.presets && nai.presets.length > 0 ? nai.presets : [DEFAULT_NOVELAI_PRESET];
        const activePreset = presets.find(p => p.id === nai?.activePresetId) || presets[0];
        return {
            apiKey: nai?.apiKey || "",
            activePresetId: activePreset.id,
            presets,
            activePreset,
        };
    }, [settings.novelai]);

    const updateNovelAi = useCallback((patch: Partial<import("@/lib/settings-types").NovelAiSettings>) => {
        persist({
            ...settings,
            novelai: {
                apiKey: naiSettings.apiKey,
                activePresetId: naiSettings.activePresetId,
                presets: naiSettings.presets,
                ...patch,
            },
        });
    }, [naiSettings, persist, settings]);

    const updateActivePreset = useCallback((patch: Partial<NovelAiPreset>) => {
        const nextPresets = naiSettings.presets.map(p => {
            if (p.id === naiSettings.activePresetId) {
                return { ...p, ...patch };
            }
            return p;
        });
        updateNovelAi({ presets: nextPresets });
    }, [naiSettings, updateNovelAi]);

    const addPreset = useCallback(() => {
        const newId = `preset_nai_${Date.now()}`;
        const newPreset: NovelAiPreset = {
            ...naiSettings.activePreset,
            id: newId,
            name: `${naiSettings.activePreset.name} (副本)`,
        };
        updateNovelAi({
            presets: [...naiSettings.presets, newPreset],
            activePresetId: newId,
        });
    }, [naiSettings, updateNovelAi]);

    const deletePreset = useCallback((presetId: string) => {
        if (naiSettings.presets.length <= 1) return;
        const deletedIndex = naiSettings.presets.findIndex(p => p.id === presetId);
        if (deletedIndex < 0) return;
        const nextPresets = naiSettings.presets.filter(p => p.id !== presetId);
        const nextActivePreset = nextPresets[Math.min(deletedIndex, nextPresets.length - 1)];
        updateNovelAi({
            presets: nextPresets,
            activePresetId: nextActivePreset.id,
        });
    }, [naiSettings, updateNovelAi]);

    const updateImageHosting = useCallback((patch: Partial<ImageGenerationSettingsType["imageHosting"]>) => {
        persist({
            ...settings,
            imageHosting: {
                ...settings.imageHosting,
                ...patch,
            },
        });
    }, [persist, settings]);

    const likelyModels = useMemo(() => filterLikelyImageModels(models), [models]);

    const fetchModels = async () => {
        setStatus(null);
        if (!activeOpenAiPreset.apiKey.trim() || !activeOpenAiPreset.baseUrl.trim()) {
            setStatus({ success: false, message: "请先填写 Base URL 和 API Key。" });
            return;
        }
        setIsFetchingModels(true);
        try {
            const fetched = await fetchImageGenerationModels(activeOpenAiPreset);
            setModels(fetched);
            setStatus({
                success: true,
                message: fetched.length > 0 ? `已拉取 ${fetched.length} 个模型。` : "接口返回为空，可手动填写模型名。",
            });
        } catch (err) {
            setModels([]);
            setStatus({ success: false, message: err instanceof Error ? err.message : String(err) });
        } finally {
            setIsFetchingModels(false);
        }
    };

    const fetchNaiModels = async () => {
        setNaiTokenStatus(null);
        if (!naiSettings.apiKey.trim()) {
            setNaiTokenStatus({ success: false, message: "请先填写 NovelAI API Token。" });
            return;
        }
        setIsFetchingNaiModels(true);
        try {
            const fetched = await fetchNovelAiModels(naiSettings.apiKey);
            setNaiModels(fetched);
            setNaiTokenStatus({
                success: true,
                message: `NovelAI Token 有效，已加载 ${fetched.length} 个常用模型。`,
            });
        } catch (err) {
            setNaiTokenStatus({ success: false, message: err instanceof Error ? err.message : String(err) });
        } finally {
            setIsFetchingNaiModels(false);
        }
    };

    const testGeneration = async () => {
        setStatus(null);
        setIsTesting(true);
        try {
            const result = await generateImageFromConfiguredApi({
                description: settings.provider === "novelai"
                    ? "1girl, solo, upper body, white coffee cup on the wooden table, soft window light"
                    : "一张放在桌面上的白色咖啡杯，柔和自然光，真实照片风格",
                settings: { ...settings, enabled: true },
            });
            if (!result) throw new Error("图像生成未返回结果。");
            if (testPreviewUrl) URL.revokeObjectURL(testPreviewUrl);
            setTestPreviewUrl(URL.createObjectURL(result.blob));
            setStatus({ success: true, message: "测试生图成功。" });
        } catch (err) {
            setStatus({ success: false, message: err instanceof Error ? err.message : String(err) });
        } finally {
            setIsTesting(false);
        }
    };

    const uploadReference = async (characterId: string, file: File) => {
        const assetId = await saveChatImageToIndexedDB(file);
        persist({
            ...settings,
            characterReferences: {
                ...(settings.characterReferences || {}),
                [characterId]: {
                    // 重新上传时保留已有的外观提示词与参数
                    ...(settings.characterReferences?.[characterId] ?? {}),
                    assetId,
                    updatedAt: Date.now(),
                },
            },
        });
    };

    /** 更新角色的生图档案（外观提示词 / 参考图开关 / 人脸框选） */
    const updateReferenceProfile = (characterId: string, patch: {
        featurePrompt?: string;
        featurePromptPositive?: string;
        featurePromptNegative?: string;
        novelAiFeaturePromptEnabled?: boolean;
        enabled?: boolean;
        faceCrop?: { x: number; y: number; size: number } | undefined;
    }) => {
        const current = settings.characterReferences?.[characterId];
        const nextRef = {
            ...current,
            assetId: current?.assetId ?? "",
            updatedAt: Date.now(),
            ...patch,
        } as ImageGenerationSettingsType["characterReferences"][string];
        if (patch.faceCrop === undefined) delete (nextRef as { faceCrop?: unknown }).faceCrop;
        persist({
            ...settings,
            characterReferences: { ...(settings.characterReferences || {}), [characterId]: nextRef },
        });
    };

    const removeReference = (characterId: string) => {
        const nextRefs = { ...(settings.characterReferences || {}) };
        delete nextRefs[characterId];
        persist({ ...settings, characterReferences: nextRefs });
        setReferencePreviews(prev => {
            const next = { ...prev };
            delete next[characterId];
            return next;
        });
    };

    return (
        <div className="flex flex-col gap-6 pb-8">
            <div className="flex items-center">
                <h2 className="m-0 mx-2 ts-28 font-bold italic leading-none text-black">Image Generation</h2>
            </div>

            <div className="menu-group">
                <div className="menu-item">
                    <span className="card-icon" style={imageGenerationIconStyle}>
                        <Sparkles size={22} strokeWidth={1.75} />
                    </span>
                    <span className="settings-tools-menu-copy">
                        <span className="menu-label appearance-menu-item-label">启用自动生图</span>
                        <span className="menu-desc settings-tools-menu-desc">角色输出照片标签时自动调用图像生成 API。</span>
                    </span>
                    <span className="menu-right settings-tools-menu-toggle">
                        <Toggle checked={settings.enabled} onChange={(enabled) => updateSettings({ enabled })} className="settings-toggle-control" />
                    </span>
                </div>
            </div>

            <div className="menu-group p-4 flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                    <label className="menu-desc ml-1">生图提供方 / 引擎</label>
                    <Select
                        value={settings.provider || "openai"}
                        onChange={(event) => updateSettings({
                            provider: event.target.value as "openai" | "novelai",
                        })}
                    >
                        <option value="openai">OpenAI 兼容 (通用模型 / DALL-E / Flux / SD 中转等)</option>
                        <option value="novelai">NovelAI 原生接口 (官方 API)</option>
                    </Select>
                </div>

                <div className="flex flex-col gap-1">
                    <label className="menu-desc ml-1">请求方式</label>
                    <Select
                        value={settings.requestMode}
                        onChange={(event) => updateSettings({
                            requestMode: event.target.value as ImageGenerationSettingsType["requestMode"],
                        })}
                    >
                        <option value="server">服务端转发（推荐，可避免跨域报错）</option>
                        <option value="direct">浏览器直连（需接口允许 CORS 跨域）</option>
                    </Select>
                </div>

                {settings.provider === "novelai" ? (
                    /* --- NovelAI 配置面板 --- */
                    <>
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">NovelAI API Token</label>
                            <Input
                                type="password"
                                value={naiSettings.apiKey}
                                onChange={(event) => {
                                    updateNovelAi({ apiKey: event.target.value });
                                    setNaiTokenStatus(null);
                                }}
                                placeholder="pst-..."
                            />
                            <span className="menu-desc ml-1">可在 NovelAI 官网 Account 页面获取 Persistent API Token。</span>
                            {naiTokenStatus && (
                                <div role={naiTokenStatus.success ? "status" : "alert"} className="mt-2">
                                    <Alert variant={naiTokenStatus.success ? "success" : "danger"}>
                                        <AlertCircle size={16} className="mt-[2px] shrink-0" />
                                        <span className="break-all leading-[1.5]">{naiTokenStatus.message}</span>
                                    </Alert>
                                </div>
                            )}
                        </div>

                        {/* 预设管理栏 */}
                        <div className="flex flex-col gap-2 rounded-xl bg-[var(--c-input)]/40 p-3 border border-[var(--c-card-border)]">
                            <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
                                <label className="menu-label text-sm font-semibold">NovelAI 参数预设</label>
                                <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
                                    <button
                                        type="button"
                                        onClick={addPreset}
                                        className="ui-btn ui-btn-soft-action min-h-11 !px-3 !py-2 text-xs flex items-center gap-1"
                                        title="复制当前为新预设"
                                    >
                                        <Plus size={14} />
                                        新建预设
                                    </button>
                                    {naiSettings.presets.length > 1 && (
                                        <button
                                            type="button"
                                            onClick={() => setPendingDeletePresetId(naiSettings.activePresetId)}
                                            className="ui-btn ui-btn-danger min-h-11 !px-3 !py-2 text-xs flex items-center gap-1"
                                            title="删除当前选中的预设"
                                        >
                                            <Trash2 size={14} />
                                            删除预设
                                        </button>
                                    )}
                                </div>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                <div className="flex flex-col gap-1">
                                    <span className="menu-desc ml-1">切换当前预设</span>
                                    <Select
                                        value={naiSettings.activePresetId}
                                        onChange={(event) => updateNovelAi({ activePresetId: event.target.value })}
                                    >
                                        {naiSettings.presets.map(p => (
                                            <option key={p.id} value={p.id}>{p.name}</option>
                                        ))}
                                    </Select>
                                </div>
                                <div className="flex flex-col gap-1">
                                    <span className="menu-desc ml-1">预设名称</span>
                                    <Input
                                        type="text"
                                        value={naiSettings.activePreset.name}
                                        onChange={(event) => updateActivePreset({ name: event.target.value })}
                                        placeholder="预设名称"
                                    />
                                </div>
                            </div>
                        </div>

                        {/* 预设详细参数 */}
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">模型 (Model)</label>
                            <div className="flex gap-2">
                                <div className="relative flex-1">
                                    <Input
                                        type="text"
                                        value={naiSettings.activePreset.model}
                                        onChange={(event) => updateActivePreset({ model: event.target.value })}
                                        placeholder="nai-diffusion-4-curated-preview"
                                        className={naiModels.length > 0 ? "w-full pr-9" : "w-full"}
                                    />
                                    {naiModels.length > 0 && (
                                        <>
                                            <ChevronDown size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 opacity-60" />
                                            <select
                                                aria-label="选择常见 NAI 模型"
                                                value=""
                                                onChange={(event) => {
                                                    if (event.target.value) updateActivePreset({ model: event.target.value });
                                                }}
                                                className="absolute inset-y-0 right-0 w-10 cursor-pointer opacity-0"
                                            >
                                                <option value="">快速选择模型...</option>
                                                {naiModels.map(m => (
                                                    <option key={m} value={m}>{m}</option>
                                                ))}
                                            </select>
                                        </>
                                    )}
                                </div>
                                <button
                                    type="button"
                                    onClick={fetchNaiModels}
                                    disabled={isFetchingNaiModels}
                                    className="ui-btn ui-btn-soft-action min-h-11 shrink-0"
                                >
                                    <RefreshCw size={16} className={isFetchingNaiModels ? "animate-spin" : ""} />
                                    {isFetchingNaiModels ? "验证中" : "验证 Token"}
                                </button>
                            </div>
                            <span className="menu-desc ml-1 opacity-70">模型下拉列表内置于应用；“验证 Token”只检查凭证，不会发起生图。</span>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">分辨率 (Resolution)</label>
                            <Select
                                value={naiSettings.activePreset.resolution}
                                onChange={(event) => updateActivePreset({ resolution: event.target.value })}
                            >
                                {NOVELAI_RESOLUTION_OPTIONS.map(opt => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                            </Select>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">采样器 (Sampler)</label>
                                <Select
                                    value={naiSettings.activePreset.sampler}
                                    onChange={(event) => updateActivePreset({ sampler: event.target.value })}
                                >
                                    {NOVELAI_SAMPLER_OPTIONS.map(opt => (
                                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                                    ))}
                                </Select>
                            </div>

                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">调度器 (Schedule)</label>
                                <Select
                                    value={naiSettings.activePreset.noiseSchedule || "karras"}
                                    onChange={(event) => updateActivePreset({ noiseSchedule: event.target.value })}
                                >
                                    {NOVELAI_NOISE_SCHEDULE_OPTIONS.map(opt => (
                                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                                    ))}
                                </Select>
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">步数 (Steps: {naiSettings.activePreset.steps})</label>
                                <Input
                                    type="number"
                                    min={1}
                                    max={50}
                                    value={naiSettings.activePreset.steps}
                                    onChange={(event) => updateActivePreset({
                                        steps: Math.max(1, Math.min(50, parseInt(event.target.value, 10) || 28)),
                                    })}
                                />
                            </div>

                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">提示词相关度 (CFG Scale: {naiSettings.activePreset.scale})</label>
                                <Input
                                    type="number"
                                    min={1}
                                    max={30}
                                    step={0.1}
                                    value={naiSettings.activePreset.scale}
                                    onChange={(event) => updateActivePreset({
                                        scale: Math.max(1, Math.min(30, parseFloat(event.target.value) || 6.0)),
                                    })}
                                />
                            </div>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">画师串 / 正面质量提示词 (Positive / Quality)</label>
                            <Textarea
                                value={naiSettings.activePreset.positivePrompt}
                                onChange={(event) => updateActivePreset({ positivePrompt: event.target.value })}
                                placeholder="masterpiece, best quality, very aesthetic, artist:..."
                                rows={3}
                            />
                            <span className="menu-desc ml-1 opacity-70">
                                会作为基础风格与角色聊天的画面描述组合发送。
                            </span>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">负面提示词 (Undesired Content / Negative)</label>
                            <Textarea
                                value={naiSettings.activePreset.negativePrompt}
                                onChange={(event) => updateActivePreset({ negativePrompt: event.target.value })}
                                placeholder="lowres, bad anatomy, bad hands, blurry..."
                                rows={3}
                            />
                        </div>

                        <div className="grid grid-cols-2 gap-2 pt-1">
                            <label className="flex min-h-11 items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={naiSettings.activePreset.qualityToggle !== false}
                                    onChange={(e) => updateActivePreset({ qualityToggle: e.target.checked })}
                                    className="rounded border-[var(--c-card-border)]"
                                />
                                <span className="text-xs font-medium">启用质量词 (Quality+)</span>
                            </label>
                            <label className="flex min-h-11 items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={naiSettings.activePreset.smea === true}
                                    onChange={(e) => updateActivePreset({ smea: e.target.checked })}
                                    className="rounded border-[var(--c-card-border)]"
                                />
                                <span className="text-xs font-medium">启用 SMEA</span>
                            </label>
                        </div>
                    </>
                ) : (
                    /* --- OpenAI 模式配置面板 --- */
                    <>
                        <div className="flex flex-col gap-2 rounded-xl bg-[var(--c-input)]/40 p-3 border border-[var(--c-card-border)]">
                            <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
                                <label className="menu-label text-sm font-semibold">OpenAI API 配置预设</label>
                                <div className="grid grid-cols-2 gap-2 sm:flex">
                                    <button type="button" onClick={addOpenAiPreset} className="ui-btn ui-btn-soft-action min-h-11 !px-3 !py-2 text-xs flex items-center gap-1"><Plus size={14} />新建预设</button>
                                    {openaiPresets.length > 1 && <button type="button" onClick={() => setPendingDeleteOpenAiPresetId(activeOpenAiPresetId)} className="ui-btn ui-btn-danger min-h-11 !px-3 !py-2 text-xs flex items-center gap-1"><Trash2 size={14} />删除预设</button>}
                                </div>
                            </div>
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                <div className="flex flex-col gap-1">
                                    <span className="menu-desc ml-1">当前预设</span>
                                    <Select value={activeOpenAiPresetId} onChange={(event) => selectOpenAiPreset(event.target.value)}>
                                        {openaiPresets.map(preset => <option key={preset.id} value={preset.id}>{preset.name.trim() || "未命名预设"}</option>)}
                                    </Select>
                                </div>
                                <div className="flex flex-col gap-1">
                                    <span className="menu-desc ml-1">预设备注</span>
                                    <Input type="text" value={activeOpenAiPreset.name} onChange={(event) => updateOpenAiPreset({ name: event.target.value })} placeholder="未命名预设" />
                                </div>
                            </div>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">请求方式</label>
                            <Select value={activeOpenAiPreset.requestMode} onChange={(event) => updateOpenAiPreset({ requestMode: event.target.value as ImageGenerationSettingsType["requestMode"] })}>
                                <option value="server">服务端转发（推荐，可避免跨域报错）</option>
                                <option value="direct">浏览器直连（需接口允许 CORS 跨域）</option>
                            </Select>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">Base URL</label>
                            <Input
                                type="url"
                                value={activeOpenAiPreset.baseUrl}
                                onChange={(event) => updateOpenAiPreset({ baseUrl: event.target.value })}
                                placeholder="https://api.example.com/v1"
                            />
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">API Key</label>
                            <Input
                                type="password"
                                value={activeOpenAiPreset.apiKey}
                                onChange={(event) => updateOpenAiPreset({ apiKey: event.target.value })}
                                placeholder="sk-..."
                            />
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">模型名</label>
                            <div className="flex gap-2">
                                <div className="relative flex-1">
                                    <Input
                                        type="text"
                                        value={activeOpenAiPreset.model}
                                        onChange={(event) => updateOpenAiPreset({ model: event.target.value })}
                                        placeholder="gpt-image-2 / image2 / chatgpt-image-latest"
                                        className={likelyModels.length > 0 ? "w-full pr-9" : "w-full"}
                                    />
                                    {likelyModels.length > 0 && (
                                        <>
                                            <ChevronDown size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 opacity-60" />
                                            <select
                                                aria-label="选择拉取到的模型"
                                                value=""
                                                onChange={(event) => {
                                                    if (event.target.value) updateOpenAiPreset({ model: event.target.value });
                                                }}
                                                className="absolute inset-y-0 right-0 w-10 cursor-pointer opacity-0"
                                            >
                                                <option value="">选择拉取到的模型...</option>
                                                {likelyModels.map(model => <option key={model} value={model}>{model}</option>)}
                                            </select>
                                        </>
                                    )}
                                </div>
                                <button
                                    type="button"
                                    onClick={fetchModels}
                                    disabled={isFetchingModels}
                                    className="ui-btn ui-btn-soft-action shrink-0"
                                >
                                    <RefreshCw size={16} className={isFetchingModels ? "animate-spin" : ""} />
                                    {isFetchingModels ? "拉取中" : "拉取模型"}
                                </button>
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">尺寸</label>
                                <Select value={activeOpenAiPreset.size} onChange={(event) => {
                                        const size = event.target.value;
                                        updateOpenAiPreset({ size, extraPrompt: withRatioHint(activeOpenAiPreset.extraPrompt, size) });
                                    }}>
                                    {SIZE_OPTIONS.map(option => <option key={option} value={option}>{option}</option>)}
                                </Select>
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">质量</label>
                                <Select value={activeOpenAiPreset.quality} onChange={(event) => updateOpenAiPreset({ quality: event.target.value })}>
                                    {QUALITY_OPTIONS.map(option => <option key={option} value={option}>{option}</option>)}
                                </Select>
                            </div>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">补充提示词</label>
                            <Textarea
                                value={activeOpenAiPreset.extraPrompt}
                                onChange={(event) => updateOpenAiPreset({ extraPrompt: event.target.value })}
                                placeholder="会和角色输出的图片描述一起发送给生图模型。"
                                rows={4}
                            />
                            <p className="menu-desc ml-1 opacity-70">
                                选择尺寸后会自动在末尾追加一句「{RATIO_HINT_MARKER}…」构图提示，用于纠正部分不认 size 参数的接口（如 gpt-image-2）。可手动修改或删除。
                            </p>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">负向提示词（不要什么）</label>
                            <Textarea
                                value={activeOpenAiPreset.extraPromptNegative ?? ""}
                                onChange={(event) => updateOpenAiPreset({ extraPromptNegative: event.target.value })}
                                placeholder="例如：anime, 2.5D, CGI, plastic skin, doll-like face, extra fingers"
                                rows={3}
                            />
                            <p className="menu-desc ml-1 opacity-70">
                                GPT 系模型没有原生负向参数，会以「Avoid: …」的形式拼在提示词末尾。关键词用逗号分隔，越短越有效。
                            </p>
                        </div>
                    </>
                )}

                <div className="flex gap-3">
                    <button
                        type="button"
                        onClick={testGeneration}
                        disabled={isTesting}
                        className="ui-btn ui-btn-success flex-1"
                    >
                        <Image size={16} />
                        {isTesting ? "测试中..." : "测试生图"}
                    </button>
                </div>

                {status && (
                    <div role={status.success ? "status" : "alert"}>
                        <Alert variant={status.success ? "success" : "danger"}>
                            <AlertCircle size={16} className="mt-[2px] shrink-0" />
                            <span className="break-all leading-[1.5]">{status.message}</span>
                        </Alert>
                    </div>
                )}
                {testPreviewUrl && (
                    <img
                        src={testPreviewUrl}
                        alt="测试生图结果"
                        className="max-h-[220px] max-w-full self-start rounded-xl border border-[var(--c-card-border)] object-contain"
                    />
                )}
            </div>

            <div className="flex flex-col gap-2">
                <p className="settings-menu-section-title">Image Hosting</p>
                <div className="menu-group">
                    <div className="menu-item">
                        <span className="card-icon" style={imageGenerationIconStyle}>
                            <Upload size={22} strokeWidth={1.75} />
                        </span>
                        <span className="settings-tools-menu-copy">
                            <span className="menu-label appearance-menu-item-label">允许小卷上传图床</span>
                            <span className="menu-desc settings-tools-menu-desc">开启后，小卷的图像处理套件可以把本地素材上传到公开图床并拿 URL 写 CSS。</span>
                        </span>
                        <span className="menu-right settings-tools-menu-toggle">
                            <Toggle
                                checked={settings.imageHosting.allowMascotUpload}
                                onChange={(allowMascotUpload) => updateImageHosting({ allowMascotUpload })}
                                className="settings-toggle-control"
                            />
                        </span>
                    </div>
                </div>

                <div className="menu-group p-4 flex flex-col gap-4">
                    <div className="flex flex-col gap-1">
                        <label className="menu-desc ml-1">图床提供方</label>
                        <Select
                            value={settings.imageHosting.provider}
                            onChange={(event) => updateImageHosting({
                                provider: event.target.value as ImageGenerationSettingsType["imageHosting"]["provider"],
                            })}
                        >
                            {IMAGE_HOSTING_PROVIDER_OPTIONS.map(option => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                        </Select>
                    </div>

                    <div className="flex flex-col gap-1">
                        <label className="menu-desc ml-1">ImgBB API Key</label>
                        <Input
                            type="password"
                            value={settings.imageHosting.imgbbApiKey}
                            onChange={(event) => updateImageHosting({ imgbbApiKey: event.target.value })}
                            placeholder="从 imgbb.com/api/1 获取"
                            disabled={settings.imageHosting.provider !== "imgbb"}
                        />
                        <span className="menu-desc ml-1">Key 只保存在当前项目设置里；小卷工具结果不会显示它。</span>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">默认过期秒数</label>
                            <Input
                                type="number"
                                min={0}
                                max={15552000}
                                value={settings.imageHosting.defaultExpirationSeconds}
                                onChange={(event) => updateImageHosting({
                                    defaultExpirationSeconds: Math.max(0, Number.parseInt(event.target.value, 10) || 0),
                                })}
                                disabled={settings.imageHosting.provider !== "imgbb"}
                            />
                            <span className="menu-desc ml-1">0 表示不过期。</span>
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">上传上限 KB</label>
                            <Input
                                type="number"
                                min={64}
                                max={32768}
                                value={Math.round(settings.imageHosting.maxUploadBytes / 1024)}
                                onChange={(event) => updateImageHosting({
                                    maxUploadBytes: Math.max(64, Number.parseInt(event.target.value, 10) || 900) * 1024,
                                })}
                                disabled={settings.imageHosting.provider !== "imgbb"}
                            />
                            <span className="menu-desc ml-1">默认 900KB，适合 CSS 主题素材。</span>
                        </div>
                    </div>

                    <div className="menu-item !px-0 !py-0">
                        <span className="settings-tools-menu-copy">
                            <span className="menu-label appearance-menu-item-label">上传前自动转 WebP</span>
                            <span className="menu-desc settings-tools-menu-desc">减小 PNG/JPEG 体积；GIF 会保留原格式。</span>
                        </span>
                        <span className="menu-right settings-tools-menu-toggle">
                            <Toggle
                                checked={settings.imageHosting.autoConvertToWebp}
                                onChange={(autoConvertToWebp) => updateImageHosting({ autoConvertToWebp })}
                                className="settings-toggle-control"
                                disabled={settings.imageHosting.provider !== "imgbb"}
                            />
                        </span>
                    </div>
                </div>
            </div>

            <div className="flex flex-col gap-2">
                <p className="settings-menu-section-title">Character References</p>
                {settings.provider === "novelai" && (
                    <Alert variant="info">
                        <Info size={16} className="mt-[2px] shrink-0" />
                        <span className="leading-[1.5]">NovelAI 只使用文字提示词生成图片，不读取角色参考图。可点每行的「外观」填写专属提示词（人物性别/发型/服饰），参考图会保留，切回 OpenAI 兼容引擎后仍可使用。</span>
                    </Alert>
                )}
                <div className="menu-group">
                    {characters.length === 0 ? (
                        <div className="ui-empty py-8">
                            <Camera size={22} />
                            <span className="menu-desc">暂无角色。</span>
                        </div>
                    ) : characters.map(character => {
                        const preview = referencePreviews[character.id];
                        const ref = settings.characterReferences?.[character.id];
                        const hasProfile = Boolean(
                            ref?.featurePrompt?.trim()
                            || ref?.featurePromptPositive?.trim()
                            || ref?.featurePromptNegative?.trim()
                            || ref?.faceCrop
                        );
                        return (
                            <div key={character.id} className="menu-item">
                            <span className="h-11 w-11 shrink-0 overflow-hidden rounded-xl bg-[var(--c-input)]">
                                {preview ? (
                                    <img src={preview} alt="" className="h-full w-full object-cover" />
                                ) : character.avatar ? (
                                    <img src={character.avatar} alt="" className="h-full w-full object-cover" />
                                ) : (
                                    <span className="flex h-full w-full items-center justify-center ts-13 font-semibold text-[var(--c-icon)]">
                                        {character.name.slice(0, 1)}
                                    </span>
                                )}
                            </span>
                            <span className="min-w-0 flex flex-1 flex-col">
                                <span className="menu-label truncate">{character.name}</span>
                                <span className="menu-desc truncate">
                                    {hasProfile ? "已设置外观档案" : "未设置外观档案"} · {preview ? "有参考图" : "无参考图"}
                                </span>
                            </span>
                            <span className="menu-right flex gap-2">
                                <button
                                    type="button"
                                    className="ui-link-btn"
                                    aria-label={`设置 ${character.name} 的外观档案`}
                                    onClick={() => setProfileEditorId(character.id)}
                                >
                                    <Sparkles size={18} />
                                </button>
                                {settings.provider !== "novelai" && (
                                    <button
                                        type="button"
                                        className="ui-link-btn"
                                        aria-label={`上传 ${character.name} 的参考图`}
                                        onClick={() => {
                                            const input = document.createElement("input");
                                            input.type = "file";
                                            input.accept = "image/*";
                                            input.onchange = async () => {
                                                const file = input.files?.[0];
                                                if (file) await uploadReference(character.id, file);
                                            };
                                            input.click();
                                        }}
                                    >
                                        <Upload size={18} />
                                    </button>
                                )}
                                {preview && (
                                    <button
                                        type="button"
                                        className="ui-link-btn"
                                        data-variant="danger"
                                        aria-label={`删除 ${character.name} 的参考图`}
                                        onClick={() => removeReference(character.id)}
                                    >
                                        <Trash2 size={18} />
                                    </button>
                                )}
                            </span>
                            </div>
                        );
                    })}
                </div>
            </div>

            {profileEditorId ? (() => {
                const character = characters.find(item => item.id === profileEditorId);
                if (!character) return null;
                return (
                    <CharacterImageProfileDialog
                        character={character}
                        preview={referencePreviews[character.id]}
                        reference={settings.characterReferences?.[character.id]}
                        showNovelAiToggle={settings.provider === "novelai"}
                        onClose={() => setProfileEditorId(null)}
                        onSave={patch => {
                            updateReferenceProfile(character.id, patch);
                            setProfileEditorId(null);
                        }}
                    />
                );
            })() : null}

            {pendingDeleteOpenAiPresetId && (
                <ConfirmDialog
                    title="确认删除预设？"
                    message={`预设“${openaiPresets.find(p => p.id === pendingDeleteOpenAiPresetId)?.name || "未命名预设"}”删除后无法恢复，其中的 API Key 也会一起删除。`}
                    icon={Trash2}
                    variant="danger"
                    confirmLabel="确认删除"
                    cancelLabel="取消"
                    onConfirm={() => {
                        deleteOpenAiPreset();
                        setPendingDeleteOpenAiPresetId(null);
                    }}
                    onCancel={() => setPendingDeleteOpenAiPresetId(null)}
                />
            )}
            {pendingDeletePresetId && (
                <ConfirmDialog
                    title="确认删除预设？"
                    message={`预设“${naiSettings.presets.find(p => p.id === pendingDeletePresetId)?.name || "未命名预设"}”删除后无法恢复。`}
                    icon={Trash2}
                    variant="danger"
                    confirmLabel="确认删除"
                    cancelLabel="取消"
                    onConfirm={() => {
                        deletePreset(pendingDeletePresetId);
                        setPendingDeletePresetId(null);
                    }}
                    onCancel={() => setPendingDeletePresetId(null)}
                />
            )}

        </div>
    );
}

/**
 * 角色生图档案：专属外观提示词 + 参考图开关 + 人脸框选。
 * 移植自二改 f969e4b（锁脸优化）。框选交互改为「点选中心 + 尺寸滑杆」，手机上更好操作。
 */
function CharacterImageProfileDialog({
    character,
    preview,
    reference,
    showNovelAiToggle,
    onClose,
    onSave,
}: {
    character: Character;
    preview?: string;
    reference?: ImageGenerationSettingsType["characterReferences"][string];
    showNovelAiToggle: boolean;
    onClose: () => void;
    onSave: (patch: {
        featurePrompt: string;
        featurePromptPositive: string;
        featurePromptNegative: string;
        novelAiFeaturePromptEnabled: boolean;
        enabled: boolean;
        faceCrop?: { x: number; y: number; size: number };
    }) => void;
}) {
    const [featurePositive, setFeaturePositive] = useState(
        reference?.featurePromptPositive?.trim()
        ?? (reference?.featurePrompt?.split(/反向|negative/i)[0] ?? "").trim()
        ?? ""
    );
    const [featureNegative, setFeatureNegative] = useState(
        reference?.featurePromptNegative?.trim()
        ?? (reference?.featurePrompt?.match(/(?:反向|negative)([\s\S]*)/i)?.[1] ?? "").trim()
    );
    const [showPreview, setShowPreview] = useState(false);
    const [enabled, setEnabled] = useState(reference?.enabled !== false);
    const [novelAiEnabled, setNovelAiEnabled] = useState(reference?.novelAiFeaturePromptEnabled !== false);
    const [crop, setCrop] = useState<{ x: number; y: number; size: number } | undefined>(reference?.faceCrop);
    const [cropSize, setCropSize] = useState(reference?.faceCrop?.size ?? 0.45);
    const frameRef = useRef<HTMLDivElement | null>(null);

    const previewPrompt = useMemo(() => composeImagePrompt({
        description: "（这里会是角色输出的画面描述，如：他坐在窗边喝咖啡，看向镜头）",
        extraNegative: "",
        featurePrompt: featurePositive,
        featureNegative: featureNegative,
    }), [featurePositive, featureNegative]);

    const hasCrop = Boolean(crop && crop.size > 0);

    const placeCrop = useCallback((centerX: number, centerY: number, size: number) => {
        const rect = frameRef.current?.getBoundingClientRect();
        const width = rect?.width || 1;
        const height = rect?.height || 1;
        const minSide = Math.min(width, height);
        const sideW = (size * minSide) / width;
        const sideH = (size * minSide) / height;
        const x = Math.max(0, Math.min(centerX - sideW / 2, 1 - sideW));
        const y = Math.max(0, Math.min(centerY - sideH / 2, 1 - sideH));
        setCrop({ x, y, size });
    }, []);

    const handleFramePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        const centerX = (event.clientX - rect.left) / rect.width;
        const centerY = (event.clientY - rect.top) / rect.height;
        placeCrop(centerX, centerY, cropSize);
    };

    /** 改框选大小时保持当前中心点不变 */
    const updateCropSize = (next: number) => {
        setCropSize(next);
        const rect = frameRef.current?.getBoundingClientRect();
        if (!rect || !rect.width || !rect.height || !crop) return;
        const minSide = Math.min(rect.width, rect.height);
        const sideW = (crop.size * minSide) / rect.width;
        const sideH = (crop.size * minSide) / rect.height;
        placeCrop(crop.x + sideW / 2, crop.y + sideH / 2, next);
    };

    const cropOverlay = (() => {
        if (!crop) return null;
        const rect = frameRef.current?.getBoundingClientRect();
        const width = rect?.width || 1;
        const height = rect?.height || 1;
        const minSide = Math.min(width, height);
        const w = ((crop.size * minSide) / width) * 100;
        const h = ((crop.size * minSide) / height) * 100;
        return { left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${w}%`, height: `${h}%` };
    })();

    return (
        <div className="modal-overlay" data-ui="modal" onClick={onClose}>
            <div
                className="modal-card"
                style={{ maxWidth: 380, maxHeight: "86vh", gap: 12 }}
                onClick={event => event.stopPropagation()}
            >
                <h3 className="modal-title">{character.name} · 生图外观</h3>

                {preview ? (
                    <div className="flex flex-col gap-2">
                        <div
                            ref={frameRef}
                            onPointerDown={handleFramePointerDown}
                            className="relative w-full overflow-hidden rounded-xl bg-[var(--c-input)]"
                            style={{ touchAction: "none" }}
                        >
                            <img src={preview} alt="" className="block w-full select-none" draggable={false} />
                            {hasCrop && cropOverlay && (
                                <span
                                    className="pointer-events-none absolute rounded-md border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]"
                                    style={cropOverlay}
                                />
                            )}
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="menu-desc shrink-0">框选大小</span>
                            <input
                                type="range"
                                min={15}
                                max={100}
                                value={Math.round(cropSize * 100)}
                                onChange={event => updateCropSize(Number(event.target.value) / 100)}
                                className="flex-1"
                            />
                            <button
                                type="button"
                                className="ui-link-btn shrink-0"
                                disabled={!hasCrop}
                                onClick={() => setCrop(undefined)}
                            >
                                清除
                            </button>
                        </div>
                        <p className="menu-desc">
                            点一下预览图上的人脸即可定位，再拖「框选大小」调整范围。只把框内区域送给模型，锁脸会更准。
                        </p>
                    </div>
                ) : (
                    <p className="menu-desc">还没有参考图。可先保存外观提示词，之后在列表里上传参考图再回来框选。</p>
                )}

                <label className="flex flex-col gap-1">
                    <span className="menu-label">外观提示词 · 正向</span>
                    <textarea
                        value={featurePositive}
                        onChange={event => setFeaturePositive(event.target.value)}
                        rows={4}
                        placeholder={"例如：1boy, 男性, 25岁, 黑色短发, 单眼皮, 高瘦, 深色大衣"}
                        className="ui-input w-full resize-y"
                    />
                    <span className="menu-desc">
                        每次生图自动追加，用来固定性别与外貌。
                    </span>
                </label>

                <label className="flex flex-col gap-1">
                    <span className="menu-label">外观提示词 · 负向（不要什么）</span>
                    <textarea
                        value={featureNegative}
                        onChange={event => setFeatureNegative(event.target.value)}
                        rows={3}
                        placeholder={"例如：feminine, girl, long hair, breasts"}
                        className="ui-input w-full resize-y"
                    />
                    <span className="menu-desc">
                        专门防止男角色被画成女生。OpenAI 兼容接口以「Avoid: …」拼到提示词末尾；NovelAI 会并入原生负向参数。
                    </span>
                </label>

                <div className="flex flex-col gap-1">
                    <button
                        type="button"
                        className="ui-link-btn self-start"
                        onClick={() => setShowPreview(v => !v)}
                    >
                        {showPreview ? "收起预览 ▲" : "预览最终提示词 ▼"}
                    </button>
                    {showPreview && (
                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-xl bg-[var(--c-input)]/60 p-3 ts-12 leading-relaxed text-[var(--c-text)]">
{previewPrompt}
                        </pre>
                    )}
                </div>

                <div className="flex items-center justify-between">
                    <span className="menu-label">使用参考图（锁脸）</span>
                    <Toggle checked={enabled} onChange={setEnabled} />
                </div>

                {showNovelAiToggle && (
                    <div className="flex items-center justify-between">
                        <span className="menu-label">NovelAI 也追加外观提示词</span>
                        <Toggle checked={novelAiEnabled} onChange={setNovelAiEnabled} />
                    </div>
                )}

                <div className="flex gap-2">
                    <button
                        type="button"
                        className="flex-1 rounded-xl py-2.5 ts-13"
                        style={{ background: "var(--c-input)", color: "var(--c-text-title)" }}
                        onClick={onClose}
                    >
                        取消
                    </button>
                    <button
                        type="button"
                        className="flex-1 rounded-xl py-2.5 ts-13 font-medium text-white"
                        style={{ background: "var(--c-icon-active)" }}
                        onClick={() => onSave({
                            featurePrompt: "",
                            featurePromptPositive: featurePositive,
                            featurePromptNegative: featureNegative,
                            novelAiFeaturePromptEnabled: novelAiEnabled,
                            enabled,
                            faceCrop: crop,
                        })}
                    >
                        保存
                    </button>
                </div>
            </div>
        </div>
    );
}
