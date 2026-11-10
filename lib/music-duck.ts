// 音乐「压低」总线（ducking）
//
// 场景：一边听歌一边聊天时，角色语音/语音条的说话声会被音乐盖住。
// 做法参考环境音 ducking：说话期间把音乐音量临时压低，说完自动恢复。
//
// 用持有者集合做引用计数，多个声音同时响也只会压低一次；
// 音频播放模块（tts-service / message-bubble）负责 hold + release，
// 音乐播放器（music-context）订阅并把 factor 乘到音量上。

type Listener = (ratio: number) => void;

/** 说话时保留的音乐音量比例（0.28 ≈ 压到约 28%） */
const DUCK_RATIO = 0.28;

const holders = new Set<string>();
const listeners = new Set<Listener>();

/** 当前应乘到音乐音量上的系数：有人在说话时是 DUCK_RATIO，否则 1。 */
export function getMusicDuckRatio(): number {
    return holders.size > 0 ? DUCK_RATIO : 1;
}

function emit(): void {
    const ratio = getMusicDuckRatio();
    listeners.forEach((listener) => {
        try { listener(ratio); } catch { /* ignore */ }
    });
}

/** 开始播放一段语音时调用（id 用来源区分，如 "tts" / "voice-bar"）。 */
export function holdMusicDuck(id: string): void {
    if (holders.has(id)) return;
    holders.add(id);
    emit();
}

/** 语音结束/中断时调用，恢复音乐音量。 */
export function releaseMusicDuck(id: string): void {
    if (!holders.delete(id)) return;
    emit();
}

/** 订阅系数变化，返回取消订阅函数。 */
export function subscribeMusicDuck(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
