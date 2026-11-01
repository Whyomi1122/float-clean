// lib/listen-together-engine.ts — 一起听 AI 引擎
//
// 独立于主聊天链路的轻量引擎:角色人设走绑定槽 "listen"(缺省回退全局),
// 注入 now_playing(正在播放的歌+歌词当前句),输出一段口语化短评。
// 不走 function-call:一期角色排歌由 DJ 工具(已接入主聊天)承担,
// 一起听页内角色以"说话+歌卡"呈现。

import type { ApiConfig, PresetConfig, RegexConfig, WorldBookConfig } from "./settings-types";
import type { AssemblerInput, LLMMessage } from "./llm-prompt-assembler";
import { loadCharacters } from "./character-storage";
import type { Character } from "./character-types";
import {
    loadBindingConfig,
    loadApiConfigs,
    loadPresets,
    loadWorldBooks,
    loadRegexes,
    resolveBinding,
    resolveUserIdentity,
} from "./settings-storage";
import { assemblePromptPayload } from "./llm-prompt-assembler";
import { loadMemoryConfig } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { prepareShortTermContext } from "./short-term-assembler";
import { getCustomStickerExample, getCustomStickerNames } from "./custom-sticker-storage";
import { previewMessagesForApi, sendLLMRequest } from "./chat-engine";
import { buildNowPlayingPromptBlock } from "./music-now-playing";
import type { ListenMessage } from "./listen-together-storage";

type ListenResolved = {
    apiConfig: ApiConfig;
    preset: PresetConfig | null;
    regexes: RegexConfig[];
    llmMessages: LLMMessage[];
    ownerName: string;
};

async function resolveListenAssemblerInput(character: Character): Promise<ListenResolved> {
    const bindings = loadBindingConfig();
    const activeSlot = resolveBinding(bindings, character.id, "listen");

    if (!activeSlot.apiConfigId) {
        throw new Error("未配置 API,请先在全局设置里绑定 API。");
    }
    const apiConfig = loadApiConfigs().find(entry => entry.id === activeSlot.apiConfigId);
    if (!apiConfig) throw new Error("一起听的 API 配置不存在。");

    const presets = loadPresets();
    let preset = activeSlot.presetId ? presets.find(entry => entry.id === activeSlot.presetId) ?? null : null;
    if (!preset) preset = presets.find(entry => entry.builtIn) ?? null;

    const allWorldBooks = loadWorldBooks();
    const worldBooks = (activeSlot.worldBookIds || [])
        .map(id => allWorldBooks.find(entry => entry.id === id))
        .filter(Boolean) as WorldBookConfig[];

    const allRegexes = loadRegexes();
    const regexes = (activeSlot.regexIds || [])
        .map(id => allRegexes.find(entry => entry.id === id))
        .filter(Boolean) as RegexConfig[];

    const userIdentity = resolveUserIdentity(character.id, "listen");

    const memConfig = loadMemoryConfig();
    const prepared = prepareShortTermContext(character.id, "listen", { history: [] });
    const [coreResults, longResults] = await Promise.all([
        retrieveCoreMemoriesForPrompt(character.id, memConfig).catch(() => []),
        retrieveMemoriesForPrompt(character.id, prepared.wbActivationContext, memConfig).catch(() => []),
    ]);

    const llmMessages = assemblePromptPayload({
        character,
        history: [],
        preset,
        worldBooks,
        regexes,
        userIdentity,
        appId: "listen",
        coreMemories: formatCoreMemories(coreResults),
        longTermMemories: formatLongTermMemories(longResults),
        worldBookActivationContext: prepared.wbActivationContext || undefined,
        recentBlocks: prepared.recentBlocks,
        unifiedRecentItems: prepared.unifiedRecentItems,
        customStickerNames: getCustomStickerNames(character.id),
        customStickerExample: getCustomStickerExample(character.id),
        musicNowPlaying: buildNowPlayingPromptBlock(),
    } as AssemblerInput);

    return { apiConfig, preset, regexes, llmMessages, ownerName: character.name };
}

const SCENE_INSTRUCTION = (userName: string, contextHint: string) =>
    [
        `[listen_together_scene]`,
        `此刻你正和${userName}一起听歌(独立场景,不是主聊天)。`,
        `—— 对方刚发来一段话或一个动作,请以你的角色身份自然回应。`,
        `要求:口语化、短小(一两句话,最多三句),像戴着一只耳机坐在旁边随口聊。`,
        `可以聊当下的歌、歌手、旋律、歌词里戳到你的那一句,也可以借歌说起你们的事。`,
        `不要输出动作括号旁白以外的长段描写;不要复述歌词原文超过一句。`,
        contextHint ? `场景提示:${contextHint}` : "",
        `[/listen_together_scene]`,
    ].filter(Boolean).join("\n");

/**
 * 生成一条角色回应。
 * @param character 一起听的角色
 * @param userName  用户当前身份名
 * @param history   一起听会话历史(最近若干条)
 * @param userText  用户刚说的话;空串表示无用户输入(切歌/暂停等场景触发)
 * @param contextHint 场景提示(如"刚切到一首新歌"/"对方暂停了播放")
 */
export async function generateListenReply(
    character: Character,
    userName: string,
    history: ListenMessage[],
    userText: string,
    contextHint?: string,
): Promise<string> {
    const resolved = await resolveListenAssemblerInput(character);

    const recentHistory: LLMMessage[] = history.slice(-12).map(m => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.text,
    }));

    const messages: LLMMessage[] = [
        ...resolved.llmMessages,
        ...recentHistory,
        {
            role: "user",
            content: SCENE_INSTRUCTION(userName, contextHint ?? "") + (userText ? `\n${userName}:${userText}` : `\n(${userName}没有说话,等待你的反应)`),
            _debugMeta: { marker: "listen_together_trigger" },
        },
    ];

    const raw = await sendLLMRequest(
        resolved.apiConfig,
        resolved.preset,
        messages,
        resolved.regexes,
        { characterName: `一起听:${resolved.ownerName}` },
        { appId: "listen", appTags: ["listen", "music"] },
    );
    return raw.trim();
}
