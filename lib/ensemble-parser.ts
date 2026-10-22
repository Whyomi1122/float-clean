// lib/ensemble-parser.ts
// 群像模式（Ensemble）——「帧」解析器
//
// 设计目标（第 1 项：单消息流）：
//   模型一次返回「整幕」文本（多角色 + 旁白混排），本模块把它解析成
//   EnsembleFrame[]，前端遍历帧连续渲染，角色名内联，不再一人一张卡。
//
// ── 2026-10 定稿：旁白协议 ──────────────────────────────
// 旁白不再靠「看不出是环境还是动作的圆括号」猜测，而是由模型显式打暗号：
//   行首 `[旁白]:` 或 `[旁白]：`  → 该行是旁白帧
// 解析器读到后**把 `[旁白]:` 整个 slice 掉**，只留正文，并打 kind:"narration"。
// 界面上永远不出现「旁白」两个字，用户只看到斜体灰 + 下浅虚线这一种视觉。
//
// 其它未带暗号的散行（角色名之前的段落）同样落为 narration，作为兜底，
// 保证「绝不丢字」。
//
// ⚠️ 纯函数、无副作用，不 import 任何 UI，方便单测与在组件外调用。

import type { EnsembleCastMember } from "./ensemble-storage";

/** 一帧 = 一个「说话单元」。speaker 为空代表旁白/环境描写。 */
export type EnsembleFrame = {
  /** 说话人显示名；缺省 = 旁白（无归属） */
  speaker?: string;
  /** 命中的角色 id（若在演员表里找到） */
  speakerId?: string;
  /** 说话人头像（命中演员表时带上） */
  speakerAvatar?: string | null;
  /** 该帧的正文（原样保留，由渲染层决定排版） */
  text: string;
  /** 帧类型：dialogue=有说话人，narration=旁白/环境，inner=心理描写，action=叙述性文字（动作/环境/神态） */
  kind: "dialogue" | "narration" | "inner" | "action";
};

export type EnsembleParsedReply = {
  /** 解析出的帧序列 */
  frames: EnsembleFrame[];
  /** 本条回复是否包含多个说话人（用于判断是否真正「群像」） */
  multiSpeaker: boolean;
  /** 原始文本（未经清洗，便于调试/落库 rawText） */
  rawText: string;
  /**
   * 状态面板数据（第六暗号 ［状态］）。
   * 每个出场角色一条，key 由用户的「字段表」动态决定。
   * 未启用状态面板 / 模型没写 → 空数组。
   */
  statusData: EnsembleStatusEntry[];
  /**
   * 状态面板数据所在整段被剥离后的正文（用于落库 content）。
   * 未命中状态块时与原文本一致。
   */
  cleanText: string;
};

/** 状态面板：单个角色的一条数据（key 动态，值一律字符串） */
export type EnsembleStatusEntry = {
  /** 角色显示名（模型回填，须能对上演员表） */
  name: string;
  /** 命中的演员表 id（认不出则不填） */
  memberId?: string;
  /** 字段 key → 值，key 来自剧本 statusPanel.fields */
  values: Record<string, string>;
};

export const ENSEMBLE_PARSER_VERSION = 3;

/**
 * 旁白协议暗号：行首 `[旁白]` / `【旁白】` + 可选冒号。
 * 冒号可有可无，因为 `[旁白]` 本身已足够明确；带不带都会被完整消费。
 */
const NARRATION_TOKEN = /^\s*[\[［【]\s*旁白\s*[\]］】]\s*[:：]?\s*/;

/**
 * 心理描写协议暗号：行首 `[心理]` / `【心理】` + 可选冒号。
 * 与旁白同构：解析器读到后把暗号整个 slice 掉，只留正文，并打 kind:"inner"。
 * 渲染层据此上雾霾蓝 #93A9D1 —— 这是「心理」与「动作/环境」唯一的分野。
 */
const INNER_TOKEN = /^\s*[\[［【]\s*心理\s*[\]］】]\s*[:：]?\s*/;

/**
 * 叙述性文字协议暗号：行首 `[叙述]` / `[动作]`（兼容 `【】` / 全角）+ 可选冒号。
 *
 * 用户定稿（2026-10-04 第5轮）：
 *   · 「叙述文字」= 动作 / 环境 / 神态，统一渲染为灰 #A9A9A9。
 *   · 保留「［叙述］」与「［动作］」两个暗号，但**同色** —— 这样模型即使
 *     把动作标成叙述（或反过来），视觉结果完全一致，不会出错（容错设计）。
 *   · 归到**上一个开口的角色**（与心理同源），但渲染时只糊颜色、不出头像。
 */
const ACTION_TOKEN = /^\s*[\[［【]\s*(?:叙述|动作)\s*[\]］】]\s*[:：]?\s*/;

/**
 * 对白协议暗号：行首 `[对白]`（兼容 `【对白】` / 全角）+ 可选冒号。
 *
 * 用户定稿（2026-10-04 第5轮·最终契约）：
 *   · 「角色名：」独占一行 = **归属声明行**，只声明「下面这些块归谁」，本身无内容。
 *   · 该行之后出现的每一个 `［暗号］:` 块（对白/叙述/动作/心理）都归属该角色。
 *   · 对白块内的多行（韩语原文 + 中文译文 + 纯中文句）**全部黑色**，
 *     由本暗号一次性声明类型，绝不与叙述块混淆。
 */
const DIALOGUE_TOKEN = /^\s*[\[［【]\s*对白\s*[\]］】]\s*[:：]?\s*/;

/**
 * 状态面板协议暗号：行首 `[状态]` / `【状态】` + 可选冒号。
 *
 * 设计（2026-10-06 定稿）：
 *   · 模型在**整幕末尾**附一段 ［状态］ 块，形如：
 *       ［状态］
 *       - 角色: 金成帝
 *         loc_cn: 襄阳县南面海滨别庄礁石滩
 *         thought: 这破雨下个没完。
 *       - 角色: 皮
 *         ...
 *   · 本函数把该段**整段剥离**，正文里绝不出现，也不占 N 字护栏。
 *   · 每个出场角色一条；key 由用户字段表动态决定，解析器不写死任何 key
 *     （除 `角色` 这个归属键本身）。
 *   · 时间字段（time）**不由模型写** —— 由前端按时间感知设置注入模板。
 */
const STATUS_TOKEN = /^\s*[\[［【]\s*状态\s*[\]］】]\s*[:：]?\s*$/;

/** 状态块里的「角色名」归属行：`- 角色: 金成帝` / `- 角色：金成帝` / `角色: 金成帝` */
const STATUS_OWNER_LINE = /^\s*[-*•]?\s*(?:角色|角色名|name)\s*[:：]\s*(.+?)\s*$/i;
/** 状态块里的字段行：`loc_cn: xxx`（key 允许中英文、下划线、数字） */
const STATUS_FIELD_LINE = /^\s*[-*•]?\s*([A-Za-z_][A-Za-z0-9_]*|[^\s:：]{1,12})\s*[:：]\s*(.*)$/;

/**
 * 从「已剥离 think 块」的文本里，抽出状态块并返回 { statusText, cleanText, entries }。
 *
 * 规则：
 *   1. 找到第一处 `［状态］` 独占行 → 从该行起，到文本末尾（或到下一个
 *      `［旁白］/角色名：` 等正文暗号之前）都算状态块。
 *   2. 状态块整体从 cleanText 中删除（连同前后多余空行），保证正文干净。
 *   3. 逐个解析 `- 角色: X` 后紧跟的 key: value 行。
 *
 * ⚠️ 容错：模型偶尔会写成 `［状态］:` 或漏掉前导 `-`，都认。
 *    也允许状态块**出现在中间**（取最后一段，正文照常保留其余部分）。
 */
export function extractStatusBlock(
  text: string,
  allCast: EnsembleCastMember[] = []
): { cleanText: string; entries: EnsembleStatusEntry[] } {
  const lines = text.split("\n");
  let start = -1;
  let end = lines.length;

  for (let i = 0; i < lines.length; i++) {
    if (STATUS_TOKEN.test(lines[i])) {
      start = i;
      break;
    }
  }
  // 没写状态块 → 原样返回，绝不误删正文
  if (start === -1) return { cleanText: text, entries: [] };

  // 状态块向后延伸到「下一个明确的正文暗号」为止（防止模型把正文写在状态块后面）
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (
      NARRATION_TOKEN.test(l) ||
      INNER_TOKEN.test(l) ||
      ACTION_TOKEN.test(l) ||
      DIALOGUE_TOKEN.test(l)
    ) {
      end = i;
      break;
    }
  }

  const statusLines = lines.slice(start + 1, end);
  const kept = [...lines.slice(0, start), ...lines.slice(end)];
  // 收尾清理：去掉剥离后产生的连续空行
  const cleanText = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  // ── 解析条目 ──
  const entries: EnsembleStatusEntry[] = [];
  let cur: EnsembleStatusEntry | null = null;

  for (const raw of statusLines) {
    const line = raw.trim();
    if (!line) continue;

    // 归属行
    const ownerM = line.match(STATUS_OWNER_LINE);
    if (ownerM) {
      const name = ownerM[1].trim();
      if (name) {
        const member = findCastMember(name, allCast, allCast);
        cur = {
          name: member?.name || name,
          memberId: member?.id,
          values: {},
        };
        entries.push(cur);
        continue;
      }
    }
    if (!cur) continue;

    // 字段行
    const fieldM = line.match(STATUS_FIELD_LINE);
    if (fieldM) {
      const key = fieldM[1].trim();
      const val = fieldM[2].trim();
      // 「角色」键已经作为归属消费，跳过
      if (/^(角色|角色名|name)$/i.test(key)) continue;
      if (val) cur.values[key] = val;
    }
  }

  return { cleanText, entries };
}


/**
 * 归属声明行：`角色名：` 独占一行（行内除名字与全角冒号外没有别的内容）。
 * 与 matchSpeakerPrefix 不同，这里要求**冒号后为空**，才认定为归属声明。
 */
function matchOwnerLine(line: string): string | null {
  const m = line.match(/^\s*([^\s:：""（(【\[［\]］]{1,12})\s*[:：]\s*$/);
  if (!m) return null;
  const name = m[1].trim();
  if (!name) return null;
  if (/[，。！？；、,.!?;]/.test(name)) return null;
  return name;
}

/**
 * 剥离模型推理泄漏块（<think>/<thinking>），并提取 <content> 主体。
 * 与 vn-parser 同策略：有些模型会把 CoT 混进正文，必须先清掉。
 */
function stripReasoningAndExtract(text: string): string {
  let out = text.trim();
  // 1) 去掉 think / thinking 块
  out = out.replace(/<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>/gi, "").trim();
  // 2) 若模型用 <content> 包了正文，只取其中
  const m = out.match(/<content>([\s\S]*?)<\/content>/i);
  if (m) out = m[1].trim();
  return out;
}

/**
 * 把一行「角色名：」的行首识别出来。
 * 兼容：行首空格、** / # / > / - 装饰、有序号、全角/半角冒号、书名号包裹。
 * 返回 { name, rest }，未命中返回 null。
 *
 * ⚠️ 方括号唯一认领格式**必须带冒号**：`[角色名]:` / `[角色名]：`。
 *    这样 `[旁白]`（不带冒号）不会被误当成一个叫「旁白」的角色，
 *    而是在上方 NARRATION_TOKEN 处被显式消费。
 */
/**
 * 说明：这里**不再做通用「任意短词 + 冒号」认领**。
 *
 * 2026-10 修复（首次实机验收暴露的问题）：
 *   旧实现的兜底正则 `([^\s:：""（(【\[]{1,12})\s*[:：]` 会把**任何**
 *   带冒号的短句都当成说话人。实机里模型写的是「跑了一路，到这儿腿还没软。」
 *   这类半角逗号 + 冒号混排的叙述，被误判为角色名 → 于是整幕切碎、全部
 *   走 dialogue 分支，正文里再没有 narration 帧，视觉上却因数据侧兜底
 *   统一显示成旁白样式，就是「全部变斜体灰、头像名字消失」的根因。
 *
 *   新策略：**白名单认领**。只认两种行首标记，其余一律视为普通正文：
 *     ① `[角色名]:` / `【角色名】:`（方括号包裹，必须带冒号）
 *     ② `角色名：`（必须用**全角冒号**，且名字必须命中演员表）
 *   冒号必须是全角，是为了把「跑了一路，到这儿腿还没软。」这类半角冒号
 *   叙述排除在外 —— 中文写作里人名署名几乎不会用半角冒号。
 */
function matchSpeakerPrefix(line: string): { name: string; rest: string } | null {
  // ① 方括号格式 [角色名]: / 【角色名】：/ ［角色名］：—— 预设和模型输出常用此格式
  //    ⚠️ 必须同时吃半角 []、全角 ［］、中文 【】，因为提示词里写的是全角 ［］
  //       （半角 [ ] 在 JS 模板字符串里会被当成数组字面量求值，方括号会被吃掉）
  const bracketM = line.match(
    /^\s*[\[［【]\s*([^\[\]［］【】]{1,12}?)\s*[\]］】]\s*[:：]\s*(.*)$/
  );
  if (bracketM) {
    const bName = bracketM[1].trim();
    if (bName) {
      let bRest = (bracketM[2] || "").trim();
      bRest = bRest.replace(/[*#>]+\s*$/, "").trim();
      return { name: bName, rest: bRest };
    }
  }
  // ② 通用格式：全角书名号/装饰符包裹 + 角色名 + **全角冒号**
  const m = line.match(
    /^\s*(?:[*#>]{1,3}\s*)?(?:\d+[.、)]\s*)?\*{0,2}\s*([^\s:：""（(【\[［\]］]{1,12})\s*：\s*(.*)$/
  );
  if (!m) return null;
  const name = m[1].trim();
  if (!name) return null;
  // 名字里再排除「明显是句子」的情况：含逗号/句号/问号等标点的，肯定不是人名
  if (/[，。！？；、,.!?;]/.test(name)) return null;
  // 行首装饰符（**、#、>）在冒号后常以「**」形式收尾，需一并剥掉，
  // 否则会残留在帧正文开头（如 "** ⏎ （靠在门框上）"）。
  let rest = (m[2] || "").trim();
  // 尾部连续的装饰符（收尾的 ** / ## / >>），不吞正文里的普通标点
  rest = rest.replace(/[*#>]+\s*$/, "").trim();
  return { name, rest };
}

/**
 * 在演员表里按名字找人（精确优先 → 前缀模糊 → 全员表兜底）。
 */
function findCastMember(
  raw: string,
  actors: EnsembleCastMember[],
  allCast: EnsembleCastMember[]
): EnsembleCastMember | undefined {
  const n = raw.trim().replace(/^[-*#>\s]+|[-*#\s:：]+$/g, "");
  if (!n) return undefined;
  return (
    actors.find((a) => a.name === n) ||
    actors.find((a) => n.startsWith(a.name) || a.name.startsWith(n)) ||
    allCast.find((a) => a.name === n)
  );
}

/**
 * 解析整幕回复 → 帧序列。
 *
 * 规则（2026-10 定稿）：
 *   1. 行首 `[旁白]`（可带冒号）→ 显式旁白帧，暗号本身被 slice 掉，
 *      不进入正文；该行起的连续非空行都并入这一旁白帧，直到遇到
 *      下一个 `[旁白]` 或「角色名：」。
 *   2. 行首「角色名：」（在演员表里能认领）→ 开一个 dialogue 帧，
 *      后续行归入该帧，直到下一个说话人/旁白。
 *   3. 任何角色名与 `[旁白]` 之前的散行（环境描写）→ 兜底 narration 帧。
 *   4. 整段都没认领到任何标记 → 全部作为 narration（单帧），不丢字。
 *
 * @param text    模型原始回复
 * @param actors  本幕候选演员（通常传全员）
 * @param allCast 全员名单（兜底认领）
 */
export function parseEnsembleReply(
  text: string,
  actors: EnsembleCastMember[] = [],
  allCast: EnsembleCastMember[] = actors
): EnsembleParsedReply {
  const rawText = text ?? "";
  const cleaned = stripReasoningAndExtract(rawText);

  // ── 第六暗号：先剥状态块（整段摘除，绝不进正文、不占字数护栏）──
  const { cleanText, entries: statusData } = extractStatusBlock(cleaned, allCast);
  const body = cleanText;

  if (!body) {
    return {
      frames: [],
      multiSpeaker: false,
      rawText,
      statusData,
      cleanText: body,
    };
  }

  const lines = body.split(/\r?\n/);
  const frames: EnsembleFrame[] = [];

  // 当前正在累积的帧（有 speaker 才 push）
  let current: EnsembleFrame | null = null;
  // 当前是否正在累积一个「显式旁白」帧（由 [旁白] 暗号开启）
  let currentNarration: string[] | null = null;
  // 当前是否正在累积一个「心理描写」帧（由 [心理] 暗号开启），
  // 冻结该帧的说话人归属：心理属于「上一个开口的角色」，不是旁白。
  let currentInner: { text: string[]; speaker?: string; speakerId?: string; speakerAvatar?: string | null } | null =
    null;
  // 当前是否正在累积一个「叙述性文字」帧（由 [叙述] / [动作] 暗号开启）。
  // 同心理：归属上一个开口的角色，但渲染时只糊灰色，不出头像。
  let currentAction: { text: string[]; speaker?: string; speakerId?: string; speakerAvatar?: string | null } | null =
    null;
  // 当前是否正在累积一个「对白」帧（由 [对白] 暗号开启），归属当前角色。
  let currentDialogue: { text: string[]; speaker: string; speakerId?: string; speakerAvatar?: string | null } | null =
    null;
  // ── 归属声明（2026-10 第5轮定稿）──
  // 「角色名：」独占一行 = 归属声明行；之后所有 ［暗号］ 块都归这个角色，
  // 直到下一个归属声明。这让解析彻底摆脱「猜行首人名」的脆弱逻辑。
  let currentOwner: { name: string; id?: string; avatar?: string | null } | null =
    null;
  // 角色名之前的散行，先攒着，遇到说话人时作为旁白帧 flush
  const narrationBuffer: string[] = [];
  // 首帧之前是否已出现过说话人（用于判断是否真正「群像」）
  const speakersSeen = new Set<string>();
  // 幕首的散行（尚未出现任何角色）：暂存，等第一个角色出现后并进他的帧
  const pendingHead: string[] = [];

  const flushNarration = () => {
    const t = narrationBuffer.join("\n").trim();
    if (t) {
      // 无归属散行 → 旁白帧（渲染层负责斜体灰样式）。
      frames.push({ text: t, kind: "narration" });
    }
    narrationBuffer.length = 0;
  };

  /** 落地下一个 [旁白] 块。 */
  const flushExplicitNarration = () => {
    if (currentNarration) {
      const t = currentNarration.join("\n").replace(/\n{3,}/g, "\n\n").trim();
      if (t) frames.push({ text: t, kind: "narration" });
    }
    currentNarration = null;
  };

  /** 落地下一个 [心理] 块。心理归属上一个开口的角色（若还没有则无归属）。 */
  const flushInner = () => {
    if (currentInner) {
      const t = currentInner.text.join("\n").replace(/\n{3,}/g, "\n\n").trim();
      if (t) {
        frames.push({
          text: t,
          kind: "inner",
          speaker: currentInner.speaker,
          speakerId: currentInner.speakerId,
          speakerAvatar: currentInner.speakerAvatar,
        });
      }
    }
    currentInner = null;
  };

  /** 落地下一个 [叙述] / [动作] 块。归属上一个开口的角色，渲染时只糊灰色。 */
  const flushAction = () => {
    if (currentAction) {
      const t = currentAction.text.join("\n").replace(/\n{3,}/g, "\n\n").trim();
      if (t) {
        frames.push({
          text: t,
          kind: "action",
          speaker: currentAction.speaker,
          speakerId: currentAction.speakerId,
          speakerAvatar: currentAction.speakerAvatar,
        });
      }
    }
    currentAction = null;
  };

  const flushCurrent = () => {
    if (current) {
      current.text = current.text.replace(/\n+$/, "").trim();
      if (current.text) {
        frames.push(current);
      }
    }
    current = null;
  };

  /** 落地下一个 [对白] 块。归属当前角色，整块黑色。 */
  const flushDialogue = () => {
    if (currentDialogue) {
      const t = currentDialogue.text.join("\n").replace(/\n{3,}/g, "\n\n").trim();
      if (t) {
        frames.push({
          text: t,
          kind: "dialogue",
          speaker: currentDialogue.speaker,
          speakerId: currentDialogue.speakerId,
          speakerAvatar: currentDialogue.speakerAvatar,
        });
      }
    }
    currentDialogue = null;
  };

  /** 关闭所有正在累积的块（换归属 / 换块类型前统一调用）。 */
  const flushAllBlocks = () => {
    flushNarration();
    flushExplicitNarration();
    flushInner();
    flushAction();
    flushDialogue();
    flushCurrent();
  };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];

    // ── ⓪ 归属声明行「角色名：」（独占一行）──
    // 声明「下面这些 ［暗号］ 块都归谁」。本身不产出帧。
    const ownerName = matchOwnerLine(line);
    if (ownerName) {
      const member = findCastMember(ownerName, actors, allCast);
      if (member) {
        flushAllBlocks();
        currentOwner = {
          name: member.name,
          id: member.id,
          avatar: member.avatar ?? null,
        };
        speakersSeen.add(member.name);
        continue;
      }
      // 认不出的人名（如剧本里的临时配角「宋佳」）→ 仍然作为归属声明处理，
      // 但 id 置空：①归属正确（不会把后续内容错记到上一个 cast 角色头上）
      //            ②语音键自动不显示（非 cast 无绑定）
      flushAllBlocks();
      currentOwner = { name: ownerName, id: undefined, avatar: null };
      continue;
    }

    // ── ① 显式旁白暗号 [旁白] ──
    if (NARRATION_TOKEN.test(line)) {
      const rest = line.replace(NARRATION_TOKEN, "").trim();
      flushAllBlocks();
      currentNarration = rest ? [rest] : [];
      continue;
    }

    // ── ①b 显式心理暗号 [心理]（归属当前角色）──
    if (INNER_TOKEN.test(line)) {
      const rest = line.replace(INNER_TOKEN, "").trim();
      flushAllBlocks();
      currentInner = {
        text: rest ? [rest] : [],
        speaker: currentOwner?.name,
        speakerId: currentOwner?.id,
        speakerAvatar: currentOwner?.avatar ?? null,
      };
      continue;
    }

    // ── ①c 显式叙述/动作暗号 [叙述] / [动作]（同色，归属当前角色）──
    if (ACTION_TOKEN.test(line)) {
      const rest = line.replace(ACTION_TOKEN, "").trim();
      flushAllBlocks();
      currentAction = {
        text: rest ? [rest] : [],
        speaker: currentOwner?.name,
        speakerId: currentOwner?.id,
        speakerAvatar: currentOwner?.avatar ?? null,
      };
      continue;
    }

    // ── ①d 显式对白暗号 [对白]（归属当前角色，整块黑色）──
    if (DIALOGUE_TOKEN.test(line)) {
      const rest = line.replace(DIALOGUE_TOKEN, "").trim();
      flushAllBlocks();
      if (currentOwner) {
        currentDialogue = {
          text: rest ? [rest] : [],
          speaker: currentOwner.name,
          speakerId: currentOwner.id,
          speakerAvatar: currentOwner.avatar ?? null,
        };
      } else {
        // 没有归属声明却出现 [对白] → 兜底：当普通对白帧（无归属）
        currentDialogue = {
          text: rest ? [rest] : [],
          speaker: "—",
          speakerId: undefined,
          speakerAvatar: null,
        };
      }
      continue;
    }

    // ── ② 五种块累积中：所有行先归对应块 ──
    if (currentNarration) {
      currentNarration.push(line);
      continue;
    }
    if (currentInner) {
      currentInner.text.push(line);
      continue;
    }
    if (currentAction) {
      currentAction.text.push(line);
      continue;
    }
    if (currentDialogue) {
      currentDialogue.text.push(line);
      continue;
    }

    // ── ③ 兜底：不在任何块里的散行 ──
    // 有归属声明 → 当该角色的叙述性文字（灰）；否则进 pendingHead/旁白缓冲。
    if (currentOwner) {
      flushNarration();
      flushExplicitNarration();
      currentAction = {
        text: [line],
        speaker: currentOwner.name,
        speakerId: currentOwner.id,
        speakerAvatar: currentOwner.avatar ?? null,
      };
      continue;
    }
    if (speakersSeen.size === 0) {
      pendingHead.push(line);
    }
    narrationBuffer.push(line);
  }

  flushNarration();
  flushExplicitNarration();
  flushInner();
  flushAction();
  flushDialogue();
  flushCurrent();

  // 兜底：整段都没解析出帧 → 全作为一帧，绝不静默丢稿。
  if (frames.length === 0 && body) {
    frames.push({ text: body, kind: "narration" });
  }

  return {
    frames,
    multiSpeaker: speakersSeen.size > 1,
    rawText,
    statusData,
    cleanText,
  };
}

/**
 * 兼容旧调用：把帧序列再「聚回」切幕结构（每人一幕），
 * 供尚未迁移到帧渲染的代码路径（如落库为 EnsembleTurn[]）使用。
 *
 * ⚠️ 这是过渡期桥接函数：一旦渲染层全面改为帧模型即可删除。
 */
export function framesToActorSlices(
  frames: EnsembleFrame[]
): { name: string; speakerId?: string; content: string }[] {
  const out: { name: string; speakerId?: string; content: string }[] = [];
  for (const f of frames) {
    const name = f.speaker ?? "\u65c1\u767d";
    const last = out[out.length - 1];
    if (last && last.name === name) {
      last.content = last.content ? `${last.content}\n${f.text}` : f.text;
    } else {
      out.push({ name, speakerId: f.speakerId, content: f.text });
    }
  }
  return out.filter((s) => s.content.trim().length > 0);
}
