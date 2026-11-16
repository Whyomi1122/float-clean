"use client";

import { useState, useEffect, useCallback } from "react";
import { RefreshCw, AlertCircle, X, Check, ChevronDown, ChevronUp, ChevronRight, Layers } from "lucide-react";
import type { ApiConfig } from "@/lib/settings-types";
import { loadApiConfigs, removeApiConfigReferences, remapApiConfigReferences, saveApiConfigs } from "@/lib/settings-storage";
import { generateEmbedding, isEmbeddingModelName } from "@/lib/memory-embedding";
import { ConfirmDialog } from "@/components/ui/modal";
import { Toggle, Input } from "@/components/ui/form";
import { determineBaseUrl, simpleLLMCall } from "@/lib/api-helpers";

const DEFAULT_CONFIGS: ApiConfig[] = [
    {
        id: "default-openai",
        name: "OpenAI 官方",
        provider: "OpenAI",
        apiKey: "",
        defaultModel: "gpt-4o",
        enableNativeTools: true,
        enableImageRecognition: true,
        enableImageGeneration: true,
        preventEmptyGenerateRambling: true,
    }
];

function getNativeToolProtocolLabel(config: ApiConfig): string {
    if (config.provider === "Anthropic" && !config.baseUrl) return "Anthropic";
    if (config.provider === "Google") return "Gemini";
    return "OpenAI-compatible";
}

export function ApiSettings() {
    const [configs, setConfigs] = useState<ApiConfig[]>([]);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [isNewConfig, setIsNewConfig] = useState(false);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    /** 关弹窗时发现「同源」的另一张卡，问一句要不要并成一张（2026-11-15） */
    const [mergeCandidate, setMergeCandidate] = useState<{ keepId: string; absorbId: string; absorbName: string } | null>(null);
    const [isLoaded, setIsLoaded] = useState(false);

    // Testing and Fetching states
    const [isFetching, setIsFetching] = useState<Record<string, boolean>>({});
    const [fetchedModels, setFetchedModels] = useState<Record<string, string[]>>({});
    /** 模型多选列表的搜索关键字（列表太长时才出现搜索框） */
    const [modelFilter, setModelFilter] = useState<Record<string, string>>({});
    /** 编辑配置弹窗里「高级设置」这一段是否展开（默认收起，2026-11-14） */
    const [advancedOpen, setAdvancedOpen] = useState<Record<string, boolean>>({});
    /** 「可选模型」列表是否展开（右上角小箭头收起，2026-11-14） */
    const [optionalOpen, setOptionalOpen] = useState<Record<string, boolean>>({});
    /** 拉取模型列表的提示（只显示失败；成功由「可选模型 · N 个」体现，2026-11-14） */
    const [modelNotice, setModelNotice] = useState<Record<string, string>>({});
    /** 单个模型的测试结果，key = `${configId}::${model}`（2026-11-14 用户要求每个模型能单独测） */
    const [modelTest, setModelTest] = useState<Record<string, { state: "testing" | "ok" | "fail"; message?: string }>>({});

    // Load from localStorage on mount
    useEffect(() => {
        const loaded = loadApiConfigs();
        if (loaded.length > 0) {
            setConfigs(loaded);
        } else {
            setConfigs(DEFAULT_CONFIGS);
            saveApiConfigs(DEFAULT_CONFIGS);
        }
        setIsLoaded(true);
    }, []);

    const persist = useCallback((newConfigs: ApiConfig[]) => {
        setConfigs(newConfigs);
        saveApiConfigs(newConfigs);
    }, []);

    const addConfig = useCallback(() => {
        const newConfig: ApiConfig = {
            id: `config-${Date.now()}`,
            name: "新配置",
            provider: "Custom",
            apiKey: "",
            defaultModel: "",
            enableNativeTools: true,
            enableImageRecognition: false,
            enableImageGeneration: false,
            preventEmptyGenerateRambling: true,
        };
        persist([...configs, newConfig]);
        setIsNewConfig(true);
        setEditingId(newConfig.id);
    }, [configs, persist]);

    // 2026-11-16 设置内页重排：右上「新增API方案」大按钮取消，改为列表卡底的「＋ 新建配置」行

    const updateConfig = (id: string, updates: Partial<ApiConfig>) => {
        persist(configs.map(c => c.id === id ? { ...c, ...updates } : c));
    };

    /** 已选模型（老配置只有 defaultModel 时也能正确显示） */
    const selectedModelsOf = (config: ApiConfig) =>
        config.models && config.models.length > 0
            ? config.models
            : (config.defaultModel ? [config.defaultModel] : []);

    /**
     * 多选模型（2026-11-14 用户要求）：一个 API 下可以同时选多个模型，选中的一个个列出来。
     * 调用时用的就是列表第一个（内部仍写 defaultModel，业务层零改动）。
     */
    /**
     * 点已选模型的名字 = 让它成为默认调用（2026-11-15 用户要求，之前默认模型根本改不了）。
     * 做法：把它挪到 models 第一位，defaultModel 跟着第一位走（调用链只读 defaultModel）。
     */
    const setPrimaryModel = (config: ApiConfig, model: string) => {
        const list = selectedModelsOf(config);
        if (list[0] === model) return;
        const nextList = [model, ...list.filter(item => item !== model)];
        updateConfig(config.id, { models: nextList, defaultModel: model });
    };

    /**
     * 找「同源」的另一张卡：服务商 + 地址 + 密钥完全一样，只是模型不同（2026-11-15）。
     * 硅基流动这类服务被建成好几张卡就是这么来的。
     */
    const findSameSourceConfig = (config: ApiConfig) => {
        const key = (config.apiKey || "").trim();
        if (!key) return null;
        const baseUrl = (config.baseUrl || "").trim().replace(/\/+$/, "").toLowerCase();
        const provider = config.provider || "";
        return configs.find(other =>
            other.id !== config.id
            && (other.apiKey || "").trim() === key
            && (other.baseUrl || "").trim().replace(/\/+$/, "").toLowerCase() === baseUrl
            && (other.provider || "") === provider
        ) ?? null;
    };

    /** 合并：保留当前编辑的这张，另一张的模型并进来、开关取或，绑定引用搬过来再删卡 */
    const mergeSameSourceConfig = (keepId: string, absorbId: string) => {
        const keep = configs.find(c => c.id === keepId);
        const absorb = configs.find(c => c.id === absorbId);
        if (!keep || !absorb) return;
        const keepModels = selectedModelsOf(keep);
        const models = [...keepModels, ...selectedModelsOf(absorb).filter(model => !keepModels.includes(model))];
        const next = configs
            .filter(c => c.id !== absorbId)
            .map(c => c.id === keepId
                ? {
                    ...c,
                    models,
                    defaultModel: c.defaultModel || models[0] || "",
                    enableImageRecognition: c.enableImageRecognition || absorb.enableImageRecognition,
                    enableImageGeneration: c.enableImageGeneration || absorb.enableImageGeneration,
                }
                : c);
        remapApiConfigReferences(absorbId, keepId);
        persist(next);
    };

    /** 关掉编辑弹窗：顺手看一眼有没有「同源」的另一张卡，有就问一句要不要合并 */
    const closeEditor = () => {
        const editing = configs.find(c => c.id === editingId);
        const duplicate = editing ? findSameSourceConfig(editing) : null;
        setIsNewConfig(false);
        setEditingId(null);
        if (editing && duplicate) {
            setMergeCandidate({ keepId: editing.id, absorbId: duplicate.id, absorbName: duplicate.name || duplicate.defaultModel || "另一张配置" });
        }
    };

    const toggleModel = (config: ApiConfig, model: string) => {
        const list = selectedModelsOf(config);
        const selected = list.includes(model);
        const nextList = selected ? list.filter(item => item !== model) : [...list, model];
        updateConfig(config.id, { models: nextList, defaultModel: nextList[0] ?? "" });
    };

    const removeConfig = (id: string) => {
        persist(configs.filter(c => c.id !== id));
        removeApiConfigReferences(id);
        const newFetchedModels = { ...fetchedModels };
        delete newFetchedModels[id];
        setFetchedModels(newFetchedModels);
    };

    // Use unified determineBaseUrl from api-helpers

    const fetchModels = async (config: ApiConfig) => {
        setIsFetching(prev => ({ ...prev, [config.id]: true }));
        setModelNotice(prev => ({ ...prev, [config.id]: "" }));

        try {
            const baseUrl = determineBaseUrl(config);
            if (!baseUrl) throw new Error("缺少 Base URL");
            if (!config.apiKey) throw new Error("缺少 API Key");

            // Gemini 原生协议（/v1beta）：URL 用 ?key= 鉴权，响应是 { models: [{ name }] }
            // OpenAI 兼容（/v1）：Authorization: Bearer + 响应是 { data: [{ id }] }
            const isGoogleNative = config.provider === "Google";
            // 用户常把完整端点填进 Base URL（如 .../v1/embeddings、.../v1/chat/completions），
            // 拼 /models 前剥掉这类端点后缀；已以 /models 结尾则原样使用。
            const modelsBase = baseUrl
                .replace(/\/$/, "")
                .replace(/\/(chat\/completions|completions|embeddings|messages)$/i, "");
            const modelsUrl = /\/models$/i.test(modelsBase) ? modelsBase : `${modelsBase}/models`;
            const url = isGoogleNative
                ? `${modelsUrl}?key=${encodeURIComponent(config.apiKey)}`
                : modelsUrl;
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            if (!isGoogleNative) headers["Authorization"] = `Bearer ${config.apiKey}`;

            const response = await fetch(url, { method: "GET", headers });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error?.message || `HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            let modelNames: string[] = [];
            if (isGoogleNative && Array.isArray(data?.models)) {
                // Gemini 原生：name 可能是 "models/gemini-2.5-pro" 或纯名字
                modelNames = data.models.map((m: { name: string }) => (m.name || "").replace(/^models\//, ""));
            } else if (Array.isArray(data?.data)) {
                modelNames = data.data.map((m: { id: string }) => m.id);
            } else {
                throw new Error("返回数据格式不符合预期");
            }
            setFetchedModels(prev => ({ ...prev, [config.id]: modelNames }));
            // 拉回来的列表里如果还没有当前默认模型，顺手把它并进备选池，勾选列表才不会漏掉它在用的那个
            if (config.defaultModel && !(config.models ?? []).includes(config.defaultModel)) {
                updateConfig(config.id, { models: [...(config.models ?? []), config.defaultModel] });
            }
            // 成功不弹提示：可选模型那一行已经写着「N 个」，再弹一个大绿色横幅只会挤乱版面
            setModelNotice(prev => ({ ...prev, [config.id]: "" }));
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            setModelNotice(prev => ({ ...prev, [config.id]: `拉取失败：${msg}` }));
            setFetchedModels(prev => ({ ...prev, [config.id]: [] }));
        } finally {
            setIsFetching(prev => ({ ...prev, [config.id]: false }));
        }
    };

    /**
     * 单独测某一个已选模型（2026-11-14 用户要求「每个被选择的模型可以单独测试」）。
     * 只把 defaultModel 换成这个模型：向量模型走 /embeddings，聊天模型走 /chat/completions。
     * 原来那条「测试连接」整行按钮已删（它只测默认模型，和每行测试重复）。
     */
    const testSingleModel = async (config: ApiConfig, model: string) => {
        const key = `${config.id}::${model}`;
        setModelTest(prev => ({ ...prev, [key]: { state: "testing" } }));
        const scoped = { ...config, defaultModel: model };

        try {
            if (isEmbeddingModelName(model)) {
                const embedding = await generateEmbedding("你好", scoped, { throwOnError: true });
                if (!embedding) throw new Error("接口未返回向量数据");
                setModelTest(prev => ({ ...prev, [key]: { state: "ok", message: `维度 ${embedding.length}` } }));
                return;
            }
            const result = await simpleLLMCall(
                scoped,
                [{ role: "user", content: "你好" }],
                { temperature: 0.2, max_tokens: 4096 },
            );
            if (result.error || !result.content) {
                throw new Error(result.error || "模型返回了空内容");
            }
            const reply = result.content.replace(/\s+/g, " ").trim();
            setModelTest(prev => ({
                ...prev,
                [key]: { state: "ok", message: reply.length > 40 ? `${reply.slice(0, 40)}...` : reply },
            }));
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            setModelTest(prev => ({ ...prev, [key]: { state: "fail", message: msg } }));
        }
    };

    if (!isLoaded) return null;

    return (
        <div className="flex flex-col gap-6">
            <div className="flex items-center">
                <h2 className="m-0 mx-2 ts-28 font-bold italic leading-none text-black">API Settings</h2>
            </div>

            {configs.length === 0 ? (
                <div className="prefs-block">
                    <span className="prefs-block-label">Model Config</span>
                    <div className="prefs-row">
                        <div className="flex flex-col flex-1 min-w-0 text-left gap-0.5">
                            <span className="ts-14 font-semibold text-[var(--c-text-title)]">没有 API 配置</span>
                            <span className="ts-11 text-[var(--c-text)] opacity-70">配置密钥和模型以连接到 AI 服务</span>
                        </div>
                    </div>
                    <button type="button" className="prefs-row" onClick={addConfig}>
                        <span className="ts-14 text-[var(--c-text)]">＋ 新建配置</span>
                    </button>
                </div>
            ) : (
                <div className="prefs-block">
                    <span className="prefs-block-label">Model Config</span>
                    {configs.map(config => (
                        <button
                            key={config.id}
                            type="button"
                            className="prefs-row"
                            aria-label={`编辑 ${config.name || config.provider}`}
                            onClick={() => setEditingId(config.id)}
                        >
                            <div className="flex flex-col flex-1 min-w-0 text-left gap-0.5">
                                <span className="ts-14 font-semibold text-[var(--c-text-title)] truncate">{config.name || config.provider}</span>
                                <span className="ts-11 text-[var(--c-text)] opacity-70 truncate">
                                    {selectedModelsOf(config).length} 个模型 · {config.defaultModel || "未设置模型"}
                                </span>
                            </div>
                            <ChevronRight size={16} className="text-[var(--c-icon)] opacity-50 shrink-0" />
                        </button>
                    ))}
                    <button type="button" className="prefs-row" onClick={addConfig}>
                        <span className="ts-14 text-[var(--c-text)]">＋ 新建配置</span>
                    </button>
                </div>
            )}

            {editingId && (
                <div className="modal-overlay modal-overlay-bottom">
                    <div className="modal-sheet" data-ui="modal-sheet">
                        <div className="modal-header" data-ui="modal-header">
                            <button onClick={() => { if (isNewConfig && editingId) removeConfig(editingId); setIsNewConfig(false); setEditingId(null); }} className="modal-header-btn modal-header-btn-muted"><X size={18} /></button>
                            <span className="modal-header-title">{isNewConfig ? "添加配置" : "编辑配置"}</span>
                            <button onClick={() => closeEditor()} className="modal-header-btn modal-header-btn-action"><Check size={18} /></button>
                        </div>

                        <div className="modal-body api-form-body hide-scrollbar flex flex-col gap-4 pb-10" data-ui="modal-body">
                            {(() => {
                                const config = configs.find(c => c.id === editingId);
                                if (!config) return null;
                                return (
                                    <>
                                        <div className="api-form-card">
                                        <p className="api-form-card-title">CONNECTION</p>
                                        <div className="api-field-pair">
                                        <div className="api-field-col">
                                            <label className="api-field-label">名称</label>
                                            <Input
                                                type="text"
                                                value={config.name || ""}
                                                onChange={(e) => updateConfig(config.id, { name: e.target.value })}
                                                placeholder="例如: 我的 OpenAI"
                                            />
                                        </div>
                                        <div className="api-field-col">
                                            <label className="api-field-label">服务商</label>
                                            <select
                                                value={config.provider}
                                                onChange={(e) => updateConfig(config.id, { provider: e.target.value })}
                                                className="ui-select"
                                            >
                                                <option value="OpenAI">OpenAI</option>
                                                <option value="Anthropic">Anthropic</option>
                                                <option value="Google">Google Gemini</option>
                                                <option value="DeepSeek">DeepSeek</option>
                                                <option value="Groq">Groq</option>
                                                <option value="OpenRouter">OpenRouter</option>
                                                <option value="Moonshot">Kimi (Moonshot)</option>
                                                <option value="Zhipu">Zhipu (GLM)</option>
                                                <option value="SiliconFlow">SiliconFlow</option>
                                                <option value="TogetherAI">Together AI</option>
                                                <option value="Custom">自定义 (Custom)</option>
                                            </select>
                                        </div>
                                        </div>

                                        {/* Custom 必填 Base URL；其他 provider 可选填中转站地址 */}
                                        <div className="flex flex-col gap-1">
                                            <label className="api-field-label">
                                                Base URL
                                                {config.provider === "Custom" && <span className="api-field-hint">必填</span>}
                                            </label>
                                            <Input
                                                type="url"
                                                value={config.baseUrl || ""}
                                                onChange={(e) => updateConfig(config.id, { baseUrl: e.target.value })}
                                                placeholder={
                                                    config.provider === "Custom"
                                                        ? "https://api.example.com/v1"
                                                        : config.provider === "Google"
                                                            ? "https://your-proxy.example.com/v1beta"
                                                            : "默认用官方端点，留空即可"
                                                }
                                            />
                                        </div>

                                        <div className="flex flex-col gap-1">
                                            <label className="api-field-label">API Key</label>
                                            <Input
                                                type="password"
                                                value={config.apiKey}
                                                onChange={(e) => updateConfig(config.id, { apiKey: e.target.value })}
                                                placeholder="sk-..."
                                            />
                                        </div>
                                        </div>

                                        <div className="api-form-card">
                                        <p className="api-form-card-title">MODELS</p>
                                        {/* 选择模型（可多选，2026-11-14 用户定稿）：
                                            一个 API 下可以同时选好几个模型，每个都能单独测试；
                                            实际调用的是列表第一个（内部仍存 defaultModel）。 */}

                                        {/* 已选模型：一行一个，右侧是「测试 / ✓ 可用」和删除 */}
                                        <div className="api-row-head">
                                            <span>已选模型</span>
                                        </div>

                                        {(selectedModelsOf(config).length > 0) ? (
                                            <div className="api-form-rows api-picked-list">
                                                {selectedModelsOf(config).map((model, index) => {
                                                    const testKey = `${config.id}::${model}`;
                                                    const test = modelTest[testKey];
                                                    return (
                                                        <div key={model} className="api-picked-row">
                                                            <div className="api-picked-head">
                                                                {index === 0 && <span className="api-picked-dot" aria-label="默认调用" title="默认调用这一个" />}
                                                                <button
                                                                    type="button"
                                                                    className="api-picked-name"
                                                                    data-primary={index === 0}
                                                                    title={index === 0 ? model : `点一下让 ${model} 成为默认调用`}
                                                                    onClick={() => setPrimaryModel(config, model)}
                                                                >
                                                                    {model}
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    onClick={() => void testSingleModel(config, model)}
                                                                    disabled={test?.state === "testing"}
                                                                    className="api-pill-btn"
                                                                    data-state={test?.state ?? "idle"}
                                                                >
                                                                    {test?.state === "testing"
                                                                        ? "测试中"
                                                                        : test?.state === "ok"
                                                                            ? "可用"
                                                                            : test?.state === "fail"
                                                                                ? "失败"
                                                                                : "测试"}
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    className="api-picked-remove"
                                                                    aria-label={`移除 ${model}`}
                                                                    onClick={() => toggleModel(config, model)}
                                                                >
                                                                    <X size={13} />
                                                                </button>
                                                            </div>
                                                            {test?.message && test.state !== "testing" && (
                                                                <span className="api-picked-msg" data-state={test.state}>
                                                                    {test.message}
                                                                </span>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        ) : (
                                            <span className="api-row-hint">还没选模型，点下面「刷新列表」拉取后勾选</span>
                                        )}

                                        {/* 已选区 / 可选区之间一条细线（方案 A，2026-11-15） */}
                                        <div className="api-form-divider" />

                                        {/* 可选模型：数量在左边，刷新 + 收起在右边 */}
                                        <div className="api-row-head api-row-head-spaced">
                                            <span>
                                                可选模型
                                                {fetchedModels[config.id] && fetchedModels[config.id].length > 0
                                                    && ` · ${fetchedModels[config.id].length} 个`}
                                            </span>
                                            <div className="api-row-actions">
                                                <button
                                                    type="button"
                                                    onClick={() => fetchModels(config)}
                                                    disabled={isFetching[config.id]}
                                                    className="api-pill-btn"
                                                    data-state="idle"
                                                >
                                                    <RefreshCw size={12} className={isFetching[config.id] ? "animate-spin" : ""} />
                                                    {isFetching[config.id] ? "拉取中" : "刷新列表"}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => setOptionalOpen(prev => ({ ...prev, [config.id]: prev[config.id] === false }))}
                                                    className="api-pill-plain"
                                                    aria-label={optionalOpen[config.id] === false ? "展开可选模型列表" : "收起可选模型列表"}
                                                >
                                                    {optionalOpen[config.id] === false
                                                        ? <ChevronDown size={16} />
                                                        : <ChevronUp size={16} />}
                                                </button>
                                            </div>
                                        </div>

                                        {(optionalOpen[config.id] !== false) && (
                                        <>
                                        {modelNotice[config.id] && (
                                            <span className="api-model-notice">{modelNotice[config.id]}</span>
                                        )}

                                            {/* 待选：勾多少都行，勾中立刻出现在上面的已选列表 */}
                                            {fetchedModels[config.id] && fetchedModels[config.id].length > 0 && (() => {
                                                const allModels = fetchedModels[config.id];
                                                const keyword = (modelFilter[config.id] ?? "").trim().toLowerCase();
                                                const shownModels = keyword
                                                    ? allModels.filter(item => item.toLowerCase().includes(keyword))
                                                    : allModels;
                                                return (
                                                    <div className="api-optional-block">
                                                        {allModels.length > 12 && (
                                                            <input
                                                                type="text"
                                                                value={modelFilter[config.id] ?? ""}
                                                                onChange={(e) => setModelFilter(prev => ({ ...prev, [config.id]: e.target.value }))}
                                                                placeholder="搜模型名..."
                                                                className="ui-input"
                                                            />
                                                        )}
                                                        <div className="api-model-list api-model-scroll">
                                                            {shownModels.length === 0 && (
                                                                <div className="menu-item api-model-row">
                                                                    <span className="api-model-name">没有匹配的模型</span>
                                                                </div>
                                                            )}
                                                            {shownModels.map(model => {
                                                                const selected = selectedModelsOf(config).includes(model);
                                                                return (
                                                                    <button
                                                                        key={model}
                                                                        type="button"
                                                                        className="menu-item api-model-row api-model-pick"
                                                                        data-checked={selected}
                                                                        onClick={() => toggleModel(config, model)}
                                                                    >
                                                                        <span className="api-model-check" data-checked={selected}>
                                                                            {selected && <Check size={11} strokeWidth={3} />}
                                                                        </span>
                                                                        <span className="api-model-name truncate">{model}</span>
                                                                    </button>
                                                                );
                                                            })}
                                                        </div>
                                                    </div>
                                                );
                                            })()}

                                        </>
                                        )}
                                        </div>

                                        <div className="api-form-card">
                                        <button
                                            type="button"
                                            className="api-form-card-head"
                                            onClick={() => setAdvancedOpen(prev => ({ ...prev, [config.id]: !prev[config.id] }))}
                                        >
                                            <span className="api-form-card-title">ADVANCED</span>
                                            <ChevronDown
                                                size={15}
                                                className={`transition-transform ${advancedOpen[config.id] ? "rotate-180" : ""}`}
                                            />
                                        </button>

                                        {advancedOpen[config.id] && (
                                        <div className="api-form-rows">
                                        <div className="ui-toggle-row">
                                            <span className="api-toggle-text api-toggle-stack">
                                                <span className="menu-label font-medium">原生工具调用</span>
                                                <span className="menu-desc api-toggle-desc">（当前自动：{getNativeToolProtocolLabel(config)}）</span>
                                            </span>
                                            <Toggle
                                                checked={config.enableNativeTools !== false}
                                                onChange={(v) => updateConfig(config.id, { enableNativeTools: v })}
                                            />
                                        </div>

                                        <div className="ui-toggle-row">
                                            <span className="menu-label font-medium">图像识别</span>
                                            <Toggle checked={config.enableImageRecognition} onChange={(v) => updateConfig(config.id, { enableImageRecognition: v })} />
                                        </div>

                                        <div className="ui-toggle-row">
                                            <span className="menu-label font-medium">防胡言乱语</span>
                                            <Toggle
                                                checked={config.preventEmptyGenerateRambling === true}
                                                onChange={(v) => updateConfig(config.id, { preventEmptyGenerateRambling: v })}
                                            />
                                        </div>
                                        </div>
                                        )}
                                        </div>

                                        {/* 删除搬到弹窗里（2026-11-16 设置内页重排：列表只负责进二级页） */}
                                        {!isNewConfig && (
                                            <div className="prefs-block">
                                                <button
                                                    type="button"
                                                    className="prefs-row"
                                                    onClick={() => {
                                                        const id = config.id;
                                                        setEditingId(null);
                                                        setConfirmDeleteId(id);
                                                    }}
                                                >
                                                    <span className="ts-14 text-[var(--c-danger)]">删除这张配置</span>
                                                </button>
                                            </div>
                                        )}

                                    </>
                                )
                            })()}
                        </div>
                    </div>
                </div>
            )}

            {confirmDeleteId && (
                <ConfirmDialog
                    title="确认删除？"
                    message="删除配置后无法恢复。是否继续？"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="确认删除"
                    cancelLabel="取消"
                    onConfirm={() => {
                        removeConfig(confirmDeleteId);
                        setConfirmDeleteId(null);
                    }}
                    onCancel={() => setConfirmDeleteId(null)}
                />
            )}

            {mergeCandidate && (
                <ConfirmDialog
                    title="发现同源配置"
                    message={`「${mergeCandidate.absorbName}」的服务商、地址和密钥跟这张一模一样。并成一张吗？两张的模型会合在一起，绑定关系也会跟着搬过来。`}
                    icon={Layers}
                    confirmLabel="合并"
                    cancelLabel="先不了"
                    onConfirm={() => {
                        mergeSameSourceConfig(mergeCandidate.keepId, mergeCandidate.absorbId);
                        setMergeCandidate(null);
                    }}
                    onCancel={() => setMergeCandidate(null)}
                />
            )}
        </div>
    );
}
