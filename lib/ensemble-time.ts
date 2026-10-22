// lib/ensemble-time.ts
// 群像模式（Ensemble）——「时间感知」计算层
//
// 用户定稿（2026-10-06）：
//   · 时间感知有两种模式：
//       ① realtime=true  → 跟随真实系统时间（此刻真实年月日 + 钟点）
//       ② realtime=false → 用「架空起点」(anchor)：时间从该起点起，
//                          随现实自然流逝（即「架空的时钟也在一秒一秒走」）
//   · 设置随时可改，**改完下一轮 AI 就会读到**。
//   · 状态卡上的时间（LOG. TIME）**严格以本轮剧情时间为准**，
//     由本模块算好注入模板，**不让 AI 自己写 time**。
//
// ⚠️ 纯函数、无副作用、不 import UI，方便在组件外调用与单测。

import type { EnsembleScript } from "./ensemble-storage";

export type TimeAwarenessConfig = NonNullable<EnsembleScript["timeAwareness"]>;

/** 一份算好的「本轮剧情时间」，供提示词与状态卡共用 */
export type ResolvedStoryTime = {
  /** 完整 Date（用于格式化） */
  date: Date;
  /** 中文长格式：2026年10月6日 星期二 */
  dateCn: string;
  /** 英文日期：Oct 6, 2026 */
  dateEn: string;
  /** 24 小时制钟点：15:10 */
  time24: string;
  /** 12 小时制 + 午前午后：3:10 PM（对齐状态卡 LOG. TIME 视觉） */
  time12: string;
  /** 是否架空模式（用于提示词措辞） */
  virtual: boolean;
  /** 架空起点的人类可读描述（如「深冬的凌晨三点」），无则空串 */
  anchorLabel: string;
};

const WEEK_CN = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
const MON_EN = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 把 Date 格式化成本项目统一的剧情时间结构 */
function formatStoryTime(d: Date, virtual: boolean, anchorLabel: string): ResolvedStoryTime {
  const y = d.getFullYear();
  const mo = d.getMonth() + 1;
  const day = d.getDate();
  const hh = d.getHours();
  const mm = d.getMinutes();

  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  const meridiem = hh < 12 ? "AM" : "PM";

  return {
    date: d,
    dateCn: `${y}年${mo}月${day}日 ${WEEK_CN[d.getDay()]}`,
    dateEn: `${MON_EN[mo - 1]} ${day}, ${y}`,
    time24: `${pad2(hh)}:${pad2(mm)}`,
    time12: `${h12}:${pad2(mm)} ${meridiem}`,
    virtual,
    anchorLabel: anchorLabel || "",
  };
}

/**
 * 解析一幕的「本轮剧情时间」。
 *
 * @param cfg  剧本的 timeAwareness 配置；未配置 → 返回 null（不注入）
 * @param now  当前真实时刻（便于测试注入；缺省 new Date()）
 */
export function resolveStoryTime(
  cfg: TimeAwarenessConfig | undefined,
  now: Date = new Date()
): ResolvedStoryTime | null {
  if (!cfg || !cfg.enabled) return null;

  // ① 感知现实时间 → 直接用此刻
  if (cfg.realtime) {
    return formatStoryTime(now, false, "");
  }

  // ② 架空起点 → 起点 + 已流逝的现实时长
  //    例：起点 2015/03/29 15:54，现实过了 3 小时 → 剧情时间 2015/03/29 18:54
  const anchorMs = cfg.anchor ? Date.parse(cfg.anchor) : NaN;
  if (!Number.isFinite(anchorMs)) {
    // 起点缺失/非法 → 降级为真实时间，保证卡片一定有值
    return formatStoryTime(now, false, "");
  }
  const elapsed = Math.max(0, now.getTime() - anchorMs);
  const storyMs = anchorMs + elapsed;
  // 「已流逝现实时长」从设置那一刻起算，锚点本身当作它的基准，
  // 因此这里不能对 anchorMs 做「设置时刻替换」，否则每次改设置都会跳时。
  const d = new Date(storyMs);
  return formatStoryTime(d, true, cfg.anchorLabel || "");
}

/**
 * 生成注入 systemPrompt 的「时间感知」文本块。
 *
 * 两种模式都注入，措辞不同：
 *   · 真实模式 → 告知 AI 现实此刻，要求它把剧情时间对齐到「现在」。
 *   · 架空模式 → 告知 AI 架空世界的当前时刻，并要求它**沿用时序自洽**，
 *               不得跳回真实时间。
 *
 * ⚠️ 明确写死「时间由系统给定，你不要自己写时间字段」，
 *    避免模型在正文里自行编造日期（状态卡的 time 由前端注入）。
 */
export function buildTimeAwarenessBlock(
  st: ResolvedStoryTime | null
): string {
  if (!st) return "";

  if (!st.virtual) {
    return `
【时间感知 · 现实时间】
此刻真实时间是 ${st.dateCn} ${st.time24}。
请让剧情的日夜、光景、角色作息与这个真实时刻保持一致
（例如此刻是深夜就该写到夜间氛围，是清晨就该写到晨光）。
不要在正文里另写日期或钟点 —— 系统会统一在状态卡上标注时间。`;
  }

  const label = st.anchorLabel ? `（${st.anchorLabel}）` : "";
  return `
【时间感知 · 架空时间】
本剧时间是架空的：故事从 ${st.dateCn} ${st.time24}${label} 开始，
并随现实时间自然流逝。请始终以这个世界内的时刻为准安排日夜与光景，
**不得跳回真实世界的日期**。
不要在正文里另写日期或钟点 —— 系统会统一在状态卡上标注时间。`;
}

/**
 * 生成注入 systemPrompt 的「状态面板」输出契约块。
 *
 * @param fields 用户字段表（key / desc / max）
 * @param castNames 本剧本全员名单（供模型参考可归属的角色）
 */
export function buildStatusContractBlock(
  fields: { key: string; desc: string; max?: number }[],
  castNames: string[] = []
): string {
  if (!fields.length) return "";

  const fieldLines = fields
    .map((f) => {
      const limit = typeof f.max === "number" && f.max > 0 ? `（不超过 ${f.max} 字）` : "";
      return `    ${f.key}: ${f.desc || "（无说明）"}${limit}`;
    })
    .join("\n");

  const sample = fields
    .map((f) => `      ${f.key}: ${f.desc ? "…" : "…"}`)
    .join("\n");

  const castHint = castNames.length
    ? `\n   「角色」必须用本剧演员表里的名字：${castNames.join(" / ")}。`
    : "";

  return `
═══════════ 状态面板：整幕末尾必须附「状态数据」═══════════
在整幕正文**全部写完之后**，另起一段，用 ［状态］ 暗号开头，
为**本幕出场的每一个角色各写一条**数据（两个角色在场就写两条）。格式：

［状态］
- 角色: 角色A的名字
${sample}
- 角色: 角色B的名字
${sample}

字段说明（key 与含义由用户定义，必须逐字使用下面的 key）：
${fieldLines}
${castHint}
铁律：
1. ［状态］段只出现在**整幕最末尾**，正文里绝不出现这些数据。
2. 每个值都必须贴合该角色**此刻**的处境、情绪与内心，不要写成通用套话。
3. **不要写 loc_en / time / date 这类字段**（没有出现在上面的 key 里就不要写），
   地点与时间由系统统一处理。
4. 只为本幕**真正出场**的角色写，没出场的角色一条都不要写。
5. ［状态］是数据段，不要把它写成正文、也不要用别的暗号（如［旁白］）包它。`;
}
