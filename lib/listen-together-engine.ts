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
import { buildLyricQuotaNote } from "./listen-together-lyrics";
import type { ListenMessage } from "./listen-together-storage";
import { getDailyPushCount, getListenPushLimit } from "./listen-together-storage";

type ListenResolved = {    apiConfig: ApiConfig;
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
        `【可选动作】想主动放歌时,在回复最后另起一行写一个标签(最多一个):`,
        `  [点歌:歌名 - 歌手]  立刻换这首`,
        `  [排队:歌名 - 歌手]  排到队列后面`,
        `  [切歌]              切下一首`,
        `只有真的很想放才写;不确定、或者只是想聊聊,就不要写。标签会被隐藏,不要解释它。`,
        `[/listen_together_scene]`,
    ].filter(Boolean).join("\n");

/**
 * 每天的推歌额度提示（一天 8 首，可在存储里用 localStorage 覆盖）。
 * 空串表示不用提示。
 */
function buildPushQuotaNote(characterId: string): string {
    const limit = getListenPushLimit();
    if (limit <= 0) return `【推歌额度】今天不要再点歌或排歌了。`;
    const used = getDailyPushCount(characterId);
    const left = Math.max(0, limit - used);
    if (left === 0) {
        return `【推歌额度】今天你已经推了 ${used} 首,额度用完了,这一轮不要写 [点歌] 或 [排队],想换歌先问问对方。`;
    }
    if (left <= 2) {
        return `【推歌额度】今天还剩 ${left} 首,省着点用,没有特别合适的就别推。`;
    }
    return "";
}

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
): Promise<{ text: string; actions: ListenReplyAction[] }> {
    const resolved = await resolveListenAssemblerInput(character);

    // 用户刚发的那句话已经在 history 里了，触发消息里不要再拼一次（否则模型看到两遍）
    const historyForPrompt = userText
        ? history.filter((m, i) => !(i === history.length - 1 && m.role === "user" && m.text.trim() === userText.trim()))
        : history;
    const recentHistory: LLMMessage[] = historyForPrompt.slice(-12).map(m => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.text,
    }));

    const lyricNote = buildLyricQuotaNote(character.id);
    const pushNote = buildPushQuotaNote(character.id);
    const messages: LLMMessage[] = [
        ...resolved.llmMessages,
        ...recentHistory,
        {
            role: "user",
            content: SCENE_INSTRUCTION(userName, contextHint ?? "")
                + (lyricNote ? `\n${lyricNote}` : "")
                + (pushNote ? `\n${pushNote}` : "")
                + (userText ? `\n${userName}:${userText}` : `\n(${userName}没有说话,等待你的反应)`),
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
    return parseListenActionTags(raw);
}

/**
 * 动作标签协议：不走 function-call，保持轻量（一起听是短对话，塞工具定义太重）。
 * 模型可以在回复最后额外写一行：
 *   [点歌:歌名 - 歌手] / [排队:歌名 - 歌手] / [切歌]
 * 解析后从正文里抹掉，绝不让标签露给用户。
 */
export type ListenReplyAction =
    | { kind: "play"; query: string }
    | { kind: "queue"; query: string }
    | { kind: "next" };

const ACTION_TAG_RE = /\[(点歌|排队|切歌)(?:[:：]([^\]\n]+))?\]/g;

export function parseListenActionTags(raw: string): { text: string; actions: ListenReplyAction[] } {
    const actions: ListenReplyAction[] = [];
    const text = raw
        .replace(ACTION_TAG_RE, (_match, kind: string, arg?: string) => {
            if (actions.length >= 2) return ""; // 一条回复最多两个动作，防它贪心
            const query = (arg || "").trim();
            if (kind === "切歌") actions.push({ kind: "next" });
            else if (query) actions.push({ kind: kind === "点歌" ? "play" : "queue", query });
            return "";
        })
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    return { text, actions };
}
