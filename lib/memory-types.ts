// lib/memory-types.ts

import type { ContentAppId } from "./settings-types";

export type MemoryEntry = {
    id: string;
    characterId: string;
    sourceApp: ContentAppId;
    /**
     * long_term = 总结管线产出的长期记忆（参考级）
     * core      = 已废弃（2026-10-15 砍掉，不再生成）
     * archive   = 人工确认的归档（长文档，重量级＝世界书同级）
     */
    type: "long_term" | "core" | "archive";
    content: string;
    embedding?: number[];
    importance: number;         // 0-1
    createdAt: string;
    updatedAt: string;
    sourceMessageIds?: string[];
    metadata?: Record<string, unknown>;
};

export type MemoryConfig = {
    autoSummarizeEnabled: boolean;          // whether auto-summarization runs after N events
    autoBuildCoreEnabled: boolean;          // whether core memories rebuild after long-term summarization
    vectorRecallEnabled: boolean;           // whether vector embedding recall is used for memory retrieval
    maxLongTermEntries: number;
    summarizationEventInterval: number;     // trigger summarization every N events
    coreSummarizationInterval: number;      // trigger core-memory rebuild every N new long-term memories
    shortTermTokenBudget: number;           // token limit for short-term event log
    coreMemoryTokenBudget: number;          // token limit for injected core memories
    longTermTokenBudget: number;            // token limit for injected long-term memories
    summarizationPrompt: string;            // user-editable prompt template for memory summarization
    coreMemoryPrompt: string;               // user-editable prompt template for core-memory extraction
    vnSummaryPrompt: string;                // user-editable prompt for VN chapter summarization
    shortTermAllowedSources?: {
        chat?: boolean;
        group_chat?: boolean;
        moments?: boolean;
        checkphone?: boolean;
        diary?: boolean;
        xiaohongshu?: boolean;
        interview_magazine?: boolean;
        cocreate?: boolean;
        game?: boolean;
        story?: boolean;
        vn?: boolean;
        adventure?: boolean;
        custom_app?: boolean;
        /** 群像剧本（按剧本归档，挂到参与角色） */
        ensemble?: boolean;
    };
    /**
     * 防污染·墓碑：被用户删除/拒绝的记忆内容指纹（contentHash）。
     * 后续总结若再生成相同指纹的内容，将被直接丢弃，避免「删了又冒出来」。
     */
    deletedMemoryHashes?: string[];
    /**
     * 归档确认制开关（true = 总结只产出草稿，需用户确认后才入库）。
     * 全平台统一走人工确认。
     */
    archiveConfirmEnabled?: boolean;
};

export type MemorySearchResult = {
    entry: MemoryEntry;
    score: number;
};

/**
 * Default summarization prompt template.
 * Placeholders: {{char}}, {{earliest}}, {{latest}}, {{events}}
 */
export const DEFAULT_SUMMARIZATION_PROMPT = `你是一个记忆归档整理助手。请将以下事件记录整理为一段归档式长期记忆。

角色：{{char}}
时间跨度：{{earliest}} 至 {{latest}}

事件记录：
{{events}}

要求：
- 第三人称、按时间顺序分段叙述，每段以【时间段】开头（例：【2024年12月初 周一 上午】），时间粒度以事件密度为准
- 每段是连贯的叙事段落，写清事件经过、人物言行与反应，不要要点罗列
- 保留具体事实：人名、地点、物品、金额、承诺、约定，不得省略或改写
- 保留用户分享的个人信息（生日、偏好、习惯、关系）
- 语气客观克制，不评价、不推测、不虚构未记录的内容
- 篇幅随事件量伸缩，不注水、不刻意删减
- 结尾另起一段输出【关键锚点】：以「·」列表归纳物品状态、重要事实澄清、未决隐患、关系变化
- 不输出 JSON 或其他格式标记

归档：`;

/**
 * Default core-memory summarization prompt template.
 * Placeholders: {{char}}, {{earliest}}, {{latest}}, {{events}}
 */
export const DEFAULT_CORE_MEMORY_PROMPT = `你是一个核心记忆整理助手。请根据以下长期记忆记录，为{{char}}整理一段“核心记忆”总结。

角色：{{char}}
时间跨度：{{earliest}} 至 {{latest}}

长期记忆记录：
{{events}}

要求：
- 突出最关键、最稳定、最影响关系判断的事实
- 确认在一起 / 确认分手 / 复合
- 订婚 / 结婚 / 离婚
- 恋爱周年、结婚纪念日、在一起多久
- 明确的长期关系身份（如恋人、前任、配偶）
- 共同生活的重要里程碑（如同居、见家长、共同养宠物）
- 普通日常聊天
- 一般情绪波动
- 暂时性的矛盾或暧昧
- 普通偏好信息
- 任何不确定、推测性的内容
- 用第三人称，事实性描述
- 80-180字
- 不要使用 JSON、列表符号、标题或格式标记

核心记忆总结：`;

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
    autoSummarizeEnabled: true,
    /** 核心记忆管线已砍掉（2026-10-15），强制 false；设置页不再提供开关 */
    autoBuildCoreEnabled: false,
    vectorRecallEnabled: true,
    maxLongTermEntries: 500,
    summarizationEventInterval: 80,
    coreSummarizationInterval: 5,
    shortTermTokenBudget: 100000,
    coreMemoryTokenBudget: 100000,
    longTermTokenBudget: 100000,
    summarizationPrompt: DEFAULT_SUMMARIZATION_PROMPT,
    coreMemoryPrompt: DEFAULT_CORE_MEMORY_PROMPT,
    vnSummaryPrompt: "",
    shortTermAllowedSources: {
        chat: true,
        group_chat: true,
        moments: true,
        checkphone: true,
        diary: true,
        xiaohongshu: true,
        interview_magazine: true,
        cocreate: true,
        game: true,
        story: true,
        vn: true,
        adventure: true,
        custom_app: true,
        ensemble: true,
    },
    deletedMemoryHashes: [],
    archiveConfirmEnabled: true,
};

/**
 * 内容指纹：归一化（去空白/标点、统一小写）后算一个稳定 hash。
 * 用于去重与墓碑比对，避免「同一条内容重复入库 / 删了又冒出来」。
 */
export function computeContentHash(content: string): string {
    const normalized = content
        .replace(/[\s\u3000]+/g, "")
        .replace(/[.,!?;:'"，。！？；：、·…—\-（）()【】\[\]《》""'']/g, "")
        .toLowerCase();
    // FNV-1a 32-bit
    let h = 0x811c9dc5;
    for (let i = 0; i < normalized.length; i++) {
        h ^= normalized.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ("0000000" + h.toString(16)).slice(-8) + "_" + normalized.length;
}
