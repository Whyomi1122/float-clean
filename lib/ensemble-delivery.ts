// lib/ensemble-delivery.ts
// 群像 ↔ 聊天 App 的「剧情对话段」搬运（2026-10-18 用户拍板）
//
// 模型：一段剧情对话 = 一次投递(起点) → 一次返回剧情(终点)。
//   · 投递时开启一段 session（带 scriptId / startTurnId / 起点时刻）
//   · 期间的聊天消息都打上这段 session 的标记
//   · 【返回剧情】时把整段打包成剧本的「来自聊天」记录，session 关闭
//   · 没点返回就直接走 → session 保持 open，群像里显示「有 N 段聊天未归入」
//
// 归档分流（用户要求）：
//   · 聊天 App 的长期记忆总结只吃普通聊天，跳过带 deliverySessionId 的消息
//   · 剧情模式下的内容归到群像剧本自己的归档里

import { loadUserIdentities, resolveUserIdentity } from "./settings-storage";

import {
    createOrGetSession,
    createGroupSession,
    saveChatSessions,
    loadChatSessions,
    pushChatMessage,
    loadChatMessages,
    updateChatMessage,
} from "./chat-storage";

/**
 * 找到（或创建）与某个剧本演员表一致的群聊会话。
 * 群聊的 participantIds 按集合比较，避免每次投递都新建一个重复群。
 */
export function ensureEnsembleGroupSession(params: {
    scriptId: string;
    scriptTitle: string;
    participantIds: string[];
}): string {
    const ids = [...new Set(params.participantIds)].sort();
    const existing = loadChatSessions().find(s => {
        if (!s.isGroup || !s.participantIds) return false;
        const a = [...new Set(s.participantIds)].sort();
        return a.length === ids.length && a.every((v, i) => v === ids[i]);
    });
    if (existing) return existing.id;

    const created = createGroupSession(params.scriptTitle || "剧情群聊", ids);
    return created.id;
}

/** 一段剧情对话（投递起点 → 返回剧情终点）。 */
export type DeliverySession = {
    id: string;
    scriptId: string;
    scriptTitle: string;
    /** 投递出去的起始台词（用于展示与核对）。 */
    originTurnId: string;
    originContent: string;
    characterId: string;
    characterName: string;
    /** 投递落地的聊天会话 id；返回剧情时优先按它取消息。 */
    chatSessionId?: string;
    /** 投递后用户是否已经进过那个聊天室。 */
    opened?: boolean;
    /** 投递时刻。 */
    startedAt: number;
    /** 返回剧情时刻；为空表示这段还没归入。 */
    endedAt?: number;
};

const SESSION_KEY = "float_delivery_sessions_v1";

export function loadDeliverySessions(): DeliverySession[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = window.localStorage.getItem(SESSION_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function saveDeliverySessions(list: DeliverySession[]) {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(SESSION_KEY, JSON.stringify(list.slice(-200)));
    } catch {
        // 配额满了就放弃，不阻断主流程
    }
}

/** 该角色当前是否有正在进行的剧情对话段。 */
export function getOpenSessionForCharacter(characterId: string): DeliverySession | null {
    const list = loadDeliverySessions();
    for (let i = list.length - 1; i >= 0; i -= 1) {
        const s = list[i];
        if (!s.endedAt && s.characterId === characterId) return s;
    }
    return null;
}

/**
 * 找出「当前正在进行的剧情对话段」。
 *
 * ⚠️ 群聊里 character 为空，或投递的角色和当前会话的主角色对不上时，
 * 只按 characterId 找会漏掉 → 用户点【返回剧情】被误判成「没有进行中的段」。
 * 所以这里按顺序兜底：当前会话 + 角色 → 当前会话里任意未归入段 → 任意未归入段。
 */
export function findOpenSession(params: {
    characterId?: string | null;
    sessionId?: string | null;
    participantIds?: string[];
}): DeliverySession | null {
    const list = loadDeliverySessions().filter(s => !s.endedAt);
    if (list.length === 0) return null;

    if (params.characterId && !params.sessionId) {
        for (let i = list.length - 1; i >= 0; i -= 1) {
            if (list[i].characterId === params.characterId) return list[i];
        }
    }
    if (params.sessionId) {
        for (let i = list.length - 1; i >= 0; i -= 1) {
            const s = list[i];
            if (s.chatSessionId === params.sessionId) return s;
            const hit = loadChatMessages(params.sessionId).some(
                m => m.deliverySessionId === s.id,
            );
            if (hit) return s;
        }
    }
    if (params.characterId && !params.sessionId) {
        const cast = new Set(params.participantIds ?? []);
        if (cast.has(params.characterId)) {
            for (let i = list.length - 1; i >= 0; i -= 1) {
                if (cast.has(list[i].characterId)) return list[i];
            }
        }
    }
    // 指定了会话却没有匹配时，不得把其他聊天室的剧情带入当前会话。
    return !params.sessionId && !params.characterId && list.length === 1 ? list[0] : null;
}

/** 标记用户已经进过这段剧情对应的聊天室。 */
export function markSessionOpened(deliverySessionId: string) {
    const list = loadDeliverySessions();
    let changed = false;
    const next = list.map(s => {
        if (s.id !== deliverySessionId || s.opened) return s;
        changed = true;
        return { ...s, opened: true };
    });
    if (changed) saveDeliverySessions(next);
}

/** 按 sessionId 取。 */
export function getDeliverySession(sessionId: string): DeliverySession | null {
    return loadDeliverySessions().find(s => s.id === sessionId) ?? null;
}

/** 所有还没归入剧情的段（用于群像顶部提示）。 */
export function getPendingSessions(scriptId?: string): DeliverySession[] {
    return loadDeliverySessions().filter(s => !s.endedAt && (!scriptId || s.scriptId === scriptId));
}

export type DeliveryResult =
    | { ok: true; sessionId: string; messageId: string; chatSessionId: string; isGroup: boolean }
    | { ok: false; error: string };

/**
 * 投递：把群像里的一幕投到聊天 App，并开启一段剧情对话段。
 *
 * @param target 投递目标：单聊某个角色，或整个剧本对应的群聊。
 *               单人群像默认只用单聊；多人群像由用户选择。
 */
export function deliverToChat(params: {
    characterId: string;
    characterName: string;
    content: string;
    scriptId: string;
    scriptTitle: string;
    turnId: string;
    /** 剧本使用的面具；投递前须与目标聊天室的实际身份一致。 */
    personaId?: string;
    /** 投递目标；省略时按单聊角色处理。 */
    target?: { kind: "direct"; characterId: string } | { kind: "group"; participantIds: string[] };
    /** 非角色台词（旁白 / 多人混合段）时可显式指定投递给谁。 */
    forceNew?: boolean;
}): DeliveryResult {
    const content = (params.content ?? "").trim();
    if (!content) return { ok: false, error: "内容为空" };
    if (!params.characterId) return { ok: false, error: "缺少角色信息" };

    try {
        const isGroup = params.target?.kind === "group";
        if (params.personaId) {
            const persona = loadUserIdentities().find(identity => identity.id === params.personaId);
            if (!persona) return { ok: false, error: "剧本面具已不存在，请先在群像中重新选择面具" };
            const directId = params.target?.kind === "direct" ? params.target.characterId : params.characterId;
            const targetSession = loadChatSessions().find(s => {
                if (!isGroup) return !s.isGroup && s.contactId === directId;
                if (params.target?.kind !== "group" || !s.isGroup || !s.participantIds) return false;
                const ids = [...new Set(params.target.participantIds)].sort();
                const members = [...new Set(s.participantIds)].sort();
                return ids.length === members.length && ids.every((id, i) => id === members[i]);
            });
            const chatIdentity = resolveUserIdentity(isGroup ? undefined : directId, isGroup ? "group_chat" : "chat", targetSession?.userIdentityId);
            if (chatIdentity?.id !== persona.id) {
                return {
                    ok: false,
                    error: `剧本使用「${persona.name}」，${isGroup ? "群聊" : "目标角色的聊天"}使用「${chatIdentity?.name || "未设置面具"}」。请先在设置中将${isGroup ? "群聊" : "该角色聊天"}面具设为「${persona.name}」后再投递`,
                };
            }
        }
        let chatSessionId: string;
        if (params.target?.kind === "group") {
            chatSessionId = ensureEnsembleGroupSession({
                scriptId: params.scriptId,
                scriptTitle: params.scriptTitle,
                participantIds: params.target.participantIds,
            });
        } else {
            const directId =
                params.target?.kind === "direct" ? params.target.characterId : params.characterId;
            chatSessionId = createOrGetSession(directId).id;
        }

        const message = pushChatMessage({
            sessionId: chatSessionId,
            role: "assistant",
            content,
            senderName: params.characterName,
            // ⚠️ 群聊里没有这个字段就渲染不出角色头像，会掉成通用卡通头像
            senderCharacterId: params.characterId,
        });

        // 已有未归入的段就复用，否则开一段新的
        const existing = params.forceNew ? null : getOpenSessionForCharacter(params.characterId);
        let deliverySessionId: string;
        if (existing && existing.scriptId === params.scriptId) {
            deliverySessionId = existing.id;
            // 复用段时更新终点台词，便于展示"这一段从这里开始"
            const list = loadDeliverySessions().map(s =>
                s.id === existing.id
                    ? { ...s, originContent: content, originTurnId: params.turnId, chatSessionId }
                    : s,
            );
            saveDeliverySessions(list);
        } else {
            deliverySessionId = `dlv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const record: DeliverySession = {
                id: deliverySessionId,
                scriptId: params.scriptId,
                scriptTitle: params.scriptTitle,
                originTurnId: params.turnId,
                originContent: content,
                characterId: params.characterId,
                characterName: params.characterName,
                chatSessionId,
                startedAt: Date.now(),
            };
            saveDeliverySessions([...loadDeliverySessions(), record]);
        }

        // 把这条投递消息标记归属，方便归档时跳过
        markMessagesAsDelivery(chatSessionId, message.id, deliverySessionId);

        return { ok: true, sessionId: deliverySessionId, messageId: message.id, chatSessionId, isGroup };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "投递失败" };
    }
}

/** 从某条消息开始，到当前为止，把这段聊天标记为剧情对话。 */
function markMessagesAsDelivery(chatSessionId: string, fromMessageId: string, deliverySessionId: string) {
    try {
        const messages = loadChatMessages(chatSessionId);
        const idx = messages.findIndex(m => m.id === fromMessageId);
        if (idx < 0) return;
        for (let i = idx; i < messages.length; i += 1) {
            const m = messages[i];
            if (m.deliverySessionId) continue;
            updateChatMessage(m.id, { deliverySessionId });
        }
    } catch {
        // 标记失败不阻断投递
    }
}

/**
 * 返回剧情：关闭这段对话段，收集期间的全部聊天内容。
 *
 * @returns null 表示这段已经关闭过
 */
export function closeDeliverySession(params: {
    deliverySessionId: string;
    /** 仅收集，回填成功并经用户确认后才结束。 */
    preview?: boolean;
    /** 兼容旧调用：可省略，省略时按 id 扫描全部会话。 */
    characterId?: string;
}): { session: DeliverySession; transcript: { role: string; senderName?: string; content: string; at: number }[] } | null {
    const list = loadDeliverySessions();
    const target = list.find(s => s.id === params.deliverySessionId);
    if (!target || target.endedAt) return null;

    let transcript: { role: string; senderName?: string; content: string; at: number }[] = [];
    try {
        // 优先从投递落地的那个会话取；取不到再扫所有会话兜底
        const ordered: string[] = [];
        if (target.chatSessionId) ordered.push(target.chatSessionId);
        for (const sess of loadChatSessions()) {
            if (!ordered.includes(sess.id)) ordered.push(sess.id);
        }
        for (const sid of ordered) {
            const messages = loadChatMessages(sid);
            const hit = messages.filter(
                m => m.deliverySessionId === target.id && m.content?.trim(),
            );
            if (hit.length === 0) continue;
            transcript.push(
                ...hit.map(m => ({
                    role: m.role,
                    senderName: m.senderName,
                    content: m.content.trim(),
                    at: m.createdAt ? new Date(m.createdAt).getTime() : Date.now(),
                })),
            );
        }
        transcript.sort((a, b) => a.at - b.at);
        // 同一条消息被多个会话重复捞到（理论上不会）时去重
        const seen = new Set<string>();
        transcript = transcript.filter(m => {
            const key = `${m.at}|${m.role}|${m.content}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    } catch {
        transcript = [];
    }

    if (params.preview) return { session: target, transcript };
    const ended: DeliverySession = { ...target, endedAt: Date.now() };
    saveDeliverySessions(list.map(s => (s.id === target.id ? ended : s)));
    return { session: ended, transcript };
}

/** 回填确认后结束本次剧情；未归入成功前不得调用，否则「止」会提前出现。 */
export function finishDeliverySession(deliverySessionId: string): DeliverySession | null {
    const list = loadDeliverySessions();
    const target = list.find(s => s.id === deliverySessionId);
    if (!target || target.endedAt) return null;
    const ended: DeliverySession = { ...target, endedAt: Date.now() };
    saveDeliverySessions(list.map(s => (s.id === target.id ? ended : s)));
    return ended;
}

/**
 * 投递后的新消息（用户回复、AI 回复）不会自动带上 session 标记，
 * 导致「返回剧情」时收集不到。这里给所有开着 session 的会话补标：
 * 凡是投递时刻之后产生的、还没归属的消息，都归入这段剧情对话。
 */
export function tagMessagesForOpenDeliverySession(chatSessionId: string): void {
    try {
        const open = loadDeliverySessions().find(
            s => !s.endedAt && s.chatSessionId === chatSessionId,
        );
        if (!open) return;
        const messages = loadChatMessages(chatSessionId);
        for (const m of messages) {
            if (m.deliverySessionId) continue;
            const at = m.createdAt ? new Date(m.createdAt).getTime() : 0;
            if (at >= open.startedAt) {
                updateChatMessage(m.id, { deliverySessionId: open.id });
            }
        }
    } catch {
        // 补标失败不阻断聊天
    }
}

/** 一段（或全部）未归入对话段里的聊天，供归档面板展开查看。 */
export function loadSessionTranscript(deliverySessionId?: string): {
    session: DeliverySession;
    messages: { id: string; role: string; senderName?: string; content: string; at: number }[];
}[] {
    const sessions = loadDeliverySessions().filter(
        s => (deliverySessionId ? s.id === deliverySessionId : !s.endedAt),
    );
    return sessions.map(s => {
        const seen = new Set<string>();
        const messages: { id: string; role: string; senderName?: string; content: string; at: number }[] = [];
        try {
            const ordered: string[] = [];
            if (s.chatSessionId) ordered.push(s.chatSessionId);
            for (const sess of loadChatSessions()) {
                if (!ordered.includes(sess.id)) ordered.push(sess.id);
            }
            for (const sid of ordered) {
                for (const m of loadChatMessages(sid)) {
                    if (m.deliverySessionId !== s.id || !m.content?.trim()) continue;
                    if (seen.has(m.id)) continue;
                    seen.add(m.id);
                    messages.push({
                        id: m.id,
                        role: m.role,
                        senderName: m.senderName,
                        content: m.content.trim(),
                        at: m.createdAt ? new Date(m.createdAt).getTime() : Date.now(),
                    });
                }
            }
        } catch {
            // ignore
        }
        messages.sort((a, b) => a.at - b.at);
        return { session: s, messages };
    });
}

/**
 * 把一句「线下剧本味」的文字洗成「线上微信味」。
 *
 * 模型经常把动作、神态、心理和台词混成一条：
 *   （他停好车，单手搭在方向盘上扫了眼屏幕）【大清早吃那么腻】"那家蛋黄酱放得齁死人。"
 * 聊天软件会原样发出去 —— 那就不是微信消息了。
 * 这里做**只减不加**的清洗：剥掉括号/方括号里的表演与心理，去掉包住台词的引号，
 * 台词本身一个字都不改。
 */
export function sanitizeChatLine(input: string): string {
    let s = (input ?? "").replace(/\r/g, "");
    if (!s.trim()) return "";

    // 明确的外语对白 + 中文译文不是动作括号，转换为聊天通用双语格式。
    const bilingual = s.trim().match(/^[「『“"]([^「」『』“”"\n]+)[」』”"]\s*[（(]([^（）()\n]+)[）)]$/);
    if (bilingual && /[가-힣ぁ-ゟ゠-ヿa-zA-Z]/.test(bilingual[1]) && /[\u4e00-\u9fff]/.test(bilingual[2])) {
        return `${bilingual[1].trim()} | ${bilingual[2].trim()}`;
    }

    // 1) 剥掉成对的 （…）【…】［…］ 包裹内容，反复剥到稳定（防嵌套）
    for (let i = 0; i < 6; i += 1) {
        const next = s
            .replace(/[（(][^（()）]*[）)]/g, "")
            .replace(/[【\[［][^【】\[\]［］]*[】\]］]/g, "");
        if (next === s) break;
        s = next;
    }

    // 2) 去掉包裹整句台词的引号
    s = s.replace(/^[\s"'“”‘’「」『』]+/, "").replace(/[\s"'“”‘’「」『』]+$/, "");

    // 3) 去掉孤立的块标记（[旁白]: / ［动作］）
    s = s.replace(/^[\[［【][^\]］】]{1,6}[\]］】]\s*[:：]?\s*/g, "");

    // 4) 收拢空白
    s = s
        .split("\n")
        .map(line => line.replace(/[ \t]{2,}/g, " ").trim())
        .filter((line, idx, arr) => line !== "" || (idx > 0 && arr[idx - 1] !== ""))
        .join("\n")
        .trim();

    return s;
}

/** 这一句洗完之后还像不像「一条能发出去的聊天消息」。 */
export function looksLikeChatMessage(s: string): boolean {
    return !!s && /[\u4e00-\u9fa5a-zA-Z0-9가-힣]/.test(s);
}

/** 把一段原文按行清洗，用于投递候选列表。 */
export function sanitizeChatBlock(input: string): string[] {
    return (input ?? "")
        .replace(/\r/g, "")
        .split("\n")
        .map(line => sanitizeChatLine(line))
        .filter(looksLikeChatMessage);
}

/** 已录入聊天的幕（turn）→ 录入时间，供群像在用户卡片上打标记。 */
export function getDeliveredTurnIds(scriptId: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of loadDeliverySessions()) {
        if (s.scriptId !== scriptId) continue;
        if (!s.originTurnId) continue;
        const when = s.endedAt ?? Date.now();
        if (!out[s.originTurnId] || when > out[s.originTurnId]) out[s.originTurnId] = when;
    }
    return out;
}

/** 这一段是否真的已经带着聊天内容（只有真录入了才打标记）。 */
export function sessionHasContent(deliverySessionId: string): boolean {
    const [hit] = loadSessionTranscript(deliverySessionId);
    return !!hit && hit.messages.length > 0;
}

/** 把一段对话整理成剧本里的「来自聊天」文本。 */
export function formatTranscriptAsNarration(
    session: DeliverySession,
    transcript: { role: string; senderName?: string; content: string }[],
): string {
    const lines = transcript.map(m => {
        const who = m.role === "user" ? "你" : (m.senderName || session.characterName);
        return `${who}：${m.content}`;
    });
    return `（本次由剧情带入的内容：你们在手机上聊了起来）\n${lines.join("\n")}`;
}

/**
 * 杀青归档的缺漏统计：哪些投递段的聊天没被归入剧情。
 *
 * 缺漏判定：投递过、但 timeline 里没有任何 endedAt（= 用户一直没点【返回剧情】）。
 * 返回按时间排序的条目，供归档末尾标注「哪个时间段缺失聊天记录」。
 */
export type MissingDeliverySpan = {
    characterName: string;
    /** yyyy-MM-dd HH:mm */
    startedAt: string;
    /** 是否进过聊天室；没进过说明这条线完全没聊 */
    opened: boolean;
};

export function collectMissingDeliverySpans(scriptId: string): MissingDeliverySpan[] {
    const pad = (n: number) => String(n).padStart(2, "0");
    const fmt = (t: number) => {
        const d = new Date(t);
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    return loadDeliverySessions()
        .filter(s => s.scriptId === scriptId && !s.endedAt)
        .sort((a, b) => a.startedAt - b.startedAt)
        .map(s => ({
            characterName: s.characterName,
            startedAt: fmt(s.startedAt),
            opened: s.opened === true,
        }));
}

/** 放弃一段未归入的剧情对话（不写进剧本，只解除挂起状态）。 */
export function discardDeliverySession(deliverySessionId: string): boolean {
    const list = loadDeliverySessions();
    const target = list.find(s => s.id === deliverySessionId);
    if (!target || target.endedAt) return false;
    saveDeliverySessions(list.map(s => (s.id === deliverySessionId ? { ...s, endedAt: Date.now() } : s)));
    return true;
}

/** 未归入的段落摘要，用于群像顶部常驻提示。 */
export function describePendingSessions(scriptId?: string): string {
    const pending = getPendingSessions(scriptId);
    if (pending.length === 0) return "";
    const names = [...new Set(pending.map(s => s.characterName))].join("、");
    return `有 ${pending.length} 段聊天未归入剧情（${names}）`;
}
