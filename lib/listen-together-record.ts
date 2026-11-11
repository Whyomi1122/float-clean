// lib/listen-together-record.ts — 一起听结束时写进"普通模式归档"
//
// 2026-11-09 用户口径：不需要重播/回放，只要一条记录，供普通聊天做归档时参考。
// 形态（2026-11-11 v7 统一成普通模式归档格式，独立一条）：
//   ─────  归档 · 普通模式 · 至 2026.11.11  ─────
//   【普通模式 · 11-11】一起听
//   20:35 起，xxx和yyy隔着手机一起听歌，35 分钟里放了 8 首：   ← 一行一首
//   21:10 结束。
//   【一起听：11月11日 20:35–21:10，8 首】
// 位置：记忆库 → 归档（type: archive，sourceApp: chat），和普通聊天归档同处，会被注入提示词。

import { commitArchive } from "./memory-service";
import { loadChatAppSettings } from "./chat-storage";
import { resolveUserIdentity } from "./settings-storage";
import { endListenSession, type ListenSession } from "./listen-together-session";

const SOURCE_APP = "chat" as const;

function clock(date: Date): string {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 把一场一起听渲染成归档正文。 */
export function buildListenRecordContent(session: ListenSession, endedAt: Date = new Date()): string {
    const start = new Date(session.startedAt);
    const startSafe = Number.isNaN(start.getTime()) ? endedAt : start;
    const minutes = Math.max(1, Math.round((endedAt.getTime() - startSafe.getTime()) / 60000));
    const duration = minutes >= 60
        ? `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ""}`
        : `${minutes} 分钟`;
    const dateLabel = `${startSafe.getMonth() + 1}月${startSafe.getDate()}日`;
    const songs = session.tracks
        .map(t => (t.artist ? `${t.title} - ${t.artist}` : t.title))
        .filter(Boolean);
    const pad = (n: number) => String(n).padStart(2, "0");
    const archiveDate = `${endedAt.getFullYear()}.${pad(endedAt.getMonth() + 1)}.${pad(endedAt.getDate())}`;
    const sectionDate = `${pad(startSafe.getMonth() + 1)}-${pad(startSafe.getDate())}`;
    const partner = (session.characterName || "").trim() || "对方";
    const userName = (resolveUserIdentity(session.characterId, SOURCE_APP)?.name || "").trim() || "用户";
    const lines = [
        `─────  归档 · 普通模式 · 至 ${archiveDate}  ─────`,
        `【普通模式 · ${sectionDate}】一起听`,
        songs.length > 0
            ? `${clock(startSafe)} 起，${partner}和${userName}隔着手机一起听歌，${duration}里放了 ${songs.length} 首：`
            : `${clock(startSafe)} 起，${partner}和${userName}隔着手机一起听了 ${duration}，没有放歌，主要是在聊天。`,
        ...songs,
        `${clock(endedAt)} 结束。`,
        `【一起听：${dateLabel} ${clock(startSafe)}–${clock(endedAt)}，${songs.length} 首】`,
    ];
    return lines.join("\n");
}

/**
 * 结束一起听：清状态 + （可选）把这一场写进记忆归档。
 * 归档写入失败不影响结束本身。
 */
export async function finishListenSession(): Promise<ListenSession | null> {
    const session = endListenSession();
    if (!session) return null;
    try {
        const settings = loadChatAppSettings();
        if (settings.listenRecordArchiveEnabled === false) return session;
        const endedAt = new Date();
        const body = buildListenRecordContent(session, endedAt);
        await commitArchive(session.characterId, body, SOURCE_APP, {
            listenRecord: true,
            listenStartedAt: session.startedAt,
            listenEndedAt: endedAt.toISOString(),
            listenTrackCount: session.tracks.length,
        });
    } catch {
        // 记录失败只丢记录，不影响结束
    }
    return session;
}
