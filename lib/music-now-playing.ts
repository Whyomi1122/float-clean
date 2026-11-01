// lib/music-now-playing.ts — 正在播放状态的共享桥 + 提示词注入块
//
// 音乐播放器(music-context)把实时播放状态写进这里(模块级变量,非 React 状态,
// 避免 4次/秒 的 timeupdate 触发重渲染);聊天引擎组装提示词时同步读取,
// 生成 [music.now_playing] 独立 system 块——每轮现拼,不进聊天历史。
//
// 注入规则(借鉴 one-earbud 的防坑设计):
// - 没在播放任何歌 → 返回空串(不塞"没在听"之类的假信息误导模型)
// - 暂停超过 10 分钟 → 返回空串(睡觉挂着的情况不浪费 token)
// - 歌词过长时只取当前行附近窗口,单块上限约 4000 字符

export type NowPlayingState = {
    trackId: string;
    title: string;
    artist: string;
    /** 网易云歌曲 ID(netease_ 前缀曲目解析而来),本地歌为空 */
    neteaseId?: number;
    duration: number;           // 秒
    currentTime: number;        // 秒
    isPlaying: boolean;
    /** 最近一次 isPlaying 翻转的时间戳(ms),用于"暂停超10分钟不注入" */
    lastPlayingChangeAt: number;
    /** LRC 原文(本地歌来自元数据,网易云在切歌时异步拉取) */
    lyrics?: string;
};

let state: NowPlayingState | null = null;

export function setNowPlayingTrack(info: {
    trackId: string;
    title: string;
    artist: string;
    neteaseId?: number;
    duration: number;
    lyrics?: string;
}) {
    const prev = state;
    state = {
        trackId: info.trackId,
        title: info.title,
        artist: info.artist,
        neteaseId: info.neteaseId,
        duration: info.duration,
        currentTime: 0,
        isPlaying: prev?.trackId === info.trackId ? prev.isPlaying : false,
        lastPlayingChangeAt: Date.now(),
        lyrics: info.lyrics,
    };
}

export function updateNowPlayingTime(currentTime: number) {
    if (state) state.currentTime = currentTime;
}

export function setNowPlayingPlaying(isPlaying: boolean) {
    if (!state) return;
    if (state.isPlaying !== isPlaying) {
        state.isPlaying = isPlaying;
        state.lastPlayingChangeAt = Date.now();
    }
}

export function clearNowPlaying() {
    state = null;
}

export function getNowPlayingSnapshot(): NowPlayingState | null {
    return state ? { ...state } : null;
}

// ── LRC 解析(仅取时间轴文本行,容错无标签的纯文本歌词) ──

type LrcLine = { time: number; text: string };

function parseLrc(lrc: string): LrcLine[] {
    const lines: LrcLine[] = [];
    for (const raw of lrc.split(/\r?\n/)) {
        const matches = [...raw.matchAll(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
        const text = raw.replace(/\[[^\]]*\]/g, "").trim();
        if (matches.length === 0) {
            if (text) lines.push({ time: -1, text }); // 纯文本歌词行
            continue;
        }
        for (const m of matches) {
            const time = parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + (m[3] ? parseInt(m[3].padEnd(3, "0"), 10) / 1000 : 0);
            if (text) lines.push({ time, text });
        }
    }
    lines.sort((a, b) => a.time - b.time);
    return lines;
}

function fmtTime(sec: number): string {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** 歌词窗口:当前行 ±10 行,整块最长约 4000 字符 */
function buildLyricWindow(lines: LrcLine[], currentTime: number): string {
    if (lines.length === 0) return "";
    let idx = lines.findIndex(l => l.time > currentTime);
    if (idx === -1) idx = lines.length; // 已到尾奏
    const cur = idx - 1;                 // 当前句(最后一条 time <= currentTime)
    const start = Math.max(0, cur - 10);
    const end = Math.min(lines.length, cur + 11);
    let out = "";
    for (let i = start; i < end; i++) {
        const marker = i === cur ? "▶" : " ";
        out += `${marker} ${lines[i].text}\n`;
        if (out.length > 4000) break;
    }
    return out.trimEnd();
}

/**
 * 生成 [music.now_playing] 提示词块。规则见文件头注释。
 * 返回空串表示本轮不注入。
 */
export function buildNowPlayingPromptBlock(): string {
    const s = state;
    if (!s) return "";
    // 暂停超过 10 分钟不注入(睡觉挂机场景)
    if (!s.isPlaying && Date.now() - s.lastPlayingChangeAt > 10 * 60 * 1000) return "";

    const lines: string[] = [];
    lines.push("[music.now_playing]");
    lines.push(`正在播放:${s.title} - ${s.artist}(${fmtTime(s.currentTime)} / ${fmtTime(s.duration)}${s.isPlaying ? "" : ",已暂停"})`);

    if (s.lyrics) {
        const parsed = parseLrc(s.lyrics);
        const window = buildLyricWindow(parsed, s.currentTime);
        if (window) {
            lines.push("歌词(▶ 为当前句):");
            lines.push(window);
        }
    }
    lines.push("[/music.now_playing]");
    lines.push("以上是用户现实中的设备正在播放的音乐,属于用户的真实环境,与当前对话可能存在的剧情/角色扮演世界无关——不要把它写进叙事、场景描写或角色对白。你可以自然地感知到它的存在,但不要主动复述歌词全文;除非话题相关,否则不必每轮都提起音乐。");
    return lines.join("\n");
}
