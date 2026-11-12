// lib/listen-together-record.ts — 一起听的结束动作
//
// 2026-11-09 用户口径：一起听不是另一个界面，只在悬浮球「音乐」面板体现；结束只由用户手动点。
//
// 2026-11-12 用户口径（改）：
//   · **不再往记忆库写「歌单存档」条目**，开关「一起听写进归档」一并删掉。
//     理由：歌单早就写进聊天归档的正文和【一起听：…】里了，这条独立存档是纯重复，
//     既占记忆库，又（曾经）挤占归档的注入预算。
//   · 这一场的歌单改为存在 localStorage 的「最近结束的一场」（`ai_phone_listen_last_v1`，48 小时），
//     只在「聊天归档」时被读出来喂给模型，界面上不出现，也不进提示词。

import { endListenSession, type ListenSession } from "./listen-together-session";

/**
 * 结束一起听：清状态并把这一场留作「最近结束」供归档取歌单。
 * 不做任何记忆库写入。
 */
export async function finishListenSession(): Promise<ListenSession | null> {
    return endListenSession();
}
