/**
 * 番外剧本创建（2026-11-27）
 *
 * 口径：番外 = **另一个剧本对象**，不是主剧本里的一条分支。
 *   · 阵容 / 世界书 / 模型 / 设置 从父剧本复制（阵容是人设快照，天然只影响本剧本）；
 *   · 世界书**强制复制副本**（避免在番外里改到主线用的那一份）；
 *   · 开场白清空，场景设定预填「每轮 2~3 人上场」；
 *   · 剧情时间继承父剧本当前时刻（之后在番外功能页单独拨）。
 *
 * ⚠️ 不带任何内容继承：turns / archives / chapters / storyDirection 全部从空开始。
 */

import type { EnsembleScript } from "./ensemble-storage";
import { loadWorldBooks, saveWorldBooks } from "./settings-storage";
import { getStoryNow, setStoryNow } from "./story-clock";

export type SideStoryCreateOptions = {
    parent: EnsembleScript;
    title: string;
    /** 默认 true：把父剧本绑定的世界书复制成副本（推荐，避免互相影响） */
    copyWorldBooks?: boolean;
};

export type SideStoryCreateResult = {
    script: EnsembleScript;
    copiedWorldBooks: { from: string; to: string; title: string }[];
};

const SETTINGS_KEYS = [
    "charsPerTurn",
    "contextLimit",
    "narrativePov",
    "onlineSync",
    "fontSource",
    "fontUrl",
    "fontSize",
    "apiConfigIdOverride",
    "modelOverride",
    "statusPanel",
    "timeAwareness",
    "storyboardMultiReference",
    "customCss",
] as const;

/** 复制父剧本绑定的世界书，返回新 id 列表 */
function copyWorldBooksOf(parent: EnsembleScript): {
    ids: string[];
    copied: { from: string; to: string; title: string }[];
} {
    const boundIds = parent.worldBookIds ?? [];
    if (boundIds.length === 0) return { ids: [], copied: [] };

    const books = loadWorldBooks();
    const next = [...books];
    const copied: { from: string; to: string; title: string }[] = [];
    const newIds: string[] = [];

    for (const id of boundIds) {
        const source = books.find(book => book.id === id);
        if (!source) continue;
        const clone = JSON.parse(JSON.stringify(source)) as typeof source;
        clone.id = `wb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        clone.name = `${source.name}（番外：${parent.title}）`;
        clone.updatedAt = Date.now();
        next.push(clone);
        copied.push({ from: source.id, to: clone.id, title: clone.name });
        newIds.push(clone.id);
    }

    if (copied.length > 0) saveWorldBooks(next);
    return { ids: newIds, copied };
}

/** 建一个番外剧本（只构造对象，落库由调用方决定） */
export function buildSideStoryScript(options: SideStoryCreateOptions): SideStoryCreateResult {
    const { parent, title, copyWorldBooks = true } = options;
    const now = new Date().toISOString();

    const { ids: worldBookIds, copied } = copyWorldBooks
        ? copyWorldBooksOf(parent)
        : { ids: [...(parent.worldBookIds ?? [])], copied: [] };

    const script: EnsembleScript = {
        id: `ens_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        title: title.trim() || `${parent.title} · 番外`,
        personaId: parent.personaId,
        createdAt: now,
        updatedAt: now,
        // 阵容：人设快照深拷贝（之后改角色卡不影响本剧本）
        cast: (parent.cast ?? []).map(member => ({
            id: member.id,
            name: member.name,
            avatar: member.avatar,
            persona: member.persona,
        })),
        turns: [],
        worldBookIds,
        // 开场白清空：番外要自己的开场
        openingMessage: "",
        // 场景设定预填一行（案件 App R14 的口径）
        background: "每轮 2~3 人上场，不必每轮相同。",
        parentScriptId: parent.id,
        sideStory: true,
    };

    // 设置项按白名单复制（不复制 turns/archives/章节/走向卡等剧情侧字段）
    const sourceRecord = parent as unknown as Record<string, unknown>;
    const targetRecord = script as unknown as Record<string, unknown>;
    for (const key of SETTINGS_KEYS) {
        if (sourceRecord[key] !== undefined) targetRecord[key] = sourceRecord[key];
    }

    return { script, copiedWorldBooks: copied };
}

/**
 * 建番外 + 落库前的收尾：继承父剧本的剧情时刻（这一步要写进时间线，所以放在这里）。
 * 调用方负责 saveOrUpdateEnsembleScript + setScripts。
 */
export function inheritStoryClock(parent: EnsembleScript, child: EnsembleScript): void {
    try {
        const parentNow = getStoryNow(parent.id);
        setStoryNow(parentNow, child.id);
    } catch {
        // 时间线继承失败不影响建剧本本身
    }
}