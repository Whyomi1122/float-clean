"use client";

import { useState, useEffect, useContext, type CSSProperties } from "react";
import {
    Asterisk,
    BookOpen,
    Box,
    Brain,
    Check,
    ChevronLeft,
    ChevronRight,
    Code2,
    Compass,
    Image as ImageIcon,
    Languages,
    Layers,
    Mic,
    Music2,
    RotateCcw,
    User,
    UserPlus,
    Volume2,
    Wrench,
    X,
    type LucideIcon,
} from "lucide-react";
import { SettingsContext } from "../phone-settings-app";
import { ICONS, type IconId } from "@/lib/desktop-config";
import { IconGlyph } from "@/components/icon-glyph";
import { CUSTOM_APPS_UPDATED_EVENT, loadInstalledCustomApps } from "@/lib/custom-app-storage";
import { toCustomAppIconId } from "@/lib/custom-app-types";
import type { InstalledCustomApp } from "@/lib/custom-app-types";

/** Map ContentAppId → IconId (only needed where they differ) */
const APP_ICON_MAP: Partial<Record<ContentAppId, IconId>> = {
    adventure: "mapmode",
    vn: "vnmode",
};
const appIconId = (appId: ContentAppId): IconId => APP_ICON_MAP[appId] ?? appId as IconId;
import type {
    BindingConfig,
    BindingSlot,
    CharacterBinding,
    ContentAppId,
    ApiConfig,
    VoiceApiConfig,
    PresetConfig,
    WorldBookConfig,
    RegexConfig,
} from "@/lib/settings-types";
import { CONTENT_APP_IDS, CONTENT_APP_LABELS } from "@/lib/settings-types";
import { BINDING_ACCENTS, CONTENT_APP_ACCENTS } from "@/lib/ui-accent-colors";
import {
    loadBindingConfig,
    saveBindingConfig,
    getCharacterBinding,
    setCharacterBinding,
    loadApiConfigs,
    loadVoiceConfigs,
    loadPresets,
    loadWorldBooks,
    loadRegexes,
    loadUserIdentities,
    ensureSettingsStorageHydrated,
} from "@/lib/settings-storage";
import { hydrateKvDb } from "@/lib/kv-db";
import type { UserIdentity } from "@/components/settings/user-identity";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";

type Level = "global" | "character" | "app";
type SingleBindingField = "apiConfigId" | "voiceConfigId" | "presetId" | "userIdentityId";
type MultiBindingField = "worldBookIds" | "regexIds";
type BindingField = SingleBindingField | MultiBindingField;
type AuxBindingField = "memorySummaryApiConfigId" | "embeddingApiConfigId" | "mascotApiConfigId" | "reasoningTranslateApiConfigId" | "qaApiConfigId" | "koreanSpeechApiConfigId" | "storyDirectionApiConfigId" | "moodMusicApiConfigId" | "comicApiConfigId";

const BINDING_FIELD_VISUALS: Record<BindingField, { icon: LucideIcon; color: string }> = {
    apiConfigId: { icon: Code2, color: BINDING_ACCENTS.api },
    voiceConfigId: { icon: Mic, color: BINDING_ACCENTS.voice },
    presetId: { icon: Layers, color: BINDING_ACCENTS.preset },
    worldBookIds: { icon: BookOpen, color: BINDING_ACCENTS.worldBook },
    regexIds: { icon: Asterisk, color: BINDING_ACCENTS.regex },
    userIdentityId: { icon: User, color: BINDING_ACCENTS.identity },
};

const AUX_FIELD_VISUALS: Record<AuxBindingField, { icon: LucideIcon; color: string }> = {
    memorySummaryApiConfigId: { icon: Brain, color: BINDING_ACCENTS.memory },
    embeddingApiConfigId: { icon: Box, color: BINDING_ACCENTS.embedding },
    mascotApiConfigId: { icon: Code2, color: BINDING_ACCENTS.api },
    reasoningTranslateApiConfigId: { icon: Languages, color: BINDING_ACCENTS.voice },
    qaApiConfigId: { icon: Wrench, color: BINDING_ACCENTS.api },
    koreanSpeechApiConfigId: { icon: Volume2, color: BINDING_ACCENTS.voice },
    storyDirectionApiConfigId: { icon: Compass, color: BINDING_ACCENTS.api },
    moodMusicApiConfigId: { icon: Music2, color: BINDING_ACCENTS.api },
    comicApiConfigId: { icon: ImageIcon, color: BINDING_ACCENTS.api },
};

const APP_OVERRIDE_COLORS = CONTENT_APP_ACCENTS;
const REGEX_BINDABLE_APP_IDS: ContentAppId[] = ["chat", "group_chat", "story"];

const bindingAccentStyle = (color: string): CSSProperties => ({
    "--binding-accent": color,
} as CSSProperties);

const CUSTOM_APP_BINDING_PREFIX = "custom_app:";

const isCustomAppBindingId = (appId: string | null | undefined): boolean => (
    Boolean(appId?.startsWith(CUSTOM_APP_BINDING_PREFIX))
);

const canBindRegexInApp = (appId: string | null | undefined): boolean => (
    Boolean(appId && (REGEX_BINDABLE_APP_IDS.includes(appId as ContentAppId) || isCustomAppBindingId(appId)))
);

export function BindingManager() {
    const { setSubpageTitle, setOverrideBack } = useContext(SettingsContext);

    const [config, setConfig] = useState<BindingConfig>({ globalDefaults: {}, characterBindings: [] });
    const [characters, setCharacters] = useState<Character[]>([]);
    const [apiConfigs, setApiConfigs] = useState<ApiConfig[]>([]);
    const [voiceConfigs, setVoiceConfigs] = useState<VoiceApiConfig[]>([]);
    const [presets, setPresets] = useState<PresetConfig[]>([]);
    const [worldBooks, setWorldBooks] = useState<WorldBookConfig[]>([]);
    const [regexes, setRegexes] = useState<RegexConfig[]>([]);
    const [identities, setIdentities] = useState<UserIdentity[]>([]);
    const [customApps, setCustomApps] = useState<InstalledCustomApp[]>([]);

    const [level, setLevel] = useState<Level>("global");
    const [selectedCharId, setSelectedCharId] = useState<string>("");
    const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
    const [activeGlobalSheetField, setActiveGlobalSheetField] = useState<BindingField | null>(null);
    const [activeSlotSheetField, setActiveSlotSheetField] = useState<BindingField | null>(null);
    const [activeAuxSheetField, setActiveAuxSheetField] = useState<AuxBindingField | null>(null);
    // 二级选择：选完 API 配置后再选模型（值为刚选中的配置 id）
    const [pickerModelConfigId, setPickerModelConfigId] = useState<string | null>(null);
    const [showCharacterPicker, setShowCharacterPicker] = useState(false);
    const [isLoaded, setIsLoaded] = useState(false);

    const reloadData = () => {
        setApiConfigs(loadApiConfigs());
        setVoiceConfigs(loadVoiceConfigs());
        setPresets(loadPresets());
        setWorldBooks(loadWorldBooks());
        setRegexes(loadRegexes());
        setIdentities(loadUserIdentities());
    };

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            await Promise.all([hydrateKvDb(), ensureSettingsStorageHydrated()]);
            if (cancelled) return;
            setConfig(loadBindingConfig());
            setCharacters(loadCharacters());
            setCustomApps(loadInstalledCustomApps());
            reloadData();
            setIsLoaded(true);
        })();
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        const handler = () => setCustomApps(loadInstalledCustomApps());
        window.addEventListener(CUSTOM_APPS_UPDATED_EVENT, handler);
        return () => window.removeEventListener(CUSTOM_APPS_UPDATED_EVENT, handler);
    }, []);

    const getCustomAppByBindingId = (appId: string | null | undefined): InstalledCustomApp | null => {
        if (!appId?.startsWith(CUSTOM_APP_BINDING_PREFIX)) return null;
        const customAppId = appId.slice(CUSTOM_APP_BINDING_PREFIX.length);
        return customApps.find(app => app.id === customAppId) ?? null;
    };

    const getAppLabel = (appId: string): string => {
        const customApp = getCustomAppByBindingId(appId);
        if (customApp) return customApp.name;
        return CONTENT_APP_LABELS[appId as ContentAppId] ?? appId;
    };

    // Auto-clean stale binding IDs when resource lists change
    useEffect(() => {
        if (!isLoaded) return;
        const validSets = {
            api: new Set(apiConfigs.map(c => c.id)),
            voice: new Set(voiceConfigs.map(c => c.id)),
            preset: new Set(presets.map(p => p.id)),
            identity: new Set(identities.map(i => i.id)),
            wb: new Set(worldBooks.map(w => w.id)),
            regex: new Set(regexes.map(r => r.id)),
        };
        const cleanSlot = (slot: BindingSlot): [BindingSlot, boolean] => {
            const s = { ...slot };
            let changed = false;
            if (s.apiConfigId && !validSets.api.has(s.apiConfigId)) { s.apiConfigId = undefined; changed = true; }
            if (s.voiceConfigId && !validSets.voice.has(s.voiceConfigId)) { s.voiceConfigId = undefined; changed = true; }
            if (s.presetId && !validSets.preset.has(s.presetId)) { s.presetId = undefined; changed = true; }
            if (s.userIdentityId && !validSets.identity.has(s.userIdentityId)) { s.userIdentityId = undefined; changed = true; }
            if (s.worldBookIds) {
                const f = s.worldBookIds.filter(id => validSets.wb.has(id));
                if (f.length !== s.worldBookIds.length) changed = true;
                s.worldBookIds = f.length > 0 ? f : undefined;
            }
            if (s.regexIds) {
                const f = s.regexIds.filter(id => validSets.regex.has(id));
                if (f.length !== s.regexIds.length) changed = true;
                s.regexIds = f.length > 0 ? f : undefined;
            }
            return [s, changed];
        };
        setConfig(prev => {
            let dirty = false;
            const [gd, gChanged] = cleanSlot(prev.globalDefaults);
            if (gChanged) dirty = true;
            // 全局三项「所见即所得」：不允许未设置，缺省/悬空清理后落位为实际兜底值
            // （API=第一个配置、预设=内置、身份=第一条），界面显示的就是实际生效的
            if (apiConfigs.length > 0 && !gd.apiConfigId) { gd.apiConfigId = apiConfigs[0].id; dirty = true; }
            if (presets.length > 0 && !gd.presetId) { gd.presetId = (presets.find(p => p.builtIn) ?? presets[0]).id; dirty = true; }
            if (identities.length > 0 && !gd.userIdentityId) { gd.userIdentityId = identities[0].id; dirty = true; }
            const newAppDefaults: Record<string, BindingSlot> = {};
            for (const [appId, slot] of Object.entries(prev.appDefaults ?? {})) {
                if (!slot) continue;
                const [cleaned, aChanged] = cleanSlot(slot);
                if (aChanged) dirty = true;
                newAppDefaults[appId] = cleaned;
            }
            const newBindings = prev.characterBindings.map(b => {
                const [defaults, dChanged] = cleanSlot(b.defaults);
                if (dChanged) dirty = true;
                const newOverrides: Record<string, BindingSlot> = {};
                for (const [k, v] of Object.entries(b.appOverrides)) {
                    if (!v) continue;
                    const [cleaned, oChanged] = cleanSlot(v);
                    if (oChanged) dirty = true;
                    newOverrides[k] = cleaned;
                }
                return { ...b, defaults, appOverrides: newOverrides };
            });
            const next: BindingConfig = { ...prev, globalDefaults: gd, appDefaults: newAppDefaults, characterBindings: newBindings };
            if (prev.memorySummaryApiConfigId && !validSets.api.has(prev.memorySummaryApiConfigId)) {
                next.memorySummaryApiConfigId = undefined;
                dirty = true;
            }
            if (prev.embeddingApiConfigId && !validSets.api.has(prev.embeddingApiConfigId)) {
                next.embeddingApiConfigId = undefined;
                dirty = true;
            }
            if (prev.mascotApiConfigId && !validSets.api.has(prev.mascotApiConfigId)) {
                next.mascotApiConfigId = undefined;
                dirty = true;
            }
            if (prev.qaApiConfigId && !validSets.api.has(prev.qaApiConfigId)) {
                next.qaApiConfigId = undefined;
                dirty = true;
            }
            if (prev.reasoningTranslateApiConfigId && !validSets.api.has(prev.reasoningTranslateApiConfigId)) {
                next.reasoningTranslateApiConfigId = undefined;
                dirty = true;
            }
            if (prev.koreanSpeechApiConfigId && !validSets.api.has(prev.koreanSpeechApiConfigId)) {
                next.koreanSpeechApiConfigId = undefined;
                dirty = true;
            }
            if (prev.storyDirectionApiConfigId && !validSets.api.has(prev.storyDirectionApiConfigId)) {
                next.storyDirectionApiConfigId = undefined;
                dirty = true;
            }
            if (prev.moodMusicApiConfigId && !validSets.api.has(prev.moodMusicApiConfigId)) {
                next.moodMusicApiConfigId = undefined;
                dirty = true;
            }
            if (prev.comicApiConfigId && !validSets.api.has(prev.comicApiConfigId)) {
                next.comicApiConfigId = undefined;
                dirty = true;
            }
            if (dirty) {
                saveBindingConfig(next);
                return next;
            }
            return prev;
        });
    }, [isLoaded, apiConfigs, voiceConfigs, presets, worldBooks, regexes, identities]);

    // Navigation management
    useEffect(() => {
        if (level === "global") {
            setOverrideBack(null);
            setSubpageTitle(null);
        } else if (level === "character") {
            const charName = characters.find(c => c.id === selectedCharId)?.name || "角色";
            setSubpageTitle(`${charName} 的绑定`);
            setOverrideBack(() => () => {
                setLevel("global");
                setSelectedCharId("");
            });
        } else if (level === "app") {
            const charName = characters.find(c => c.id === selectedCharId)?.name || "角色";
            const appLabel = selectedAppId ? getAppLabel(selectedAppId) : "";
            setSubpageTitle(`${appLabel} · ${charName}`);
            setOverrideBack(() => () => {
                setLevel("character");
                setSelectedAppId(null);
            });
        }
    }, [level, selectedCharId, selectedAppId, characters, customApps, setSubpageTitle, setOverrideBack]);

    const persist = (newConfig: BindingConfig) => {
        setConfig(newConfig);
        saveBindingConfig(newConfig);
    };

    const updateGlobalSlot = (field: keyof BindingSlot, value: string | string[] | undefined) => {
        const newGlobal = { ...config.globalDefaults, [field]: value || undefined };
        persist({ ...config, globalDefaults: newGlobal });
    };

    const updateCharDefaultSlot = (field: keyof BindingSlot, value: string | string[] | undefined) => {
        const binding = getCharacterBinding(config, selectedCharId);
        const newDefaults = { ...binding.defaults, [field]: value || undefined };
        const newBinding: CharacterBinding = { ...binding, defaults: newDefaults };
        persist(setCharacterBinding(config, newBinding));
    };

    const updateAppSlot = (field: keyof BindingSlot, value: string | string[] | undefined) => {
        if (!selectedAppId) return;
        const binding = getCharacterBinding(config, selectedCharId);
        const appSlot = binding.appOverrides[selectedAppId] || {};
        const newAppSlot = { ...appSlot, [field]: value || undefined };
        const newOverrides = { ...binding.appOverrides, [selectedAppId]: newAppSlot };
        const newBinding: CharacterBinding = { ...binding, appOverrides: newOverrides };
        persist(setCharacterBinding(config, newBinding));
    };

    /** 一次写多个槽位字段（选配置同时清/换模型），避免两次 persist 互相覆盖 */
    const applySlotPatch = (patch: Partial<BindingSlot>) => {
        if (level === "global") {
            persist({ ...config, globalDefaults: { ...config.globalDefaults, ...patch } });
            return;
        }
        const binding = getCharacterBinding(config, selectedCharId);
        if (level === "character") {
            persist(setCharacterBinding(config, { ...binding, defaults: { ...binding.defaults, ...patch } }));
            return;
        }
        if (level === "app" && selectedAppId) {
            const nextSlot = { ...(binding.appOverrides[selectedAppId] || {}), ...patch };
            persist(setCharacterBinding(config, { ...binding, appOverrides: { ...binding.appOverrides, [selectedAppId]: nextSlot } }));
        }
    };

    const resetAppBinding = () => {
        if (!selectedAppId) return;
        const binding = getCharacterBinding(config, selectedCharId);
        const newOverrides = { ...binding.appOverrides };
        delete newOverrides[selectedAppId];
        const newBinding: CharacterBinding = { ...binding, appOverrides: newOverrides };
        persist(setCharacterBinding(config, newBinding));
    };

    const getCurrentSlot = (): BindingSlot => {
        if (level === "global") return config.globalDefaults;
        const binding = getCharacterBinding(config, selectedCharId);
        if (level === "character") return binding.defaults;
        if (level === "app" && selectedAppId) return binding.appOverrides[selectedAppId] || {};
        return {};
    };

    const mergeSlotInto = (target: BindingSlot, slot?: BindingSlot): BindingSlot => {
        if (!slot) return target;
        if (slot.apiConfigId) target.apiConfigId = slot.apiConfigId;
        if (slot.apiModel) target.apiModel = slot.apiModel;
        if (slot.voiceConfigId) target.voiceConfigId = slot.voiceConfigId;
        if (slot.presetId) target.presetId = slot.presetId;
        if (slot.userIdentityId) target.userIdentityId = slot.userIdentityId;
        if (slot.worldBookIds && slot.worldBookIds.length > 0) target.worldBookIds = [...slot.worldBookIds];
        if (slot.regexIds && slot.regexIds.length > 0) target.regexIds = [...slot.regexIds];
        return target;
    };

    const getInheritedSlot = (): BindingSlot => {
        if (level === "global") return {};
        const inherited = mergeSlotInto({}, config.globalDefaults);
        const binding = getCharacterBinding(config, selectedCharId);
        if (level === "character") return inherited;
        mergeSlotInto(inherited, binding.defaults);
        if (level === "app" && selectedAppId) {
            mergeSlotInto(inherited, config.appDefaults?.[selectedAppId]);
        }
        return inherited;
    };

    const getAppSpecificSlot = (appId: string): BindingSlot => {
        const binding = getCharacterBinding(config, selectedCharId);
        const slot = mergeSlotInto({}, config.appDefaults?.[appId]);
        return mergeSlotInto(slot, binding.appOverrides[appId]);
    };

    const getInheritLabel = (): string => {
        if (level === "character") return "继承全局";
        if (level === "app") return "继承上级绑定";
        return "";
    };

    const handleUpdate = (field: keyof BindingSlot, value: string | string[] | undefined) => {
        if (level === "global") updateGlobalSlot(field, value);
        else if (level === "character") updateCharDefaultSlot(field, value);
        else if (level === "app") updateAppSlot(field, value);
    };

    // Count how many fields are overridden in an app slot
    const countOverrides = (slot?: BindingSlot, appId?: string): number => {
        if (!slot) return 0;
        let count = 0;
        if (slot.apiConfigId) count++;
        if (slot.voiceConfigId) count++;
        if (slot.presetId) count++;
        if (slot.userIdentityId) count++;
        if (slot.worldBookIds && slot.worldBookIds.length > 0) count++;
        if ((!appId || canBindRegexInApp(appId)) && slot.regexIds && slot.regexIds.length > 0) count++;
        return count;
    };

    const hasCharacterBinding = (characterId: string): boolean => {
        const binding = config.characterBindings.find(b => b.characterId === characterId);
        if (!binding) return false;
        return Boolean(
            binding.defaults.apiConfigId ||
            binding.defaults.voiceConfigId ||
            binding.defaults.presetId ||
            binding.defaults.userIdentityId ||
            (binding.defaults.worldBookIds && binding.defaults.worldBookIds.length > 0) ||
            (binding.defaults.regexIds && binding.defaults.regexIds.length > 0) ||
            Object.keys(binding.appOverrides).length > 0
        );
    };

    const openCharacterBinding = (characterId: string) => {
        setSelectedCharId(characterId);
        setSelectedAppId(null);
        setActiveSlotSheetField(null);
        setActiveAuxSheetField(null);
        setShowCharacterPicker(false);
        setLevel("character");
    };

    if (!isLoaded) return null;

    const currentSlot = getCurrentSlot();
    const inheritedSlot = getInheritedSlot();
    const inheritLabel = getInheritLabel();
    const appOverrideEntries = [
        ...CONTENT_APP_IDS
            .filter(appId => appIconId(appId) in ICONS)
            .map(appId => ({
                id: appId as string,
                label: CONTENT_APP_LABELS[appId],
                iconId: appIconId(appId),
                iconDataUrl: null as string | null,
                color: APP_OVERRIDE_COLORS[appId],
            })),
        ...customApps.map(app => ({
            id: toCustomAppIconId(app.id) as string,
            label: app.name,
            iconId: "appmarket" as IconId,
            iconDataUrl: app.iconDataUrl ?? null,
            color: "#14b8a6",
        })),
    ];

    const isMultiBindingField = (field: BindingField): field is MultiBindingField =>
        field === "worldBookIds" || field === "regexIds";

    const getBindingFieldLabel = (field: BindingField): string => {
        switch (field) {
            case "apiConfigId": return "API 配置";
            case "voiceConfigId": return "语音 API";
            case "presetId": return "预设";
            case "userIdentityId": return "用户身份";
            case "worldBookIds": return "世界书";
            case "regexIds": return "正则规则";
        }
    };

    const getBindingFieldDescription = (field: BindingField): string => {
        switch (field) {
            case "apiConfigId": return "全局文本生成接口";
            case "voiceConfigId": return "全局语音合成接口";
            case "presetId": return "全局提示词预设";
            case "userIdentityId": return "全局用户身份";
            case "worldBookIds": return "全局启用的世界书";
            case "regexIds": return "全局启用的正则规则";
        }
    };

    const getAuxFieldDescription = (field: AuxBindingField): string => {
        switch (field) {
            case "memorySummaryApiConfigId": return "用于聊天记忆压缩";
            case "embeddingApiConfigId": return "用于语义向量召回";
            case "mascotApiConfigId": return "用于小卷对话与工具调用";
            case "reasoningTranslateApiConfigId": return "用于翻译思考过程（思维链）内容";
            case "qaApiConfigId": return "用于工坊答疑、诊断与内容开发";
            case "koreanSpeechApiConfigId": return "用于把中文台词转写成韩语再朗读";
            case "storyDirectionApiConfigId": return "用于生成群像的下一步走向卡";
            case "moodMusicApiConfigId": return "用于群像按剧情挑心情音乐的歌单";
            case "comicApiConfigId": return "用于生成群像漫画分镜的四格脚本";
        }
    };

    const getAuxFieldLabel = (field: AuxBindingField): string => {
        switch (field) {
            case "memorySummaryApiConfigId": return "记忆总结 API";
            case "embeddingApiConfigId": return "向量召回 API";
            case "mascotApiConfigId": return "小卷助手 API";
            case "reasoningTranslateApiConfigId": return "思维链翻译 API";
            case "qaApiConfigId": return "工坊 API";
            case "koreanSpeechApiConfigId": return "韩语转写 API";
            case "storyDirectionApiConfigId": return "下一步走向 API";
            case "moodMusicApiConfigId": return "心情音乐 API";
            case "comicApiConfigId": return "漫画分镜 API";
        }
    };

    const getBindingFieldOptions = (field: BindingField): { id: string; name: string }[] => {
        switch (field) {
            case "apiConfigId":
                return apiConfigs.map(c => ({ id: c.id, name: c.name || c.provider }));
            case "voiceConfigId":
                // 阿里云配置只负责语音识别（STT），不参与角色发声，不能绑成角色音色
                return voiceConfigs
                    .filter(c => c.provider !== "Aliyun")
                    .map(c => ({ id: c.id, name: c.name || c.provider }));
            case "presetId":
                return presets.map(p => ({ id: p.id, name: p.name }));
            case "userIdentityId":
                return identities.map(i => ({ id: i.id, name: i.name }));
            case "worldBookIds":
                return worldBooks.map(w => ({ id: w.id, name: w.name }));
            case "regexIds":
                return regexes.map(r => ({ id: r.id, name: r.name }));
        }
    };

    const getSlotFieldValueDisplay = (slot: BindingSlot, field: BindingField): { text: string; isEmpty: boolean } => {
        const options = getBindingFieldOptions(field);
        if (isMultiBindingField(field)) {
            const selectedIds = (slot[field] || []).filter(id => options.some(item => item.id === id));
            if (selectedIds.length === 0) return { text: "", isEmpty: true };
            if (selectedIds.length === 1) {
                return { text: options.find(item => item.id === selectedIds[0])?.name || "1 项已选", isEmpty: false };
            }
            return { text: `${selectedIds.length} 项已选`, isEmpty: false };
        }
        const value = slot[field];
        const selected = options.find(item => item.id === value);
        if (!selected) return { text: "", isEmpty: true };
        // 主模型卡：选了配置还能再指定模型
        const model = field === "apiConfigId" ? slot.apiModel : undefined;
        return { text: model ? `${selected.name} · ${model}` : selected.name, isEmpty: false };
    };

    const getInheritedFieldLabel = (field: BindingField, fallback: string): string => {
        const inherited = getSlotFieldValueDisplay(inheritedSlot, field);
        return inherited.isEmpty ? fallback : `继承：${inherited.text}`;
    };

    const getSlotFieldDisplay = (slot: BindingSlot, field: BindingField, emptyText: string): { text: string; isEmpty: boolean; isInherited: boolean } => {
        const current = getSlotFieldValueDisplay(slot, field);
        if (!current.isEmpty) return { ...current, isInherited: false };
        const inherited = getSlotFieldValueDisplay(inheritedSlot, field);
        if (!inherited.isEmpty) return { text: `继承：${inherited.text}`, isEmpty: false, isInherited: true };
        return { text: emptyText, isEmpty: true, isInherited: false };
    };

    const renderBindingFieldIcon = (field: BindingField, size = 23) => {
        const visual = BINDING_FIELD_VISUALS[field];
        const Icon = visual.icon;
        return (
            <span className="binding-choice-icon" style={bindingAccentStyle(visual.color)}>
                <Icon size={size} strokeWidth={1.9} />
            </span>
        );
    };

    const renderAuxFieldIcon = (field: AuxBindingField) => {
        const visual = AUX_FIELD_VISUALS[field];
        const Icon = visual.icon;
        return (
            <span className="binding-choice-icon binding-choice-icon-inline" style={bindingAccentStyle(visual.color)}>
                <Icon size={22} strokeWidth={1.8} />
            </span>
        );
    };

    const auxModelKey = (field: AuxBindingField) => `${field.replace(/ApiConfigId$/, "")}Model` as keyof BindingConfig;

    const getConfigModelOptions = (configId: string | null | undefined): string[] => {
        const found = apiConfigs.find(c => c.id === configId);
        if (!found) return [];
        const list = [found.defaultModel, ...(found.models || [])]
            .map(m => (m || "").trim())
            .filter(Boolean);
        return Array.from(new Set(list));
    };

    /** 配置与模型必须一起写，否则第二次 persist 会拿旧 config 覆盖第一次 */
    const applyAuxConfig = (field: AuxBindingField, configId: string | undefined, model?: string) => {
        persist({
            ...config,
            [field]: configId || undefined,
            [auxModelKey(field)]: configId ? (model || undefined) : undefined,
        });
    };

    const updateAuxModel = (field: AuxBindingField, model: string | undefined) => {
        applyAuxConfig(field, config[field], model);
    };

    const updateAuxField = (field: AuxBindingField, value: string | undefined) => {
        // 换配置时丢掉旧模型，避免拿一个不属于该配置的模型名去请求
        const keepModel = value && value === config[field] ? (config[auxModelKey(field)] as string | undefined) : undefined;
        applyAuxConfig(field, value, keepModel);
    };

    const renderAuxSelect = (
        field: AuxBindingField,
        label: string,
    ) => {
        const currentValue = config[field];
        const options = apiConfigs.map(c => ({ id: c.id, name: c.name || c.provider }));
        const selectedOption = options.find(o => o.id === currentValue);
        const selectedModel = config[auxModelKey(field)] as string | undefined;
        const displayValue = selectedOption
            ? (selectedModel ? `${selectedOption.name} · ${selectedModel}` : selectedOption.name)
            : "继承全局";

        return (
            <button
                key={field}
                type="button"
                className="prefs-row"
                aria-haspopup="dialog"
                onClick={() => {
                    reloadData();
                    setActiveAuxSheetField(field);
                }}
            >
                <div className="flex flex-col flex-1 min-w-0 text-left gap-0.5">
                    <span className="ts-14 font-semibold text-[var(--c-text-title)]">{label}</span>
                    <span className="ts-11 text-[var(--c-text)] opacity-70 truncate">{getAuxFieldDescription(field)}</span>
                </div>
                <span className={selectedOption
                    ? "ts-12 truncate max-w-[46%] shrink-0 text-[var(--c-primary-ink)]"
                    : "ts-12 truncate max-w-[46%] shrink-0 text-[var(--c-text)] opacity-45"}>
                    {displayValue}
                </span>
                <ChevronRight size={16} className="text-[var(--c-icon)] opacity-50 shrink-0" />
            </button>
        );
    };

    const renderBindingSlotCards = (
        slot: BindingSlot,
        emptyText: string,
        onOpenField: (field: BindingField) => void,
        options?: { includeRegex?: boolean },
    ) => {
        const fields: BindingField[] = options?.includeRegex === false
            ? ["apiConfigId", "voiceConfigId", "presetId", "worldBookIds", "userIdentityId"]
            : ["apiConfigId", "voiceConfigId", "presetId", "worldBookIds", "regexIds", "userIdentityId"];
        return (
            <div className="flex flex-col">
                {fields.map(field => {
                    const display = getSlotFieldDisplay(slot, field, emptyText);
                    const valueClassName = [
                        "ts-12 truncate max-w-[46%] shrink-0",
                        display.isEmpty ? "text-[var(--c-text)] opacity-45" : "text-[var(--c-primary-ink)]",
                    ].filter(Boolean).join(" ");
                    return (
                        <button
                            key={field}
                            type="button"
                            className="prefs-row"
                            onClick={() => {
                                reloadData();
                                onOpenField(field);
                            }}
                        >
                            <div className="flex flex-col flex-1 min-w-0 text-left gap-0.5">
                                <span className="ts-14 font-semibold text-[var(--c-text-title)]">{getBindingFieldLabel(field)}</span>
                                <span className="ts-11 text-[var(--c-text)] opacity-70 truncate">{getBindingFieldDescription(field)}</span>
                            </div>
                            <span className={valueClassName}>{display.text}</span>
                            <ChevronRight size={16} className="text-[var(--c-icon)] opacity-50 shrink-0" />
                        </button>
                    );
                })}
            </div>
        );
    };

    const renderGlobalSlotCards = () => (
        renderBindingSlotCards(config.globalDefaults, "未设置", setActiveGlobalSheetField)
    );

    const renderCharacterSlotCards = () => (
        renderBindingSlotCards(currentSlot, inheritLabel, setActiveSlotSheetField)
    );

    // 全局层不允许"未设置"的三项（API/预设/身份）：留空只会触发静默兜底，
    // 直接把兜底值落进存储并去掉未设置选项，所见即所得
    const isRequiredGlobalField = (field: BindingField): boolean =>
        field === "apiConfigId" || field === "presetId" || field === "userIdentityId";

    const renderGlobalPickerSheet = () => {
        if (!activeGlobalSheetField) return null;
        const field = activeGlobalSheetField;
        const label = getBindingFieldLabel(field);
        const options = getBindingFieldOptions(field);
        const isMulti = isMultiBindingField(field);
        const hideUnsetOption = isRequiredGlobalField(field);
        const selectedIds = isMulti ? (config.globalDefaults[field] || []).filter(id => options.some(item => item.id === id)) : [];
        const selectedValue = !isMulti ? config.globalDefaults[field] : undefined;

        const clearSelection = () => {
            updateGlobalSlot(field, undefined);
            if (!isMulti) setActiveGlobalSheetField(null);
        };

        const toggleMulti = (id: string) => {
            if (!isMulti) return;
            const next = selectedIds.includes(id)
                ? selectedIds.filter(item => item !== id)
                : [...selectedIds, id];
            updateGlobalSlot(field, next.length > 0 ? next : undefined);
        };

        return (
            <div className="modal-overlay" data-ui="modal" onClick={() => setActiveGlobalSheetField(null)}>
                <div
                    className="binding-picker-dialog"
                    role="dialog"
                    aria-modal="true"
                    aria-label={`选择${label}`}
                    onClick={(event) => event.stopPropagation()}
                >
                    <div className="binding-picker-header">
                        <button
                            type="button"
                            className="binding-picker-icon-btn"
                            onClick={() => setActiveGlobalSheetField(null)}
                            aria-label="关闭"
                        >
                            <X size={17} />
                        </button>
                        <h3 className="binding-picker-title">选择{label}</h3>
                        {isMulti ? (
                            <button
                                type="button"
                                className="binding-picker-done-btn"
                                onClick={() => setActiveGlobalSheetField(null)}
                            >
                                完成
                            </button>
                        ) : (
                            <span className="binding-picker-header-spacer" />
                        )}
                    </div>
                    <div className="binding-picker-body">
                        <div className="binding-sheet-list">
                            {!hideUnsetOption && (
                                <button
                                    type="button"
                                    className="binding-sheet-option"
                                    data-selected={isMulti ? selectedIds.length === 0 : !selectedValue}
                                    onClick={clearSelection}
                                >
                                    <span className="binding-sheet-check">{(isMulti ? selectedIds.length === 0 : !selectedValue) && <Check size={15} />}</span>
                                    <span className="binding-sheet-option-text">未设置</span>
                                </button>
                            )}
                            {options.length === 0 ? (
                                <div className="binding-sheet-empty">暂无可选{label}，请先在对应设置页面创建。</div>
                            ) : (
                                options.map(option => {
                                    const selected = isMulti ? selectedIds.includes(option.id) : selectedValue === option.id;
                                    return (
                                        <button
                                            key={option.id}
                                            type="button"
                                            className="binding-sheet-option"
                                            data-selected={selected}
                                            aria-pressed={selected}
                                            onClick={() => {
                                                if (isMulti) {
                                                    toggleMulti(option.id);
                                                } else {
                                                    updateGlobalSlot(field, option.id);
                                                    setActiveGlobalSheetField(null);
                                                }
                                            }}
                                        >
                                            <span className="binding-sheet-check">{selected && <Check size={15} />}</span>
                                            <span className="binding-sheet-option-text">{option.name}</span>
                                        </button>
                                    );
                                })
                            )}
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    const renderSlotPickerDialog = () => {
        if (!activeSlotSheetField) return null;
        const field = activeSlotSheetField;
        const label = getBindingFieldLabel(field);
        const options = getBindingFieldOptions(field);
        const isMulti = isMultiBindingField(field);
        const selectedIds = isMulti ? ((currentSlot[field as MultiBindingField] || []).filter(id => options.some(item => item.id === id))) : [];
        const selectedValue = !isMulti ? currentSlot[field as SingleBindingField] : undefined;
        const emptyLabel = level === "global" ? "未设置" : getInheritedFieldLabel(field, inheritLabel);
        const canPickModel = field === "apiConfigId";
        const modelStepConfigId = canPickModel ? pickerModelConfigId : null;

        const closePicker = () => {
            setActiveSlotSheetField(null);
            setPickerModelConfigId(null);
        };

        const clearSelection = () => {
            if (canPickModel) applySlotPatch({ apiConfigId: undefined, apiModel: undefined });
            else handleUpdate(field, undefined);
            if (!isMulti) closePicker();
        };

        const toggleMulti = (id: string) => {
            if (!isMulti) return;
            const next = selectedIds.includes(id)
                ? selectedIds.filter(item => item !== id)
                : [...selectedIds, id];
            handleUpdate(field, next.length > 0 ? next : undefined);
        };

        return (
            <div className="modal-overlay" data-ui="modal" onClick={closePicker}>
                <div
                    className="binding-picker-dialog"
                    role="dialog"
                    aria-modal="true"
                    aria-label={`选择${label}`}
                    onClick={(event) => event.stopPropagation()}
                >
                    <div className="binding-picker-header">
                        {modelStepConfigId ? (
                            <button
                                type="button"
                                className="binding-picker-icon-btn"
                                onClick={() => setPickerModelConfigId(null)}
                                aria-label="返回"
                            >
                                <ChevronLeft size={17} />
                            </button>
                        ) : (
                            <button
                                type="button"
                                className="binding-picker-icon-btn"
                                onClick={closePicker}
                                aria-label="关闭"
                            >
                                <X size={17} />
                            </button>
                        )}
                        <h3 className="binding-picker-title">{modelStepConfigId ? "选择模型" : `选择${label}`}</h3>
                        {modelStepConfigId ? (
                            <button
                                type="button"
                                className="binding-picker-icon-btn"
                                onClick={closePicker}
                                aria-label="关闭"
                            >
                                <X size={17} />
                            </button>
                        ) : isMulti ? (
                            <button
                                type="button"
                                className="binding-picker-done-btn"
                                onClick={closePicker}
                            >
                                完成
                            </button>
                        ) : (
                            <span className="binding-picker-header-spacer" />
                        )}
                    </div>
                    <div className="binding-picker-body">
                        <div className="binding-sheet-list">
                            {modelStepConfigId ? (
                                renderModelOptions(modelStepConfigId, currentSlot.apiModel, model => {
                                    applySlotPatch({ apiModel: model });
                                    closePicker();
                                })
                            ) : (
                                <>
                                    {/* 全局层的 API/预设/身份不提供"未设置"（角色/应用层保留"跟随上级"） */}
                                    {!(level === "global" && isRequiredGlobalField(field)) && (
                                        <button
                                            type="button"
                                            className="binding-sheet-option"
                                            data-selected={isMulti ? selectedIds.length === 0 : !selectedValue}
                                            onClick={clearSelection}
                                        >
                                            <span className="binding-sheet-check">{(isMulti ? selectedIds.length === 0 : !selectedValue) && <Check size={15} />}</span>
                                            <span className="binding-sheet-option-text">{emptyLabel}</span>
                                        </button>
                                    )}
                                    {options.length === 0 ? (
                                        <div className="binding-sheet-empty">暂无可选{label}，请先在对应设置页面创建。</div>
                                    ) : (
                                        options.map(option => {
                                            const selected = isMulti ? selectedIds.includes(option.id) : selectedValue === option.id;
                                            return (
                                                <button
                                                    key={option.id}
                                                    type="button"
                                                    className="binding-sheet-option"
                                                    data-selected={selected}
                                                    aria-pressed={selected}
                                                    onClick={() => {
                                                        if (isMulti) {
                                                            toggleMulti(option.id);
                                                            return;
                                                        }
                                                        if (canPickModel) {
                                                            // 换卡就丢掉旧模型；同一张卡则保留已选模型
                                                            applySlotPatch({
                                                                apiConfigId: option.id,
                                                                apiModel: selected ? currentSlot.apiModel : undefined,
                                                            });
                                                            if (getConfigModelOptions(option.id).length > 0) {
                                                                setPickerModelConfigId(option.id);
                                                                return;
                                                            }
                                                        } else {
                                                            handleUpdate(field, option.id);
                                                        }
                                                        closePicker();
                                                    }}
                                                >
                                                    <span className="binding-sheet-check">{selected && <Check size={15} />}</span>
                                                    <span className="binding-sheet-option-text">{option.name}</span>
                                                </button>
                                            );
                                        })
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    const renderModelOptions = (configId: string, selectedModel: string | undefined, onPick: (model: string | undefined) => void) => {
        const models = getConfigModelOptions(configId);
        const configName = apiConfigs.find(c => c.id === configId)?.name || "所选配置";
        return (
            <>
                <div className="binding-sheet-hint">{configName} · 不指定就跟着配置的默认模型走</div>
                <button
                    type="button"
                    className="binding-sheet-option"
                    data-selected={!selectedModel}
                    onClick={() => onPick(undefined)}
                >
                    <span className="binding-sheet-check">{!selectedModel && <Check size={15} />}</span>
                    <span className="binding-sheet-option-text">默认模型</span>
                </button>
                {models.length === 0 ? (
                    <div className="binding-sheet-empty">这张配置还没有模型列表，先到 API 设置里刷新模型。</div>
                ) : (
                    models.map(model => {
                        const selected = selectedModel === model;
                        return (
                            <button
                                key={model}
                                type="button"
                                className="binding-sheet-option"
                                data-selected={selected}
                                aria-pressed={selected}
                                onClick={() => onPick(model)}
                            >
                                <span className="binding-sheet-check">{selected && <Check size={15} />}</span>
                                <span className="binding-sheet-option-text">{model}</span>
                            </button>
                        );
                    })
                )}
            </>
        );
    };

    const renderAuxPickerDialog = () => {
        if (!activeAuxSheetField) return null;
        const field = activeAuxSheetField;
        const label = getAuxFieldLabel(field);
        const options = apiConfigs.map(c => ({ id: c.id, name: c.name || c.provider }));
        const selectedValue = config[field];
        const modelStepConfigId = pickerModelConfigId;
        const selectedModel = config[auxModelKey(field)] as string | undefined;

        const closePicker = () => {
            setActiveAuxSheetField(null);
            setPickerModelConfigId(null);
        };

        return (
            <div className="modal-overlay" data-ui="modal" onClick={closePicker}>
                <div
                    className="binding-picker-dialog"
                    role="dialog"
                    aria-modal="true"
                    aria-label={`选择${label}`}
                    onClick={(event) => event.stopPropagation()}
                >
                    <div className="binding-picker-header">
                        {modelStepConfigId ? (
                            <button
                                type="button"
                                className="binding-picker-icon-btn"
                                onClick={() => setPickerModelConfigId(null)}
                                aria-label="返回"
                            >
                                <ChevronLeft size={17} />
                            </button>
                        ) : (
                            <button
                                type="button"
                                className="binding-picker-icon-btn"
                                onClick={closePicker}
                                aria-label="关闭"
                            >
                                <X size={17} />
                            </button>
                        )}
                        <h3 className="binding-picker-title">{modelStepConfigId ? "选择模型" : `选择${label}`}</h3>
                        {modelStepConfigId ? (
                            <button
                                type="button"
                                className="binding-picker-icon-btn"
                                onClick={closePicker}
                                aria-label="关闭"
                            >
                                <X size={17} />
                            </button>
                        ) : (
                            <span className="binding-picker-header-spacer" />
                        )}
                    </div>
                    <div className="binding-picker-body">
                        <div className="binding-sheet-list">
                            {modelStepConfigId ? (
                                renderModelOptions(modelStepConfigId, selectedModel, model => {
                                    updateAuxModel(field, model);
                                    closePicker();
                                })
                            ) : (
                                <>
                                    <button
                                        type="button"
                                        className="binding-sheet-option"
                                        data-selected={!selectedValue}
                                        onClick={() => {
                                            updateAuxField(field, undefined);
                                            closePicker();
                                        }}
                                    >
                                        <span className="binding-sheet-check">{!selectedValue && <Check size={15} />}</span>
                                        <span className="binding-sheet-option-text">继承全局</span>
                                    </button>
                                    {options.length === 0 ? (
                                        <div className="binding-sheet-empty">暂无可选 API 配置，请先在 API 设置页面创建。</div>
                                    ) : (
                                        options.map(option => {
                                            const selected = selectedValue === option.id;
                                            return (
                                                <button
                                                    key={option.id}
                                                    type="button"
                                                    className="binding-sheet-option"
                                                    data-selected={selected}
                                                    aria-pressed={selected}
                                                    onClick={() => {
                                                        updateAuxField(field, option.id);
                                                        // 这张配置有模型列表 → 直接进第二步选模型
                                                        if (getConfigModelOptions(option.id).length > 0) {
                                                            setPickerModelConfigId(option.id);
                                                        } else {
                                                            closePicker();
                                                        }
                                                    }}
                                                >
                                                    <span className="binding-sheet-check">{selected && <Check size={15} />}</span>
                                                    <span className="binding-sheet-option-text">{option.name}</span>
                                                </button>
                                            );
                                        })
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    const renderCharacterPickerDialog = () => {
        if (!showCharacterPicker) return null;
        return (
            <div className="modal-overlay" data-ui="modal" onClick={() => setShowCharacterPicker(false)}>
                <div
                    className="modal-dialog"
                    role="dialog"
                    aria-modal="true"
                    aria-label="选择角色"
                    onClick={(event) => event.stopPropagation()}
                >
                    <span className="modal-header-title">选择角色</span>
                    {characters.length === 0 ? (
                        <span className="menu-desc">暂无角色，请先在角色库中创建角色。</span>
                    ) : (
                        <div className="chat-contact-list">
                            {characters.map(char => {
                                const configured = hasCharacterBinding(char.id);
                                const name = char.name || "未命名角色";
                                return (
                                    <button
                                        key={char.id}
                                        type="button"
                                        className="chat-contact-item binding-contact-item"
                                        onClick={() => openCharacterBinding(char.id)}
                                    >
                                        <span className="chat-contact-avatar">
                                            {char.avatar ? (
                                                <img src={char.avatar} alt="" />
                                            ) : (
                                                <span className="chat-contact-avatar-fallback">
                                                    {name.charAt(0)}
                                                </span>
                                            )}
                                        </span>
                                        <span className="chat-contact-name">{name}</span>
                                        {configured && <span className="binding-contact-badge" aria-label="已配置" />}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>
        );
    };

    return (
        <div className="flex flex-col gap-[24px]">
            {/* 层级胶囊（2026-11-16）：一行直接切全局 / 角色 / 应用 */}
            <div className="binding-level-pills">
                <button
                    type="button"
                    className="binding-level-pill"
                    data-active={level === "global"}
                    onClick={() => {
                        setLevel("global");
                        setSelectedCharId("");
                        setSelectedAppId(null);
                    }}
                >
                    全局
                </button>
                <button
                    type="button"
                    className="binding-level-pill"
                    data-active={level === "character"}
                    onClick={() => {
                        if (selectedCharId) setLevel("character");
                        else setShowCharacterPicker(true);
                    }}
                >
                    角色
                </button>
                <button
                    type="button"
                    className="binding-level-pill"
                    data-active={level === "app"}
                    onClick={() => {
                        if (selectedAppId) setLevel("app");
                        else if (selectedCharId) setLevel("character");
                        else setShowCharacterPicker(true);
                    }}
                >
                    应用
                </button>
            </div>

            {/* Level 1: Global defaults + character action */}
            {level === "global" && (
                <>
                    <section className="prefs-block">
                        <span className="prefs-block-label">Global Defaults</span>
                        {renderGlobalSlotCards()}
                        <button type="button" className="prefs-row" onClick={() => setShowCharacterPicker(true)}>
                            <span className="ts-14 text-[var(--c-text)]">＋ 为角色配置专属绑定</span>
                        </button>
                    </section>

                    <section className="prefs-block">
                        <span className="prefs-block-label">Auxiliary API</span>
                        <div className="flex flex-col">
                            {renderAuxSelect("memorySummaryApiConfigId", "记忆总结 API")}
                            {renderAuxSelect("embeddingApiConfigId", "向量召回 API")}
                            {renderAuxSelect("mascotApiConfigId", "小卷助手 API")}
                            {renderAuxSelect("qaApiConfigId", "工坊 API")}
                            {renderAuxSelect("reasoningTranslateApiConfigId", "思维链翻译 API")}
                            {renderAuxSelect("koreanSpeechApiConfigId", "韩语转写 API")}
                            {renderAuxSelect("storyDirectionApiConfigId", "下一步走向 API")}
                            {renderAuxSelect("moodMusicApiConfigId", "心情音乐 API")}
                            {renderAuxSelect("comicApiConfigId", "漫画分镜 API")}
                        </div>
                    </section>
                </>
            )}
            {renderGlobalPickerSheet()}
            {renderSlotPickerDialog()}
            {renderAuxPickerDialog()}
            {renderCharacterPickerDialog()}

            {/* Level 2: Character binding details */}
            {level === "character" && (
                <>
                    <section className="prefs-block">
                        <span className="prefs-block-label">Character Defaults</span>
                        {renderCharacterSlotCards()}
                    </section>

                    <section className="prefs-block">
                        <span className="prefs-block-label">App Bindings</span>
                        <div className="flex flex-col">
                            {appOverrideEntries.map(app => {
                                const appSlot = getAppSpecificSlot(app.id);
                                const overrideCount = countOverrides(appSlot, app.id);
                                return (
                                    <button
                                        key={app.id}
                                        onClick={() => {
                                            setSelectedAppId(app.id);
                                            setActiveSlotSheetField(null);
                                            setLevel("app");
                                        }}
                                        className="prefs-row"
                                        aria-label={`${app.label}应用绑定`}
                                    >
                                        <span className="binding-app-icon h-8 w-8 shrink-0 overflow-hidden rounded-lg grid place-items-center" style={bindingAccentStyle(app.color)}>
                                            {app.iconDataUrl ? (
                                                <img src={app.iconDataUrl} alt="" className="h-full w-full object-cover" />
                                            ) : (
                                                <IconGlyph id={app.iconId} className="binding-app-icon-glyph" />
                                            )}
                                        </span>
                                        <div className="flex flex-col flex-1 min-w-0 text-left gap-0.5">
                                            <span className="ts-14 font-semibold text-[var(--c-text-title)] truncate">{app.label}</span>
                                            <span className="ts-11 text-[var(--c-text)] opacity-70 truncate">
                                                {overrideCount > 0 ? `${overrideCount} 项单独设置` : "继承角色绑定"}
                                            </span>
                                        </div>
                                        <ChevronRight size={16} className="text-[var(--c-icon)] opacity-50 shrink-0" />
                                    </button>
                                );
                            })}
                        </div>
                    </section>
                </>
            )}

            {/* Level 3: App binding */}
            {level === "app" && (
                <>
                    <section className="prefs-block">
                        <span className="prefs-block-label">App Binding</span>
                        {renderBindingSlotCards(currentSlot, inheritLabel, setActiveSlotSheetField, {
                            includeRegex: canBindRegexInApp(selectedAppId),
                        })}
                    </section>

                    <div className="prefs-block">
                        <button type="button" className="prefs-row" onClick={resetAppBinding}>
                            <span className="ts-14 text-[var(--c-danger)]">重置此应用绑定</span>
                        </button>
                    </div>
                </>
            )}
        </div>
    );
}
