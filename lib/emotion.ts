// 聊天情绪：模型每轮标一个语气，落库到消息上，朗读语音条时映射成 TTS 情绪。
// 设计原则（见 待办与实机验收.md §三 D）：
//   - 只加可选字段，老数据不迁移；
//   - 值域固定 6 个，非法值一律当「没写」；
//   - 朗读侧默认关（ChatAppSettings.voiceEmotionEnabled），
//     且 MiniMax 不认的情绪（shy / neutral）直接不传，避免 500。

export const CHAT_EMOTIONS = ["neutral", "happy", "sad", "angry", "shy", "worried"] as const;
export type ChatEmotion = (typeof CHAT_EMOTIONS)[number];

/**
 * 注入给模型的指令（只在设置里开了「朗读情绪」时才加）。
 * 注意 2026-11-07 的教训：语音表现力标签曾漏进正文 / 被念出来，所以这里强调
 * 「标记单独一行、不写进台词」，并且解析层是无条件整段摘掉的。
 */
export const CHAT_EMOTION_INSTRUCTION =
    "【语气标记】这轮如果要发 [语音条:…]，在整条回复的最前面单独占一行写一个情绪标记，格式 [情绪:值]，例如：\n" +
    "[情绪:happy]\n" +
    "[语音条:今天遇到点开心的事]\n" +
    "可选值只有：neutral（平静）、happy（开心）、sad（难过）、angry（生气）、shy（害羞）、worried（担心）。" +
    "每轮最多一个，取这轮最主要的语气；标记不要写进台词、不要放进括号里解释。不发语音条就不用写。";

/** 模型/用户可能写中文，统一折成上面 6 个值 */
const EMOTION_ALIASES: Record<string, ChatEmotion> = {
    neutral: "neutral", 平静: "neutral", 中性: "neutral", 平淡: "neutral", 平常: "neutral",
    happy: "happy", 开心: "happy", 高兴: "happy", 快乐: "happy", 愉快: "happy", 兴奋: "happy",
    sad: "sad", 难过: "sad", 伤心: "sad", 低落: "sad", 沮丧: "sad", 委屈: "sad",
    angry: "angry", 生气: "angry", 愤怒: "angry", 恼火: "angry", 不耐烦: "angry",
    shy: "shy", 害羞: "shy", 害羞的: "shy", 脸红: "shy", 羞涩: "shy", 撒娇: "shy",
    worried: "worried", 担心: "worried", 焦虑: "worried", 忧虑: "worried", 不安: "worried", 紧张: "worried",
};

export function normalizeChatEmotion(raw?: string | null): ChatEmotion | undefined {
    const key = (raw || "").trim().toLowerCase();
    if (!key) return undefined;
    return EMOTION_ALIASES[key];
}

/**
 * 聊天情绪 → MiniMax 情绪参数。
 * happy / sad / angry 直传；worried → fearful；shy、neutral 不传（MiniMax 没有对应值，传了会被过滤也没意义）。
 */
export function toTtsEmotion(emotion?: ChatEmotion): string | undefined {
    switch (emotion) {
        case "happy": return "happy";
        case "sad": return "sad";
        case "angry": return "angry";
        case "worried": return "fearful";
        default: return undefined;
    }
}

/** 情绪标记：整轮回复共用一个，写在正文任意位置都会被摘掉 */
const EMOTION_TAG_RE = /[[【]\s*情绪\s*[:：]\s*([^\]】\n]{1,12})\s*[\]】]/g;

/** 从一段模型输出里取出情绪标记并摘掉；取第一个合法值 */
export function extractChatEmotion(text: string): { emotion?: ChatEmotion; text: string } {
    if (!text || !/情绪/.test(text)) return { text };
    let emotion: ChatEmotion | undefined;
    const stripped = text.replace(EMOTION_TAG_RE, (_full, raw: string) => {
        if (!emotion) emotion = normalizeChatEmotion(raw);
        return "";
    });
    if (!emotion) return { text };
    // 摘掉标记后可能留下只含空白的整行，别让它变成空气泡
    return { emotion, text: stripped.replace(/^[ \t]+$/gm, "") };
}
