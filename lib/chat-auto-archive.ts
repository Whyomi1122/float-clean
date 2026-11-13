"use client";

// 后台自动归档：聊天停下来一阵、又攒够新内容，就自动把这一段并进归档。
// 手动弹窗那条路（chat-archive-panel）走的是同一个 service，这里只负责「什么时候跑」。
//
// 触发线（都满足才跑）：
//   1) 该会话最后一条消息距今 ≥ 4 分钟（还在聊就别动，免得归档半场对话）
//   2) 上次归档之后新增的对话 ≥ 60 条消息（约 30 轮）
//   3) 同一角色两次自动归档间隔 ≥ 2 小时
//   4) 没有后台回复正在生成（follow-up / 追发）
// 每轮最多归档一个角色，避免一次连打几次模型。

import { loadCharacters } from "./character-storage";
import { loadChatMessages, loadChatSessions } from "./chat-storage";
import { isBackgroundReplyGenerating } from "./follow-up-service";
import { commitChatArchiveText, generateChatArchiveDraft } from "./chat-archive-service";

/** 播报事件：归档完成后广播，root 上的 toast 与聊天室都听它 */
export const CHAT_AUTO_ARCHIVE_EVENT = "float:chat-auto-archive";

export type ChatAutoArchiveDetail = {
    characterId: string;
    characterName: string;
    /** 是「追加进已有归档」还是「第一次建归档」 */
    updated: boolean;
};

const STORAGE_KEY = "ai_phone_chat_auto_archive_v1";

export const AUTO_ARCHIVE_MIN_NEW_MESSAGES = 60;
export const AUTO_ARCHIVE_IDLE_MS = 4 * 60 * 1000;
export const AUTO_ARCHIVE_COOLDOWN_MS = 2 * 60 * 60 * 1000;

type CharState = {
    /** 已经归档到哪条消息（ISO），之后的才算新增 */
    through: string;
    /** 最近一次跑（成功或失败都记，用来冷却，避免失败后反复重试） */
    at: string;
};

type AutoArchiveState = Record<string, CharState>;

function readState(): AutoArchiveState {
    if (typeof window === "undefined") return {};
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as AutoArchiveState;
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

function writeState(state: AutoArchiveState): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch { /* 存不下就算了，下次按全量判断 */ }
}

/** 该角色已归档到哪条消息（没有记录返回空串） */
export function getArchivedThrough(characterId: string): string {
    return readState()[characterId]?.through || "";
}

/** 手动归档成功后调用：把「已归档到这里」标记推到最新一条消息 */
export function markChatArchived(characterId: string, throughIso?: string): void {
    const state = readState();
    const sessions = loadChatSessions().filter(s => s.contactId === characterId && !s.isGroup);
    let through = throughIso || "";
    if (!through) {
        for (const session of sessions) {
            const msgs = loadChatMessages(session.id).filter(m => !m.isRetracted && !m.deliverySessionId);
            const last = msgs[msgs.length - 1];
            if (last?.createdAt && last.createdAt > through) through = last.createdAt;
        }
    }
    if (!through) return;
    state[characterId] = { through, at: new Date().toISOString() };
    writeState(state);
}

let running = false;

/** 这个角色是不是已经有聊天归档（群像归档、一起听记录不算） */
async function hasAnyChatArchive(characterId: string): Promise<boolean> {
    try {
        const { loadMemoryEntriesByType } = await import("./memory-storage");
        const entries = await loadMemoryEntriesByType(characterId, "archive");
        return entries.some(entry => entry.sourceApp !== "ensemble" && !entry.metadata?.listenRecord);
    } catch {
        return false;
    }
}

export type ChatAutoArchiveResult =
    | { ran: true; characterId: string; characterName: string; updated: boolean }
    | { ran: false; reason: string };

/**
 * 跑一轮检查。由 chat-auto-archive-scheduler 定时调用；也可在聊天室手动触发。
 * 返回 ran:true 表示这一轮真的归档了一个角色。
 */
export async function runChatAutoArchive(): Promise<ChatAutoArchiveResult> {
    if (typeof window === "undefined") return { ran: false, reason: "no-window" };
    if (running) return { ran: false, reason: "running" };
    if (document.hidden) return { ran: false, reason: "hidden" };

    const sessions = loadChatSessions().filter(s => !s.isGroup && s.contactId && !s.isBlacklisted);
    if (sessions.length === 0) return { ran: false, reason: "no-session" };

    const state = readState();
    const names = new Map(loadCharacters().map(c => [c.id, c.name] as const));
    const now = Date.now();

    type Candidate = { characterId: string; characterName: string; sessionId: string; through: string; fresh: number };
    let candidate: Candidate | null = null;

    for (const session of sessions) {
        const characterId = session.contactId;
        const characterName = names.get(characterId) || "";
        if (!characterName) continue;
        if (isBackgroundReplyGenerating(session.id)) continue;

        const msgs = loadChatMessages(session.id)
            .filter(m => !m.isRetracted && !m.deliverySessionId && (m.role === "user" || m.role === "assistant"));
        if (msgs.length === 0) continue;
        const last = msgs[msgs.length - 1];
        const lastAt = last.createdAt ? new Date(last.createdAt).getTime() : 0;
        if (!lastAt) continue;
        if (now - lastAt < AUTO_ARCHIVE_IDLE_MS) continue; // 还在聊

        const charState = state[characterId];
        if (charState?.at && now - new Date(charState.at).getTime() < AUTO_ARCHIVE_COOLDOWN_MS) continue;

        const through = charState?.through || "";
        const fresh = through ? msgs.filter(m => (m.createdAt || "") > through) : msgs;
        if (fresh.length < AUTO_ARCHIVE_MIN_NEW_MESSAGES) continue;

        // 第一次跑（还没有进度标记）且这个角色**已经有归档**：先把标记对齐到最新一条，不自动跑。
        // 否则会拿整段历史去「新增」，容易和已有归档重复。
        if (!charState) {
            const archived = await hasAnyChatArchive(characterId);
            if (archived) {
                state[characterId] = { through: last.createdAt || "", at: new Date().toISOString() };
                writeState(state);
                continue;
            }
        }

        // 取「攒得最多」的那个角色，一轮只跑一个
        if (!candidate || fresh.length > candidate.fresh) {
            candidate = {
                characterId,
                characterName,
                sessionId: session.id,
                through: last.createdAt || "",
                fresh: fresh.length,
            };
        }
    }

    if (!candidate) return { ran: false, reason: "nothing-due" };

    running = true;
    try {
        const draft = await generateChatArchiveDraft({
            characterId: candidate.characterId,
            characterName: candidate.characterName,
            sessionId: candidate.sessionId,
            // 只喂「上回归档之后」的消息：全量重喂会让模型把旧内容再写一遍
            since: state[candidate.characterId]?.through || undefined,
        });
        if (!draft.ok) {
            // 记一次时间戳做冷却，别每轮都撞同一个错
            state[candidate.characterId] = {
                through: state[candidate.characterId]?.through || "",
                at: new Date().toISOString(),
            };
            writeState(state);
            return { ran: false, reason: draft.reason };
        }

        const commit = await commitChatArchiveText(candidate.characterId, draft.draft);
        state[candidate.characterId] = {
            through: commit.success ? candidate.through : (state[candidate.characterId]?.through || ""),
            at: new Date().toISOString(),
        };
        writeState(state);

        if (!commit.success) return { ran: false, reason: commit.error || "commit-failed" };

        const detail: ChatAutoArchiveDetail = {
            characterId: candidate.characterId,
            characterName: candidate.characterName,
            updated: commit.updated,
        };
        window.dispatchEvent(new CustomEvent<ChatAutoArchiveDetail>(CHAT_AUTO_ARCHIVE_EVENT, { detail }));
        return { ran: true, ...detail };
    } catch (e) {
        state[candidate.characterId] = {
            through: state[candidate.characterId]?.through || "",
            at: new Date().toISOString(),
        };
        writeState(state);
        return { ran: false, reason: e instanceof Error ? e.message : "error" };
    } finally {
        running = false;
    }
}
