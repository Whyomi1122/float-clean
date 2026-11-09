// lib/listen-together-record.ts — 一起听结束时写进"普通模式归档"
//
// 2026-11-09 用户口径：不需要重播/回放，只要一条记录，供普通聊天做归档时参考。
// 形态：`【一起听 · 11月9日 20:35–21:10】这次一起听了 35 分钟，放了 8 首歌：A - B、C - D…`
// 位置：记忆库 → 归档（type: archive，sourceApp: chat），和普通聊天归档同处，会被注入提示词。

import { commitArchive } from "./memory-service";
import { loadChatAppSettings } from "./chat-storage";
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
    const lines = [
        "（以下是你和用户一起听歌的记录，属于你们共同的经历；只在话题相关时自然提起，不必主动复述。）",
        `【一起听 · ${dateLabel} ${clock(startSafe)}–${clock(endedAt)}】`,
        songs.length > 0
            ? `这次一起听了 ${duration}，放了 ${songs.length} 首歌：${songs.join("、")}。`
            : `这次一起听了 ${duration}，没有放歌，主要是聊天。`,
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
