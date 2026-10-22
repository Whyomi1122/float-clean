"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Plus,
  Send,
  Trash2,
  Users,
  Compass,
  Check,
  RefreshCw,
  Pencil,
  Layers,
  Wrench,
  Eye,
  Settings,
  Clock,
  MessageSquare,
  Eraser,
  Play,
  Square,
  Type,
  Upload,
  MessageCircle,
} from "lucide-react";
import type { Character } from "@/lib/character-types";
import {
  resolveUserIdentity,
  loadUserIdentities,
  loadBindingConfig,
  resolveBinding,
  loadApiConfigs,
  loadWorldBooks,
} from "@/lib/settings-storage";
import {
  buildEnsembleWorldBookBlock,
  pickBoundBooks,
  type StickyLedger,
  type WorldBookHit,
  type WorldBookMiss,
} from "@/lib/ensemble-worldbook";
import {
  buildEnsembleMemoryBlock,
  buildEnsembleCrossMemoryBlock,
  type RoleMemoryBlock,
} from "@/lib/ensemble-memory";
import {
  buildArchiveBlock,
  computePendingTurns,
  computeVisibleTurns,
  computeWrappedTurnIds,
  computeArchiveStats,
  buildArchiveSummaryPrompt,
  makeStoryRangeLabel,
} from "@/lib/ensemble-archive";
import { syncEnsembleArchiveToMemory, removeEnsembleArchiveFromMemory } from "@/lib/ensemble-memory-bridge";
import { deliverToChat, describePendingSessions, getPendingSessions, discardDeliverySession, loadSessionTranscript, getDeliveredTurnIds, sanitizeChatLine } from "@/lib/ensemble-delivery";
import type { ApiConfig } from "@/lib/settings-types";
import { simpleLLMCall } from "@/lib/api-helpers";
import {
  resolveVoiceConfig,
  hasExplicitVoiceBinding,
  synthesizeSpeech,
  playAudioBlobViaMediaElement,
  unlockAudioPlayback,
} from "@/lib/tts-service";
import { fetchModelNames } from "@/lib/model-list";
import { TYPE, LEADING } from "@/components/ensemble/ensemble-tokens";
import {
  EnsembleToolsSheet,
  type EnsembleToolId,
} from "@/components/ensemble/ensemble-tools-sheet";
import type { UserIdentity } from "@/components/settings/user-identity";
import {
  EnsembleScript,
  EnsembleTurn,
  EnsembleCastMember,
  type EnsembleArchiveEntry,
  loadEnsembleScripts,
  saveOrUpdateEnsembleScript,
  deleteEnsembleScript,
  appendEnsembleTurn,
  deleteEnsembleTurn,
  updateEnsembleTurn,
  saveEnsembleFontData,
  loadEnsembleFontData,
} from "@/lib/ensemble-storage";
import { generateStoryboardImage } from "@/lib/ensemble-storyboard";
import { hydrateKvDb } from "@/lib/kv-db";
import { ensureSettingsStorageHydrated } from "@/lib/settings-storage";
import {
  loadChatAppSettings,
  CHAT_APP_SETTINGS_UPDATED_EVENT,
} from "@/lib/chat-storage";
import { shouldSendChatInputOnEnter } from "@/lib/chat-input-keyboard";
import {
  parseEnsembleReply,
  type EnsembleFrame,
  type EnsembleStatusEntry,
} from "@/lib/ensemble-parser";
import {
  resolveStoryTime,
  buildTimeAwarenessBlock,
  buildStatusContractBlock,
} from "@/lib/ensemble-time";
import {
  EnsembleStatusCardLayer,
  DEFAULT_STATUS_TEMPLATE,
  DEFAULT_STATUS_FIELDS,
  StatusLivePreview,
  extractFieldsFromTemplate,
} from "@/components/ensemble/ensemble-status-card";
import {
  StatusFieldEditor,
  StatusTemplateEditor,
  StatusToggleRow,
  StatusSectionHead,
  StatusFieldActions,
  StatusGenerateFromTemplateBtn,
  type StatusField,
} from "@/components/ensemble/ensemble-status-sheet";

// ══════════════════════════════════════════════════════════
// API 绑定桥（Ensemble ↔ 全局设置里的 API 配置）
// 走项目标准链路：loadBindingConfig → resolveBinding → loadApiConfigs
// appId 使用 "ensemble"（已注册进 ContentAppId），可在
// 「设置 → 绑定」里为群像单独指定 API，未指定则继承全局默认。
// ══════════════════════════════════════════════════════════

// 字号策略（2026-10 定稿）：群像内部字号**写死**，不跟随全局 --app-text-scale。
// 此前群像走 ts() 跟随全局缩放，导致「设置 → 主题 → 文字缩放」会连带放大
// 群像内部排版，把设计稿的节奏（正文/名字/旁白的层级差）整个破坏掉。
// 现在所有字号一律固定 px，与《功能》面板的 fs() 同一套约定。
function tpx(px: number): string {
  return `${px}px`;
}

const ENSEMBLE_APP_ID = "ensemble";

/**
 * 解析群像模式要用的 API 配置。
 * 级联优先级：剧本级覆盖 → 全局默认 → 角色默认 → 群像 app 覆盖 → 角色在群像上的覆盖。
 * 兜底：若级联结果为空（例如用户清空了全局默认），退到第一条 API 配置。
 *
 * modelOverride：剧本级模型覆盖。命中时把 defaultModel 换成它，
 * 但**不改动全局设置里的那条 API 配置**（返回的是浅拷贝）。
 */
export function resolveEnsembleApiConfig(
  characterId?: string,
  scriptOverrideId?: string,
  modelOverride?: string
): ApiConfig | null {
  const configs = loadApiConfigs();
  if (configs.length === 0) return null;

  /** 把剧本级模型覆盖叠加上去（只改返回值，不写回存储） */
  const withModel = (cfg: ApiConfig): ApiConfig =>
    modelOverride?.trim()
      ? { ...cfg, defaultModel: modelOverride.trim() }
      : cfg;

  // 剧本级覆盖优先级最高：用户在「功能 → 模型切换」里显式指定的那条
  if (scriptOverrideId) {
    const overridden = configs.find((c) => c.id === scriptOverrideId);
    if (overridden) return withModel(overridden);
  }
  try {
    const bindings = loadBindingConfig();
    const slot = resolveBinding(bindings, characterId, ENSEMBLE_APP_ID);
    if (slot.apiConfigId) {
      const found = configs.find((c) => c.id === slot.apiConfigId);
      if (found) return withModel(found);
    }
  } catch (e) {
    console.warn("[ensemble] resolveEnsembleApiConfig failed:", e);
  }
  return withModel(configs[0]);
}

/** 供 UI 显示用的模型名（真实取自全局设置里选中的那条 API 配置） */
export function ensembleModelLabel(characterId?: string): string {
  const cfg = resolveEnsembleApiConfig(characterId);
  if (!cfg) return "未配置 API";
  return cfg.defaultModel || cfg.name || cfg.provider || "未知模型";
}

// ──────────────────────────────────────────────────────────────
// 排版常量（2026-10 定稿，全部写死）
// 配色体系（用户定稿）：
//   · 对话（韩语原文 / 中文翻译）→ 黑色 C_DIALOG
//   · 心理描写（［心理］暗号）     → **与叙述完全一致**（1005 反馈：心理太明显，并入叙述）
//   · 叙述/动作                   → 灰 #8e8e93（1005 反馈：加深）
//   · 旁白                        → 更淡的灰 #b4b4b8 + 斜体（1005 反馈：与正文灰对调）
// 长文可读性优化（第5轮定稿）：层级靠**字号 + 灰度 + 段距**三重拉开。
//   核心原则：对白往前（重）· 叙述居中（灰）· 旁白最轻（淡灰斜体）。
// ──────────────────────────────────────────────────────────────
//   ⚠️ 1007 统一 token：正文里也用 TYPE 档位，禁止 13.5 / 12.5 / 13 这类散值。
//      正文档位只取 12(MICRO) / 14(SM) / 16(BASE) 三档：
//        对白 = 16（BASE，最重）
//        叙述/心理 = 14（SM，与对白同级，靠**颜色**降权，不靠字号）
//        角色名 = 12（MICRO）
//        旁白 = 14（SM，斜体 + 最淡灰）
//      这样「层级靠颜色/字重，不靠字号」，字号档位收敛，排版更整。
const T_DIALOG = TYPE.SM; // 14 对白（1007：保持 14，不放大 —— 用户反复强调「字别大」）
const T_ACT = TYPE.SM; // 14 叙述/动作（靠 #8e8e93 灰降权）
const T_INNER = TYPE.SM; // 14 心理（与叙述一致）
const C_DIALOG = "#1f1f1f"; // 对话：黑
const C_INNER = "#8e8e93"; // 心理：与叙述同色（1005 反馈：取消蓝色）
const C_ACT = "#8e8e93"; // 叙述/动作：灰（1005 反馈：加深，#b4b4b8 → #8e8e93）
const T_NAME = TYPE.MICRO; // 12 角色名
const C_NAME = "#5a5a5e"; // 角色名：加深（原 #8a8a8e 太浅，认不出人）
const T_NARR = TYPE.SM; // 14 旁白
const C_NARR = "#b4b4b8"; // 旁白：更淡的灰（1005 反馈：与正文灰对调）
// 旁白「真实生效」的视觉权重（1005 二次反馈修正）：
//   曾出现「常量已改成 #b4b4b8，实机仍比正文深」——最可能是被剧本级 customCss
//   覆盖（注入的 <style> 全文档生效且权重更高）。此处把旁白样式改为行内
//   style 直接输出，行内优先级最高，任何外部 CSS 都无法再盖掉它。
// ── 当前会话字号（剧本级 · 绝对 px）──
//   群像设计基准：对白/叙述/旁白 = 14px、角色名 = 12px（T_* 档位）。
//   用户设定的「正文字号」即 14 这一档的目标值，其余层级按 原值/14 等比换算。
//   由 <EnsembleApp> 在渲染前用 syncEnsembleFontSize() 写入当前剧本的 fontSize。
const ENS_FONT_BASE = 14; // 设计基准（正文 SM 档）
let ENS_FONT_SIZE = ENS_FONT_BASE;
/** 当前生效的自定义字体 family 名（无自定义时为 null）。由主组件渲染前同步。 */
let ENSEMBLE_FONT_FAMILY_ACTIVE: string | null = null;
/** 供主组件在每次渲染前同步当前剧本的**正文字号**（px，缺省 14）。 */
function syncEnsembleFontSize(size?: number) {
  ENS_FONT_SIZE =
    size && Number.isFinite(size) && size > 0 ? size : ENS_FONT_BASE;
}
/** 供主组件在每次渲染前同步当前剧本的字体 family（未设则 null）。 */
function syncEnsembleFontFamily(family?: string | null) {
  ENSEMBLE_FONT_FAMILY_ACTIVE = family && family.trim() ? family.trim() : null;
}
/** 字号专用：把设计字号按当前「正文 px ÷ 基准 14」等比换算后再走 tpx。 */
function ts(designPx: number): string {
  return tpx((designPx * ENS_FONT_SIZE) / ENS_FONT_BASE);
}

function narrStyle(): React.CSSProperties {
  return {
    fontSize: ts(T_NARR),
    color: C_NARR,
    fontWeight: 400,
    lineHeight: 1.9,
    opacity: 1,
    fontStyle: "italic",
    ...(ENSEMBLE_FONT_FAMILY_ACTIVE
      ? { fontFamily: `"${ENSEMBLE_FONT_FAMILY_ACTIVE}"` }
      : {}),
  };
}
/** 头像尺寸（1008d 回退：按截图1 实测 33px；1005 定稿曾为 35px） */
const AVATAR_PX = 33;
// 段距（长文排版定稿）：
// 1006 反馈（第6轮）：对白段距 11 → 10（收紧）；旁白间距 26 → 14（不再大喘气）。
// 1008 反馈（第8轮）：**AI 卡片整体太挤** → 只拉大「组件之间」的块距，
//   「文字内部」的段距（对白/叙述）**保持不变**（用户明确：文字部分除外）。
// 1008d 反馈（第六次）：第8轮方向被否决 → 按截图1/截图2 实测重写（见下）。
const GAP_DIALOG = 10; // 对白段之间（文字内部段距，不动）
const GAP_ACT = 7; // 叙述/动作段之间（文字内部段距，不动）
const GAP_INNER = GAP_ACT; // 心理块上下：与叙述一致（1005 反馈）
const GAP_NARR = 30; // 旁白上下
const GAP_BLOCK = 38; // 角色块之间（换人）

// ── 帧级左右内缩（1008d · 按截图1/截图2 实测反推）──
// 【定标】设备 vivo S15（1080px 宽，DPR=3）。
//   截图1 = 864×1920，无裁剪 → 被压到 0.8x（864/1080），换算 k1 = 1/3/0.8 = 0.4167
//   截图2 = 1080×732，裁剪图 → 原始分辨率，换算 k2 = 1/3 = 0.3333
//   ✅ 交叉验证：两张图独立换算后卡片外留白 17.1 vs 17、卡片宽 325.8 vs 326 —— 完全吻合
//
// 【截图1（AI 卡）实测 → CSS px】
//   卡片左 41 → 卡片外留白 41×k1 = 17
//   卡内衬（卡边→头像左）74×k1 = 31 → 取 30（用户口径「宁小不大」）
//   头像宽 80×k1 = 33
//   头像↔名字 31×k1 = 13 → 取 12（宁小不大）
//   正文左（卡边起）77×k1 = 32 → **对齐头像左沿**（不等名字，勿回改）
const FRAME_INSET = 17; // 卡片外左右留白（实测 17.1）
const FRAME_TEXT_INSET = 30; // 卡内衬（实测 31，宁小不大取 30）

// ── ⚠️ 正文左基准 = 头像左基准（1008d 关键回退）──
// 截图1 实测：头像左 115、正文左 118（差 3px 属字形抖动）→ 二者**同线**。
//   第8轮曾把正文改成对齐「名字左沿」（= 卡内衬 + 头像 + 间距 = 55px），
//   实测**截图1 并非如此**（名字左 225 ≠ 正文左 118）→ 本轮回退。
//   结论：**FRAME_BODY_INSET 恒等于 FRAME_TEXT_INSET**，不再叠加头像宽度。
const AVATAR_GAP = 12; // 头像与角色名间距（实测 13，宁小不大取 12）
const FRAME_BODY_INSET = FRAME_TEXT_INSET; // = 30（正文对齐头像左沿）

// ── 头像+名字「整块」左基准（1008e 用户实机批注）──
// 「头像和名字作为一个整块，往左边挪 5px；其余所有文字块都和旁白找齐」
//   旁白/正文/心理 = FRAME_TEXT_INSET(30) **不动**
//   头像块 = 30 - 5 = **25px** → 头像相对文字块「悬挂」出去 5px
const FRAME_HEAD_INSET = FRAME_TEXT_INSET - 5; // = 25

// ── 用户投稿卡·正文内衬（1008e 用户第4条：「正文格式照搬旁白」）──
//   旁白的左基准 = FRAME_BODY_INSET(30) → 用户卡正文取**同一个值**，
//   于是「旁白 / 正文 / 心理 / 用户投稿正文」全部落在同一条线上。
//   ⚠️ 字色不照搬旁白：用户 1006 第一次反馈 R1 明确要求
//      「用户卡片输入指令和内容……改成全部黑色」，该口径继续有效。
const FRAME_USER_INSET = FRAME_BODY_INSET; // = 30


// ── 输入框自动换行（1007 · 第三次反馈遗留项）──
// 用户要求：输入框「上下滑动、一行塞不下自动换行」，且要能继续长到多行。
// 做法：textarea 起步 1 行，每次输入把高度贴合 scrollHeight（先 auto 再取），
// 到 MAX 行高后不再长高，改为框内滚动。
const COMPOSER_MAX_PX = 116; // ≈ 5 行（正文 12px × 1.6 行高 + 上下 padding）
function autoGrowTextarea(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_PX)}px`;
}

// ── 每轮输出长度 / token 护栏（用户口径 2026-10-10 收紧定稿）──
// 设计要点：**提示词管「别写太多」，maxTokens 闸门管「别写太长」**，两者叠加。
//   - 提示词里的 N  → 模型自觉「写 N 字左右」
//   - maxTokens     → 服务器强制闸门（真正卡住，超了就截断）
//
// 1006 旧版：M = N + 200、1 字 ≈ 1.6 token → N=1000 时闸门 1920 token，
//   实测模型钻空子写到 1830 字（≈ 真实 1900 token），闸门形同虚设 —— 用户要求收紧。
// 1010 收紧：M = N + 150、1 字 ≈ 1.35 token → N=1000 时闸门 1552 token（≈ 1150~1200 字）。
//   既真正卡得住，又给「收尾一句话」留了口气，不至于把正文劈成半句。
const CHARS_MIN = 50;
const CHARS_MAX = 5000; // 目标值上限
const CHARS_TO_TOKENS = 1.35;
const TOKEN_HEADROOM = 1;
/** 收尾余量：给模型留出把最后一句写完的额度，不参与「目标字数」提示。 */
const CHARS_TAIL_MARGIN = 150;

/** 由目标字数 N 求实际允许的字数上限 M。用户定稿：M = N + 150。 */
function targetCharsToMaxChars(n: number): number {
  return Math.round(n) + CHARS_TAIL_MARGIN;
}

/** 由目标字数 N 求请求用的 maxOutputTokens（1 字 ≈ 1.35 token）。 */
function charsToMaxTokens(chars: number): number {
  return Math.ceil(targetCharsToMaxChars(chars) * CHARS_TO_TOKENS * TOKEN_HEADROOM);
}

// ── 架空起点（W1 第二版 · 手动文本输入）──
// 用户：「时间输入的时候可以规定一下格式 ai 好识别」。
// 规定格式 YYYY-MM-DD HH:mm（24 小时制），但解析时**容忍常见写法**，
// 免得用户少写个 0、用 "/" 或 "." 分隔就存不进去。
// 支持：2015-03-29 15:54 / 2015/3/29 15:54 / 2015.03.29 15:54 / 2015-03-29T15:54

/** 把用户手填的起点字符串规整成 ISO 形式；无法识别返回 null。 */
function normalizeTimeAnchor(raw: string): string | null {
  const s = (raw || "").trim().replace(/[年月]/g, "-").replace(/日/g, " ").replace(/[\/.]/g, "-");
  const m = s.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/
  );
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const M = Number(mo);
  const D = Number(d);
  const H = Number(h);
  const MI = Number(mi);
  if (M < 1 || M > 12 || D < 1 || D > 31 || H > 23 || MI > 59) return null;
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${y}-${pad(M)}-${pad(D)}T${pad(H)}:${pad(MI)}`;
}

/** 起点格式是否可识别（用于输入框下方的即时校验提示）。 */
function isValidTimeAnchor(raw: string): boolean {
  return normalizeTimeAnchor(raw) !== null;
}

/**
 * 正文排版组件（长文可读性版）。
 *
 *   · 对白（dialogue 帧）→ 黑 #1f1f1f，15px（主角）
 *   · 叙述/动作（action 帧）→ 淡灰 #b4b4b8，13.5px（退为背景）
 *   · 心理（inner 帧）→ 石板蓝 #536878，14px（不加斜体，只靠颜色）
 *   · 旁白（narration 帧）→ 灰 #8e8e93，13px + 斜体（换场呼吸点）
 *   · 不再 stripSymbols —— 隐藏符号会让「模型违规」永远看不见。
 *   · 括号规则：无条件剥除包裹整行的 （）（包括双语译文行）。
 *   · 段距按 kind 区分，见 GAP_* 常量。
 */

function BodyText({
  raw,
  kind = "act",
  inset = FRAME_BODY_INSET,
  voiceButton,
  fontFamily,
}: {
  raw: string;
  kind?: "dialogue" | "inner" | "act";
  /** 左基准（px）。默认与**头像左沿**对齐（1008d：FRAME_BODY_INSET == FRAME_TEXT_INSET）；
      嵌在心理块内时传 0（块自己已有内衬）。 */
  inset?: number;
  /** 可选：对白段右侧的语音播放键节点（由上层注入，BodyText 只负责挂载）。 */
  voiceButton?: React.ReactNode;
  /** 剧本级自定义字体 family（显式下传）。 */
  fontFamily?: string;
}) {
  const paras = (raw ?? "")
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (paras.length === 0) return null;
  const color =
    kind === "dialogue" ? C_DIALOG : kind === "inner" ? C_INNER : C_ACT;
  const size =
    kind === "dialogue" ? T_DIALOG : kind === "inner" ? T_INNER : T_ACT;
  // 行内直出（而非只靠 class）：防止剧本级 customCss 用更高权重覆盖配色/字号
  const headStyle: React.CSSProperties = {
    color,
    fontSize: ts(size),
    fontWeight: 400,
    lineHeight: 1.75,
    opacity: 1,
    // 剧本级自定义字体：**内联直出**（比 CSS 规则更稳，压过一切外部/继承声明）。
    //   优先用显式下传的 fontFamily prop，其次退回模块变量。
    //   注意：font-family 值本身会写 `!important` —— React 的 style 不支持
    //   `!important`，故这里仍可能被外部 `!important` 规则压住；但已同时注入
    //   `.ensemble-scope *` 通配规则兜底。
    ...(fontFamily || ENSEMBLE_FONT_FAMILY_ACTIVE
      ? { fontFamily: `"${fontFamily || ENSEMBLE_FONT_FAMILY_ACTIVE}"` }
      : {}),
    // 帧级内缩（1008d · 回退到截图1 口径）：
    //   **正文左基准 = 头像左基准**（FRAME_BODY_INSET == FRAME_TEXT_INSET = 30px），
    //   第8轮曾改成「对齐角色名左沿」（55px）→ 实测截图1 并非如此，已回退。
    //   正文右基准同为 FRAME_TEXT_INSET，左右对称。
    //   嵌在心理块内时由调用方传 inset=0（避免与块内衬叠加）。
    paddingLeft: tpx(inset),
    paddingRight: tpx(inset === 0 ? 0 : FRAME_TEXT_INSET),
  };
  // 段内段距：对白/心理宽松些，叙述紧凑些（成组感）
  // 1006：对白 +5 → +2（收紧，但仍略大于正文段距）
  const inner = kind === "act" ? GAP_ACT + 3 : GAP_DIALOG + 0;
  // 括号规则（用户定稿 2026-10-04 第5轮）：**无条件剥除**包裹整行的 （），
  // 包括双语译文行。注意：内置预设实际格式是「原文.（译文）」**同行**包裹，
  // 不是整行被括号包住；整行剥除只处理「整段都被括号包」的旧数据。
  // 语音键落点：挂**首段**末尾（与朗读原文同行）。
  const voiceAnchorIndex = voiceButton ? 0 : -1;
  return (
    <div
      className={`frame-body frame-${kind} tracking-[0.01em]`}
      style={headStyle}
    >
      {paras.map((p, i) => {
        const shown = /^[（(][\s\S]*[）)]$/.test(p)
          ? p.replace(/^[（(]\s*/, "").replace(/\s*[）)]$/, "")
          : p;
        const isVoiceAnchor = i === voiceAnchorIndex;
        return (
          <div
            key={i}
            className="whitespace-pre-wrap"
            // ⚠️ 1008e 修复（用户第2条「其余所有文字块都和旁白找齐」的根因）：
            //   原来这里是 `style={{ ...headStyle, marginTop }}` ——
            //   把 headStyle 里的 **paddingLeft / paddingRight 又套了一遍**，
            //   外层 div 30px + 内层 div 30px = **60px**。
            //   实测截图3：正文落在 63px，而旁白在 30px、心理块在 30px，
            //   正文整整右移了一个头像宽度，正是用户看到的不对齐。
            //   颜色 / 字号 / 行高本就继承自外层，内层只需 marginTop。
            style={{ marginTop: i === 0 ? 0 : inner }}
          >
            {shown}
            {/* 语音播放键：行内贴在**首段**末尾（与所读原文同行）。 */}
            {isVoiceAnchor ? voiceButton : null}
          </div>
        );
      })}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
/**
 * 朗读文本过滤：双语模式下**只读原文**，丢掉中文译文。
 *
 * 内置预设（`lib/builtin-preset.ts` bilingual_language_format）真实格式是
 * **同一行**：「原文.（译文）」——外语原文后紧贴全角圆括号包中文翻译，
 * 例如 `그래도 고마워.（还是谢谢你。）`。模型也可能用半角 `()`。
 *
 * 规则（不要猜语言、不要挑谚文行）：
 *   1. 取**第一行**（多段对白只读第一句）；
 *   2. 用行尾的 `（译文）` / `(译文)` 切开，朗读 = **括号前的原文**；
 *   3. 没有括号 → 整行都是原文，原样读。
 *
 * 历史坑（2026-10-16）：
 *   · 盲取「含谚文的行」——原文是中文、译文是韩文时会读成译文；
 *   · 只取首行、不剥括号 —— 同行双语会把「韩文+中文译文」整段读出来（本轮修这个）。
 */
function pickVoiceText(raw: string): string {
  const text = (raw ?? "").trim();
  if (!text) return "";
  // 逐行清洗后全部保留（此前只取首行，导致角色连说两句时第二句读不到）
  const lines = text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    // 行尾译文括号：全角（）优先，半角 () 兜底。非贪婪，避免误吃中间括号。
    .map((s) => (s.replace(/[（(][^）)]*[）)]\s*$/, "") || s).trim())
    .filter(Boolean);
  return lines.join("，");
}

/** 剧本会话字体的 font-family 注册名（运行时生成，与具体剧本无关；
    真正的字形数据在加载时通过 FontFace / @font-face 另行注册）。 */
const ENSEMBLE_CUSTOM_FONT_FAMILY = "EnsembleCustomFont";

// 帧解析缓存：同一 (content, 演员表) 只解析一次。
// 渲染经常重跑（编辑、切换版本、滚动重排），缓存可避免反复跑正则。
// 时间戳格式化：框底 DATE 需要精确到分钟（2026-10 起，此前只显示到日）。
// 兼容 ISO 字符串与毫秒数；解析失败时退回原串前 16 位，绝不显示 Invalid Date。
function formatMinute(ts: string | number | undefined): string {
  if (ts === undefined || ts === null || ts === "") return "——";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts).slice(0, 16);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}`;
}

const __frameCache = new Map<string, EnsembleFrame[]>();

/**
 * 把「用户 persona（面具）」注入演员表，得到一个虚拟 cast 成员。
 *
 * 为什么必须注入：剧本的 `cast` 只含**建剧本时勾选的 AI 演员**，用户 persona
 * （如「岳霖玉」）只以 `personaId` 存在剧本上，不在 cast 数组里。
 * 于是当模型以「岳霖玉：」开场时，`findCastMember` 三级兜底全部落空 →
 * member undefined → 该帧降级 narration（斜体灰、无头像、无署名），
 * 且首帧内容还会被 pendingHead 重复并进下一个角色 —— 这正是图3 的根因。
 *
 * 解决：把 persona 当作「id = persona.id、name = persona.name」的虚拟成员
 * 追加到识别用名单末尾。**只用于识别与渲染**，不回写剧本 cast（保持数据干净）。
 */
function castWithPersona(
  cast: EnsembleCastMember[],
  persona: { id?: string; name?: string; avatarUrl?: string } | null | undefined
): EnsembleCastMember[] {
  if (!persona?.name) return cast;
  const pid = persona.id ?? `persona:${persona.name}`;
  if (cast.some((c) => c.id === pid || c.name === persona.name)) return cast;
  return [
    ...cast,
    {
      id: pid,
      name: persona.name,
      avatar: persona.avatarUrl ?? null,
      persona: "",
    },
  ];
}

function framesOfTurn(
  turn: EnsembleTurn,
  cast: EnsembleCastMember[]
): EnsembleFrame[] {
  const key = `${cast.map((c) => c.id).join(",")}|${turn.content}`;
  const hit = __frameCache.get(key);
  if (hit) return hit;
  const frames = parseEnsembleReply(turn.content, cast, cast).frames;
  // 简单容量控制：超过 200 条清一次，避免无限增长
  if (__frameCache.size > 200) __frameCache.clear();
  __frameCache.set(key, frames);
  return frames;
}

// 帧渲染（单消息流）──
// 一个消息流里连续渲染整幕的每一帧：
//   · narration 帧 → 旁白段：整段斜体灰 + 下浅虚线，上下各留 24px
//   · dialogue 帧 → 角色块：方角虚线框头像 + 角色名（名字在头像右侧），正文紧随
// 相邻同一说话人的帧自动并组，避免重复署名。
function EnsembleFrameStream({
  frames,
  cast,
  onAvatarClick,
  onVoicePlay,
  playingVoiceKey,
  turnId,
  fontFamily,
}: {
  frames: EnsembleFrame[];
  cast: EnsembleCastMember[];
  /** 点头像 → 打开该幕的状态卡（未启用状态面板时由上层忽略） */
  onAvatarClick?: (speaker: string) => void;
  /** 点对白行的播放键 → 合成并播放该句语音。 */
  onVoicePlay?: (key: string, text: string, speaker?: string) => void;
  /** 正在播放的帧定位键（用于把播放键切换为「停止/加载」态）。 */
  playingVoiceKey?: string | null;
  /** 该幕 ID：与帧下标拼成稳定 key，供语音定位。 */
  turnId?: string;
  /** 剧本级自定义字体 family（显式下传，确定性优于模块变量）。 */
  fontFamily?: string;
}) {
  let lastSpeaker: string | undefined = "\u0000"; // 哨兵：保证首帧必署名
  // 跟踪上一帧是否为旁白，用于给旁白加「上下各 ≥ 一整行」的大段距。
  let prevWasNarration = false;
  // 同一角色的连续帧：第一帧给 16px，续帧给 16px（统一），换人才给 20px。
  let prevWasSameSpeaker = false;

  /** 块头（头像 + 角色名）：一段内同一角色只出一次，由调用方的 showName 控制。
      1007：抽出为函数，供 action / dialogue 两个分支共用 —— 动作/叙述现在也要带头像。 */
  const renderBlockHead = (speaker?: string) => {
    const m = speaker ? cast.find((c) => c.name === speaker) : undefined;
    return (
      <div
        className="flex items-center mb-4"
        // 1008d：头像 ↔ 角色名间距走 AVATAR_GAP（实测 13 → 宁小不大取 12）。
        // 1008e：「头像+名字作为整块」左基准 = FRAME_HEAD_INSET（25px），
        //   比其余文字块（30px）**再靠左 5px** → 头像「悬挂」出去。
        style={{
          gap: tpx(AVATAR_GAP),
          paddingLeft: tpx(FRAME_HEAD_INSET),
          paddingRight: tpx(FRAME_TEXT_INSET),
        }}
      >
        {/* 方角 35px 虚线框头像（定稿：此前 78px 过大）
            · 启用状态面板时，点头像 → 打开该角色的状态卡（用户定稿 10-06）。 */}
        <button
          type="button"
          onClick={
            onAvatarClick && speaker
              ? (e) => {
                  e.stopPropagation();
                  onAvatarClick(speaker);
                }
              : undefined
          }
          disabled={!onAvatarClick}
          className={`rounded-[8px] border border-dotted border-black/20 bg-black/[0.03] overflow-hidden flex items-center justify-center shrink-0 ${
            onAvatarClick ? "active:scale-95 transition-transform cursor-pointer" : ""
          }`}
          style={{ width: tpx(AVATAR_PX), height: tpx(AVATAR_PX) }}
          title={onAvatarClick ? "查看状态" : undefined}
        >
          {m?.avatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={m.avatar} alt={speaker} className="w-full h-full object-cover" />
          ) : (
            <span className="font-semibold text-black/35" style={{ fontSize: tpx(15) }}>
              {(speaker ?? "?").slice(0, 1)}
            </span>
          )}
        </button>
        {/* 角色名：置于头像右侧，字号故意小于正文（层级靠字号而非颜色） */}
        <div
          className="frame-name font-semibold tracking-wide"
          style={{
            fontSize: ts(T_NAME),
            color: C_NAME,
            fontWeight: 600,
            opacity: 1,
            ...(fontFamily || ENSEMBLE_FONT_FAMILY_ACTIVE
              ? { fontFamily: `"${fontFamily || ENSEMBLE_FONT_FAMILY_ACTIVE}"` }
              : {}),
          }}
        >
          {speaker}
        </div>
      </div>
    );
  };

  /** 对白末尾的小播放键：**行内**贴在最后一段文字后。
      · 未播放 → Play；播放/加载中 → Square（点击停止）。
      · 16px、极淡，避免抢正文视线；双语模式下挂在中文译句末尾。 */
  /** 该对白行是否应显示语音键：仅当说话人是剧本 cast 成员、且该角色「显式」绑定了语音。 */
  const isVoiceEligible = (speaker?: string, speakerId?: string): boolean => {
    if (!speaker && !speakerId) return false;
    // 必须在 cast 里能找到（先按 id，再按名字），用户方/临时配角一律不显示
    const m = speakerId
      ? cast.find((c) => c.id === speakerId)
      : cast.find((c) => c.name === speaker);
    if (!m) return false;
    // 只看该角色的「显式」语音绑定（全局默认绑定不算），确保只有真正配了音的角色才有键
    return hasExplicitVoiceBinding(m.id, "ensemble");
  };

  const renderVoiceButton = (key: string, text: string, speaker?: string, speakerId?: string) => {
    if (!onVoicePlay || !text.trim()) return undefined;
    // 双重保险：非 cast 角色一律不出语音键（含「宋佳：」这类落回正文的归属行）
    if (!isVoiceEligible(speaker, speakerId)) return undefined;
    const isThis = playingVoiceKey === key;
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onVoicePlay(key, text, speaker);
        }}
        className="inline-flex items-center align-middle active:scale-95 transition-transform"
        style={{
          marginLeft: tpx(6),
          width: tpx(16),
          height: tpx(16),
          WebkitTapHighlightColor: "transparent",
        }}
        title={isThis ? "停止" : "朗读这句"}
      >
        {isThis ? (
          <Square size={tpx(11)} strokeWidth={2.2} color="rgba(0,0,0,0.45)" />
        ) : (
          <Play size={tpx(11)} strokeWidth={2.2} color="rgba(0,0,0,0.22)" />
        )}
      </button>
    );
  };

  return (
    <div
      className="ensemble-frames"
      data-frame-count={frames.length}
      // 帧流外层（1007 修正 · 去双重缩进）：
      //   原来这里是 FRAME_INSET(10)，而每个子元素（头像行/旁白/正文/心理）
      //   又各自带 FRAME_TEXT_INSET → **两层叠加 = 25px**，且和卡片外 padding
      //   再叠，导致「越缩越窄、左右还看着不齐」。
      //   现在：**外层一律 0**，缩进只由子元素的 FRAME_TEXT_INSET(=15) 统一控制。
      //   → 旁白 / 对白 / 头像行 / 心理块 **共用同一条左右基准，严格对称**。
      style={{
        paddingLeft: 0,
        paddingRight: 0,
      }}
    >
      {frames.map((f, i) => {
        // ── 旁白帧 ──
        // 2026-10 定稿：旁白由模型显式打暗号「［旁白］」触发（解析器已 slice 掉暗号），
        // 不再是靠圆括号猜出来的。
        // 1006 第6轮：**删掉下浅虚线**（用户：「旁白下方虚线删掉」），只保留间距。
        // 同时旁白也跟着整体内缩，与头像/正文共用同一条左基准 + 严格对称。
        if (f.kind === "narration") {
          prevWasNarration = true;
          prevWasSameSpeaker = false;
          // 1007：旁白是「无归属」的分隔块。它出现后，紧接着的同角色帧
          //   应重新出一行头像（否则「皮韩宇 → 旁白 → 皮韩宇」第二段无头）。
          lastSpeaker = undefined;
          return (
            <div
              key={i}
              className="frame-narration whitespace-pre-wrap"
              style={{
                ...narrStyle(),
                // 旁白间距统一走 GAP_NARR（1006：26 → 14，原间距过大）。
                // 首帧不带上方间距，避免紧贴卡片顶边。
                marginTop: i === 0 ? 0 : tpx(GAP_NARR),
                marginBottom: tpx(GAP_NARR),
                // 1008d：旁白与头像/正文共用同一条左基准（FRAME_BODY_INSET
                //   现 == FRAME_TEXT_INSET，即对齐头像左沿）。
                paddingLeft: tpx(FRAME_BODY_INSET),
                paddingRight: tpx(FRAME_TEXT_INSET),
              }}
            >
              {f.text}
            </div>
          );
        }

        const member =
          (f.speakerId && cast.find((c) => c.id === f.speakerId)) ||
          (f.speaker ? cast.find((c) => c.name === f.speaker) : undefined);
        // ── 头像/名字的「块头」判定（2026-10-07 第二轮修 · 归属分组）──
        // 实机问题（1007 图）：模型习惯「先动作/叙述，再对白」，
        //   归属声明 `皮韩宇：` 已把整坨块断言给他，但旧逻辑只在 dialogue
        //   帧出头像 → 动作/叙述**无头像**、灰字贴在旁白底下，
        //   看起来像「并入了旁白」，归属完全丢失。
        //
        // 修法：只要帧带 speaker（action/inner/dialogue 都算），
        //   且与该块「上一个出过头的角色」不同 → 出一次头像行；
        //   同一角色连续多帧（含动作/叙述/心理/对白）**共用同一行头**，
        //   中间没换人 / 没插旁白就不重复出（用户明确要求「一行出一个」）。
        //
        // ⚠️ 旁白帧在上面提前 return，并已把 lastSpeaker 置空（见 narration
        //    分支），因此「皮韩宇 → 旁白 → 皮韩宇」会正确地再出一次头像。
        const hasSpeaker = !!f.speaker && f.speaker !== "—";
        const showName = hasSpeaker && f.speaker !== lastSpeaker;
        if (hasSpeaker) lastSpeaker = f.speaker;

        // 段距（长文排版定稿，第6轮 1006）：
        //   旁白之后     → 0（旁白自带 14px 下间距，不叠加）
        //   换角色       → 20px（角色块之间留呼吸）
        //   同角色续帧   → 对白 10 / 动作 7 / 心理 7
        const topMargin = prevWasNarration
          ? 0
          : showName
          ? GAP_BLOCK
          : f.kind === "dialogue"
          ? GAP_DIALOG
          : GAP_ACT;
        prevWasNarration = false;
        prevWasSameSpeaker = !showName;

        // 心理帧（1006 第6轮改版）：不再等同叙述，改为**独立静音块** ——
        // 极浅底 + 左侧一根细线，**不带任何「心理」小标签**（用户明确要求删标签）。
        // 与叙述仍是同一灰阶，层级只靠「块感」而非颜色，避免心理太跳。
        //
        // 1008 用户口径：**心理块自适应** + **文字两边留空太大要收窄** ——
        //   ① 底色块贴合文字宽度（width: fit-content），短句不再拉成通栏长条；
        //   ② 左右内衬由 12/12 收到 **6/6**（用户：「文字两边留空太大了」）；
        //   ③ 左基准对齐角色名（FRAME_BODY_INSET），与其它正文同一条线。
        // 1015 用户口径修正：**心理块改为整行通栏**（原来 fit-content 贴文字宽度，
        //   短句会缩成小方块；用户要求整行长方形）。
        if (f.kind === "inner") {
          return (
            <div
              key={i}
              className="frame-inner"
              style={{
                marginTop: tpx(topMargin),
                marginLeft: tpx(FRAME_BODY_INSET),
                marginRight: tpx(FRAME_TEXT_INSET),
                // 整行通栏
                width: "auto",
                boxSizing: "border-box",
                paddingTop: tpx(6),
                paddingBottom: tpx(6),
                paddingLeft: tpx(12),
                paddingRight: tpx(12),
                background: "rgba(0,0,0,0.022)",
                borderLeft: "2px solid rgba(0,0,0,0.10)",
                borderRadius: "0 7px 7px 0",
              }}
            >
              <BodyText raw={f.text} kind="act" inset={0} fontFamily={fontFamily} />
            </div>
          );
        }

        // 叙述/动作帧（用户定稿 2026-10-04 第5轮）：叙述性文字统一淡灰。
        // 1007 修正：**要出头像行**（归属正确），但一段内同一角色连续帧共用
        //   同一行头 —— 由 showName 保证「一行出一个」。
        // 1007 二次修正（换人分界更丑）：这里原来手写 `showName ? 0 : GAP_ACT`，
        //   → 换人时头像**零间距**贴住上一段，分界糊成一团。
        //   改为统一用 topMargin（换人 = GAP_BLOCK 20px，同角色续帧 = GAP_ACT 7px）。
        if (f.kind === "action") {
          return (
            <div key={i} className="frame-action" style={{ marginTop: tpx(topMargin) }}>
              {showName && renderBlockHead(f.speaker)}
              <BodyText raw={f.text} kind="act" fontFamily={fontFamily} />
            </div>
          );
        }

        return (
          <div key={i} style={{ marginTop: topMargin }}>
            {showName && renderBlockHead(f.speaker)}
            <BodyText
              raw={f.text}
              kind="dialogue"
              fontFamily={fontFamily}
              voiceButton={
                onVoicePlay && isVoiceEligible(f.speaker, f.speakerId)
                  ? renderVoiceButton(
                      `${turnId ?? ""}:${i}`,
                      f.text,
                      f.speaker,
                      f.speakerId
                    )
                  : undefined
              }
            />
          </div>
        );
      })}
    </div>
  );
}

// 通用底部子弹窗：与「功能」面板同一套视觉（浅灰底、圆角、居中标题）
// 返回体系（v3）：
//   · 顶栏右侧「← 返回」= 关闭本层（子面板 → 功能面板；功能面板 → 剧本界面）
//   · 同时与工作区左上角的浮层返回键并存（用户要求：内置返回与顶栏返回任选其一都能用）
//   · 底部不再放任何「返回」按钮 —— 只允许放「保存 / 应用」这类功能键
//   · onBack 仅用于同层内的次级导航（如模型二级 → 一级的「换 API」）
function MiniSheet({
  title,
  subtitle,
  onClose,
  onBack,
  backLabel = "返回",
  headerAction,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  /** 可选：同层内的“上一级”（如模型二级→一级）。存在时显示在右侧。 */
  onBack?: () => void;
  backLabel?: string;
  headerAction?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    // 1007 弹窗化（用户口径：不是底部 sheet，是**单独一个居中浮窗**）：
    //   蒙层铺满 → 内容层居中（items-center/justify-center）→ 四边留边
    //   → 圆角四角 + 最大宽高受限 → 点蒙层关闭。
    // 1007b：入场改 softRise（缩放 + 上浮 + 模糊收敛），去掉「从底部弹起」感。
    <div
      className="absolute inset-0 z-[55] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/45 backdrop-blur-[3px]" />
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative bg-[#f2f2f4] rounded-[22px] px-4 pt-5 pb-5 w-full max-w-[420px] max-h-[80%] overflow-y-auto shadow-[0_18px_50px_rgba(0,0,0,0.28)] animate-[softRise_300ms_cubic-bezier(0.16,1,0.3,1)]"
        data-ens-ui="1"
      >
        <div className="px-1.5 mb-3.5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div
              className="font-bold tracking-tight text-[#111111] leading-none"
              style={{ fontSize: "18px" }}
            >
              {title}
            </div>
            {subtitle && (
              <div
                className="tracking-[0.2em] font-medium text-black/30 mt-2"
                style={{ fontSize: "11px" }}
              >
                {subtitle}
              </div>
            )}
          </div>
          <div className="shrink-0 flex items-center gap-1.5">
            {headerAction}
            {onBack && (
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={onBack}
                className="shrink-0 px-2.5 py-1.5 rounded-full bg-black/[0.06] text-black/50 active:scale-95 transition-transform"
                style={{ fontSize: "11px" }}
              >
                ← {backLabel}
              </button>
            )}
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onClose}
              className="shrink-0 px-2.5 py-1.5 rounded-full bg-white text-black/45 active:scale-95 transition-transform"
              style={{ fontSize: "11px" }}
              title="返回"
            >
              {onBack ? "✕" : "← 返回"}
            </button>
          </div>
        </div>
        <div className="space-y-2.5">{children}</div>
      </div>
    </div>
  );
}

// 通用确认弹窗：用于删除剧本 / 删除幕等不可逆操作
function ConfirmDialog({
  title,
  message,
  confirmLabel = "删除",
  onCancel,
  onConfirm,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="absolute inset-0 z-[60] bg-black/40 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }}
    >
      <div
        className="bg-white rounded-2xl w-full max-w-[300px] p-5 shadow-xl border border-black/5 flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
        data-ens-ui="1"
      >
        <div className="space-y-1.5">
          <div className="font-semibold text-sm text-[#1a1a1a]">{title}</div>
          <div className="text-xs text-black/50 leading-relaxed">{message}</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 py-2 rounded-xl text-xs font-medium bg-black/[0.05] hover:bg-black/[0.08] text-black/60 transition-colors"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 py-2 rounded-xl text-xs font-medium bg-red-500 hover:bg-red-600 text-white transition-colors"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 消息操作条：‹ 1/1 › 多 roll 翻页 + 重 roll + 编辑 + 删除
 * inline=true 时用于卡片底部元信息行右侧（紧凑、低对比）；
 * inline=false 时用于旁白卡（悬浮在右上角）。
 */
function TurnActionBar({
  turn,
  versions,
  index,
  isRerolling,
  canReroll,
  inline = false,
  onReroll,
  onSwitch,
  onEdit,
  onDelete,
  onDeliver,
}: {
  turn: EnsembleTurn;
  versions?: string[];
  index: number;
  isRerolling: boolean;
  canReroll: boolean;
  inline?: boolean;
  onReroll: () => void;
  onSwitch: (dir: -1 | 1) => void;
  /** 编辑本幕。不传则不显示编辑按钮（如「来自聊天」卡）。 */
  onEdit?: () => void;
  onDelete: () => void;
  /** 投递到聊天 App（仅 AI 幕、且有说话人时才提供）。 */
  onDeliver?: () => void;
}) {
  const total = versions?.length ?? 1;
  const atFirst = index <= 0;
  const atLast = index >= total - 1;

  return (
    <div
      className={`flex items-center gap-1 shrink-0 ${
        inline
          ? "text-black/30"
          : "absolute top-0 right-0 opacity-0 group-hover:opacity-100 transition-opacity text-black/35 bg-white/70 backdrop-blur rounded-lg"
      }`}
    >
      {total > 1 && (
        <>
          <button
            type="button"
            disabled={atFirst}
            onClick={() => onSwitch(-1)}
            className="p-1 disabled:opacity-25 hover:text-black/70"
            title="上一版"
          >
            <ChevronLeft size={13} />
          </button>
          <span className="text-[11px] font-mono tabular-nums">
            {index + 1}/{total}
          </span>
          <button
            type="button"
            disabled={atLast}
            onClick={() => onSwitch(1)}
            className="p-1 disabled:opacity-25 hover:text-black/70"
            title="下一版"
          >
            <ChevronRight size={13} />
          </button>
          <span className="w-px h-3 bg-black/10 mx-0.5" />
        </>
      )}

      {canReroll && (
        <button
          type="button"
          disabled={isRerolling}
          onClick={onReroll}
          className="p-1 hover:text-black/70 disabled:opacity-40"
          title="重新生成本幕"
        >
          <RefreshCw size={12} className={isRerolling ? "animate-spin" : ""} />
        </button>
      )}
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          className="p-1 hover:text-black/70"
          title="编辑本幕"
        >
          <Pencil size={12} />
        </button>
      )}
      {onDeliver && (
        <button
          type="button"
          onClick={onDeliver}
          className="p-1 hover:text-black/70"
          title="投递到聊天"
        >
          <Send size={12} />
        </button>
      )}
      <button
        type="button"
        onClick={onDelete}
        className="p-1 hover:text-red-500"
        title="删除本幕"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

/**
 * 统一顶栏：不使用 Tailwind h-14，而是复刻项目 .page-shell > .page-header 的 * 定位契约，保证在任何宿主容器下点击都能命中（避免被 .phone-status-bar 覆盖）。
 * 左侧返回键必须始终可点。
 */
function EnsembleHeader({
  title,
  subtitle,
  onBack,
  right,
  showBack = true,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  onBack: () => void;
  right?: React.ReactNode;
  showBack?: boolean;
}) {
  return (
    <div
      className="relative z-20 shrink-0 bg-white/80 backdrop-blur-md border-b border-black/[0.06]"
      style={{ paddingTop: "var(--page-header-safe-top, 48px)" }}
    >
      <div className="grid grid-cols-[44px_1fr_44px] items-center px-3 min-h-[42px]" data-ens-ui="1">
        {showBack ? (
          <button
            type="button"
            aria-label="返回"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onBack();
            }}
            className="w-11 h-11 grid place-items-center rounded-full hover:bg-black/5 text-black/70 active:scale-90 transition"
            style={{ WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
          >
            <ChevronLeft size={22} strokeWidth={1.8} />
          </button>
        ) : (
          <span />
        )}
        <div className="flex flex-col items-center min-w-0">
          <div className="text-[15px] font-semibold tracking-tight truncate max-w-full">
            {title}
          </div>
          {subtitle ? (
            <div className="text-[11px] text-black/40 font-mono truncate max-w-full">
              {subtitle}
            </div>
          ) : null}
        </div>
        <div className="flex justify-end items-center min-w-[44px]">{right}</div>
      </div>
    </div>
  );
}

interface EnsembleAppProps {
  characters: Character[];
  currentUser?: { name: string; avatar?: string };
  /** 与项目其他 App 统一：关闭当前 App */
  onClose?: () => void;
  /** 投递到聊天后一键跳到那个聊天室。isGroup 决定落到单聊还是群聊页。 */
  onJumpToChat?: (chatSessionId: string, isGroup: boolean) => void;
}

type EnsembleView = "personas" | "scripts" | "create" | "workspace";

/**
 * 从一幕正文里抽出「可以当微信消息发出去」的台词。
 *
 * 群像正文是线下剧本格式，混着 [旁白] / [动作] / [心理] / 舞台说明 / 场景标题。
 * 投递到聊天室必须只剩对白 —— 用户明确要求「格式都是线上的微信格式」。
 */
/** 投递候选：一句真正能发出去的台词 + 这一句属于谁。 */
type DeliverableLine = { text: string; speaker: string | null };

/** [旁白] [动作] [心理] [叙述] [对白] 这类块标记。 */
const BLOCK_TAG_RE = /^\[(旁白|动作|心理|描写|叙述|场景|说明|环境|内心|画外音|系统|对白|台词)\]\s*[:：]?\s*/;
/** 只算「不是台词」的块标记：这些块下面的内容整段丢弃。 */
const NON_DIALOGUE_TAG_RE = /^[\[［【](旁白|动作|心理|描写|叙述|场景|说明|环境|内心|画外音|系统)[\]］】]\s*[:：]?\s*/;
/** 判断一整行是不是「角色名：」的行首。 */
function matchSpeakerHeader(line: string): string | null {
  const m = line.match(/^([^\s：:\[\]【】（）()]{1,16})\s*(?:[（(][^）)]{0,20}[)）])?\s*[：:]\s*$/);
  return m ? m[1].trim() : null;
}

/**
 * 从一幕正文里抽出「可以当微信消息发出去」的台词，并记下每句的说话人。
 *
 * 群像正文是线下剧本格式，典型长这样：
 * ```
 * ［旁白］:
 * 窗外的夜雨渐渐密了起来……
 * 金成帝：
 * ［动作］:
 * 他坐进车里拉起手刹……
 * ［对白］:
 * 「문 제대로 잠갔냐.」
 * 门好好反锁了吗。
 * ```
 * 投递到聊天室必须只剩对白 —— 用户明确要求「格式都是线上的微信格式」。
 */
function extractDeliverableLines(content: string): DeliverableLine[] {
  const raw = content ?? "";
  const out: DeliverableLine[] = [];
  let speaker: string | null = null;
  /** 当前是否处在「旁白 / 动作 / 心理」块里 —— 里面的每一行都不是台词。 */
  let inNonDialogueBlock = false;
  /** 当前所处的台词块（[对白]）—— 只有它里面的内容才算台词。 */
  let inDialogueBlock = false;

  for (const rawLine of raw.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;

    // 1) 块标记：[旁白] [动作] [对白］［叙述］…（半角/全角括号都认）
    const tag = line.match(
      /^[\[［【](旁白|动作|心理|描写|叙述|场景|说明|环境|内心|画外音|系统|对白|台词)[\]］】]\s*[:：]?\s*/,
    );
    if (tag) {
      const isDialogue = tag[1] === "对白" || tag[1] === "台词";
      inDialogueBlock = isDialogue;
      inNonDialogueBlock = !isDialogue;
      line = line.slice(tag[0].length).trim();
      // 「［对白］:」单独一行时后面才是台词，这行本身没内容
      if (!line) continue;
    }

    // 2) 「角色名：」单独一行 → 记录说话人并跳过
    const header = matchSpeakerHeader(line);
    if (header) {
      speaker = header;
      continue;
    }

    // 3) 非台词块里的内容整段丢弃（旁白 / 动作 / 心理）
    if (inNonDialogueBlock) continue;

    // 4) 纯场景标题 / 分隔符
    if (/^(场景|时间|地点|转场|幕|第.{1,4}幕)$/.test(line)) continue;
    if (/^[—\-=＝]{3,}$/.test(line)) continue;

    // 5) 行内还带块标记（「[动作]:他……」跟内容在同一行）
    const inlineTag = line.match(NON_DIALOGUE_TAG_RE);
    if (inlineTag) {
      inNonDialogueBlock = true;
      inDialogueBlock = false;
      continue;
    }

    // 6) 行首的人名 + 内容：「金成帝：门好好反锁了吗。」
    const named = line.match(/^([^\s：:\[\]【】（）()]{1,16})\s*(?:[（(][^）)]{0,20}[)）])?\s*[：:]\s*(.+)$/);
    if (named) {
      speaker = named[1].trim();
      line = named[2].trim();
    }

    // 7) 整行被括号包住的舞台说明，整行丢掉
    if (!line) continue;
    if (/^[（(［\[【].*[)）］\]】]$/.test(line) && !/["“”「」『』]/.test(line)) continue;

    // 8) ⚠️ 不在 [对白] 块里、也没有引号包着 —— 这多半是叙述/动作，
    //    不能当台词投出去。
    //    之前这里不管三七二十一全收，所以「窗外的夜雨渐渐密了起来……」
    //    「他坐进车里拉起手刹……」都被当成台词了。
    if (!inDialogueBlock && !/["“”「」『』]/.test(line)) continue;

    // 9) 洗掉残留的括号表演、心理块和包住台词的引号
    const cleaned = sanitizeChatLine(line);
    if (!/[\u4e00-\u9fa5a-zA-Z0-9가-힣]/.test(cleaned)) continue;
    out.push({ text: cleaned, speaker });
  }

  // 一句都抽不出来就退回原文，至少别让用户无从下手
  if (out.length > 0) return out;
  const fallback = sanitizeChatLine(raw);
  return fallback ? [{ text: fallback, speaker: null }] : [];
}

export function EnsembleApp({
  characters = [],
  currentUser,
  onClose,
  onJumpToChat,
}: EnsembleAppProps) {
  // 用 ref 包一层，避免 doDeliverToChat 等回调因闭包拿到旧 props
  const onJumpToChatRef = useRef(onJumpToChat);
  useEffect(() => {
    onJumpToChatRef.current = onJumpToChat;
  }, [onJumpToChat]);
  const [scripts, setScripts] = useState<EnsembleScript[]>([]);
  const [currentScript, setCurrentScript] = useState<EnsembleScript | null>(null);
  const [view, setView] = useState<EnsembleView>("personas");
  const [selectedCastIds, setSelectedCastIds] = useState<string[]>([]);
  const [titleInput, setTitleInput] = useState("");
  const [inputText, setInputText] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  /** 正在生成中：用于显示「取消生成」（真机中断的唯一途径是卸载本组件） */
  const [isComposing, setIsComposing] = useState(false);

  // ── 「功能」面板（+ 号）及其子弹窗 ──
  const [showToolsSheet, setShowToolsSheet] = useState(false);
  // showPaletteSheet 已删除（卡片配色已移除）
  const [showCssSheet, setShowCssSheet] = useState(false);
  const [showModelSheet, setShowModelSheet] = useState(false);  /** 剧本设置（输出长度）子弹窗 */
  const [showSettingsSheet, setShowSettingsSheet] = useState(false);
  // ── 状态面板 / 时间感知（2026-10-06）──
  const [showStatusSheet, setShowStatusSheet] = useState(false);
  const [showTimeSheet, setShowTimeSheet] = useState(false);
  /** 世界书绑定子弹窗（2026-10-09 M2-b） */
  const [showWorldBookSheet, setShowWorldBookSheet] = useState(false);
  const [showStoryboardSheet, setShowStoryboardSheet] = useState(false);
  /** 投递：先选「用哪一句台词作为起点」，再选落点（单聊 / 群聊）。 */
  const [deliverPicker, setDeliverPicker] = useState<{
    turn: EnsembleTurn;
    member: EnsembleCastMember;
    /** 从该幕正文里抽出来的可选台词（已去掉旁白/动作/心理，附说话人）。 */
    lines: DeliverableLine[];
  } | null>(null);
  /** 杀青前确认：还有未归入的聊天，是否一起注入总结。 */
  const [wrapConfirm, setWrapConfirm] = useState<{ count: number } | null>(null);
  /** 投递落点选择阶段：先选台词，再选单聊/群聊。 */
  const [deliverTargetStage, setDeliverTargetStage] = useState(false);
  const [deliverLine, setDeliverLine] = useState<DeliverableLine | null>(null);

  /** 打开投递面板：抽出这一幕里「能当微信消息发出去」的台词。 */
  const openDeliverPicker = (turn: EnsembleTurn, member: EnsembleCastMember) => {
    const lines = extractDeliverableLines(turn.content);
    setDeliverPicker({ turn, member, lines });
    setDeliverTargetStage(false);
    // 默认选最后一句 —— 一般是最后一句最好走剧情
    setDeliverLine(lines.length > 0 ? lines[lines.length - 1] : null);
  };

  /** 这一句到底是谁说的：优先按台词自带的说话人，其次退回「点投递的那个角色」。 */
  const resolveSpeaker = (
    member: EnsembleCastMember,
    line: DeliverableLine | null,
  ): EnsembleCastMember => {
    const name = line?.speaker?.trim();
    if (name && currentScript) {
      const hit = currentScript.cast.find(c => c.name === name);
      if (hit) return hit;
    }
    return member;
  };

  /** 真正执行投递。target 决定了落在单聊还是群聊。 */
  const doDeliverToChat = (
    turn: EnsembleTurn,
    member: EnsembleCastMember,
    target: { kind: "direct"; characterId: string } | { kind: "group"; participantIds: string[] },
    contentOverride?: string,
    lineOverride?: DeliverableLine | null,
  ) => {
    if (!currentScript) return;
    const line = lineOverride !== undefined ? lineOverride : deliverLine;
    // 最后一道保险：即便台词来源有污染，投出去的一定是干净的微信格式
    const content = sanitizeChatLine(contentOverride ?? line?.text ?? turn.content);
    if (!content) {
      setToast("这一句洗完之后是空的，换一句吧");
      return;
    }
    // ⚠️ 必须按「这句是谁说的」投，不能一律用点投递的那个角色
    const speaker = resolveSpeaker(member, line);
    const result = deliverToChat({
      characterId: speaker.id,
      characterName: speaker.name,
      content,
      scriptId: currentScript.id,
      scriptTitle: currentScript.title || "未命名剧本",
      turnId: turn.id,
      target:
        target.kind === "direct" ? { kind: "direct", characterId: speaker.id } : target,
    });
    if (!result.ok) {
      setToast(`投递失败：${result.error}`);
      return;
    }
    setToast(`已投递 · ${speaker.name}`);
    setDeliverPicker(null);
    setDeliverLine(null);
    setDeliverTargetStage(false);
    onJumpToChatRef.current?.(result.chatSessionId, result.isGroup);
  };
  /** 世界书触发日志子弹窗（2026-10-09 M2-a） */
  const [showWorldBookLogSheet, setShowWorldBookLogSheet] = useState(false);
  /** 世界书绑定草稿：选中的世界书 id 集合（保存前） */
  const [worldBookIdsDraft, setWorldBookIdsDraft] = useState<string[]>([]);
  /**
   * 世界书触发日志（2026-10-09 M2-a）：每次生成后记录本轮命中/未命中。
   * 面板展示「本轮命中 N 条 / 未命中 M 条」，逐条列出触发方式与触发词，
   * 解决「不知道 AI 到底翻出了哪条设定」的黑盒问题（付费小手机也没做到）。
   */
  const [worldBookLog, setWorldBookLog] = useState<{
    hits: WorldBookHit[];
    misses: WorldBookMiss[];
    scannedCount: number;
    turnIndex: number;
    at: number;  } | null>(null);
  /**
   * 记忆库日志（2026-10-09 M1）：每幕生成后记录「用了哪些角色的记忆、各几条」。
   * 与触发日志同源，解决「不知道它提取了哪条记忆」的黑盒问题。
   */
  const [memoryLog, setMemoryLog] = useState<{
    blocks: RoleMemoryBlock[];
    roleCount: number;
    totalCount: number;
    enabled: boolean;
    turnIndex: number;
  } | null>(null);
  /**
   * 护栏诊断（2026-10-11 · 治「长度指令只管一轮」的可观测性）：
   * 记录本轮请求发出去的护栏值与实际回来的用量，让用户不用开 DevTools
   * 就能判断护栏是「生效 / 被中转忽略 / 本地没发」。
   *
   *   sentMaxTokens    —— 我们算出来并发出去的 token 闸门
   *   completionTokens —— 供应商回报的实际输出 token
   *   finishReason     —— length = 被闸门截断；stop = 模型自己停
   *   contentChars     —— 本轮正文实际字数
   *   targetChars/maxChars —— 给用户看的「目标 / 上界」字数
   */
  const [guardrailLog, setGuardrailLog] = useState<{
    sentMaxTokens: number | null;
    completionTokens: number | null;
    finishReason: string | null;
    contentChars: number;
    targetChars: number;
    maxChars: number;
    turnIndex: number;
    at: number;
  } | null>(null);
  /**
   * 杀青归档状态（2026-10-10）：
   *   · archiveWrappedIds —— 已杀青的幕 id 集合（UI 打 ✓Wrapped 印记用）
   *   · archiveStats       —— 三栏统计（总条数 / 已杀青 / 未杀青）
   *   · archiveBusy        —— 正在总结中（防重复点击）
   *   · archiveError       —— 上次总结失败的原因
   *   · showArchiveSheet   —— 归档面板开关
   */
  const [archiveWrappedIds, setArchiveWrappedIds] = useState<Set<string>>(
    () => new Set()
  );
  /**
   * 已录入聊天的幕 id（投递 → 返回剧情成功后打标）。
   * 用户要求：返回后下一轮用户卡片上要能看到「已录入聊天记录」。
   */
  const [deliveredTurnIds, setDeliveredTurnIds] = useState<Record<string, number>>({});
  const [archiveStats, setArchiveStats] = useState<{
    total: number;
    wrapped: number;
    pending: number;
  }>({ total: 0, wrapped: 0, pending: 0 });
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [showArchiveSheet, setShowArchiveSheet] = useState(false);
  const [archiveCountDraft, setArchiveCountDraft] = useState(20);
  const [archiveContentDraft, setArchiveContentDraft] = useState("");
  /**
   * 历史记录分页（2026-10-10 用户要求）：每 10 轮一段，默认只渲染最后 1 段，
   * 往上点「加载更早记录」逐段展开。**纯 UI 分页**——不改数据、不碰杀青。
   */
  const HISTORY_BATCH = 10;
  const [earlierBatches, setEarlierBatches] = useState(1);
  /** 未杀青超限提醒阈值（超过这个幕数就提示「该杀青了」） */
  const ARCHIVE_PENDING_ALERT = 40;
  /** 本会话内是否已忽略超限提醒横幅 */
  const [archiveBannerDismissed, setArchiveBannerDismissed] = useState(false);
  /** 状态面板草稿（点保存才落库） */
  const [statusEnabledDraft, setStatusEnabledDraft] = useState(false);
  const [statusFieldsDraft, setStatusFieldsDraft] = useState<StatusField[]>([]);
  const [statusTemplateDraft, setStatusTemplateDraft] = useState("");
  /** 时间感知草稿（W1：realtime 由开关 ON/OFF 直接决定，不再单独存草稿） */
  const [timeEnabledDraft, setTimeEnabledDraft] = useState(false);
  const [timeAnchorDraft, setTimeAnchorDraft] = useState("");
  /** 当前正在查看状态卡的角色 id（null = 未打开） */
  const [statusCardTurnId, setStatusCardTurnId] = useState<string | null>(null);
  /** 当前要优先展示的角色 id（点头像时指定；未指定则按数据顺序） */
  const [statusCardMemberId, setStatusCardMemberId] = useState<string | null>(null);
  // ── Settings 全页草稿（图1 · 1006）──
  const [openingDraft, setOpeningDraft] = useState("");
  const [contextDraft, setContextDraft] = useState(40);
  const [povDraft, setPovDraft] = useState<"first" | "second" | "third">("third");
  const [onlineSyncDraft, setOnlineSyncDraft] = useState(false);
  /** 剧本设置里「每轮字数」的草稿值，点保存才落库（= 每个角色各自的字数） */
  const [charsDraft, setCharsDraft] = useState(600);
  /**
   * 字数输入框的**字符串**草稿。
   * 必须与 charsDraft（number）分开：存 number 时清空输入框会被 React 立刻回填 0，
   * 用户无法删干净，再输入就得到「0250」这种带前导 0 的脏值（1006 实机 bug）。
   */
  const [charsInput, setCharsInput] = useState("600");
  const [cssDraft, setCssDraft] = useState("");
  /** 06 TYPOGRAPHY · 当前会话字体来源（未自定义时为 undefined） */
  const [fontSourceDraft, setFontSourceDraft] = useState<"upload" | "url" | undefined>(undefined);
  /** 06 TYPOGRAPHY · 链接字体的 URL */
  const [fontUrlDraft, setFontUrlDraft] = useState("");
  /** 06 TYPOGRAPHY · 已上传字体的文件名（仅用于显示「已上传 · xxx.ttf」） */
  const [fontUploadName, setFontUploadName] = useState("");
  /** 06 TYPOGRAPHY · 当前会话字号倍率（1=原始设计字） */
  const [fontSizeDraft, setFontSizeDraft] = useState(14);
  /** 自定义字体作用范围（"story"=仅剧情正文 / "all"=全部文字） */
  const [fontScopeDraft, setFontScopeDraft] = useState<"story" | "all">("story");
  /** 子弹窗打开时缓存的 API 列表（避免每次渲染都读 localStorage） */
  const [apiConfigList, setApiConfigList] = useState<ApiConfig[]>([]);
  /** 轻提示：用于「功能尚未接入」等一次性反馈；非空时 1.8s 后自动消失 */
  const [toast, setToast] = useState<string | null>(null);

  // ── 模型切换（两级：先选 API，再选该 API 下的具体模型） ──
  /** 展开模型二级列表的 API 配置 id（null=停在 API 列表） */
  const [modelPickerApiId, setModelPickerApiId] = useState<string | null>(null);
  /** 一级列表里「工具调用（硅基流动）」折叠组是否展开 */
  const [showHiddenApis, setShowHiddenApis] = useState(false);
  /** 该 API 下的模型名列表 */
  const [modelNameList, setModelNameList] = useState<string[]>([]);
  /** 是否正在拉取模型列表 */
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  /** 拉取模型列表的错误 */
  const [modelListError, setModelListError] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 1800);
    return () => clearTimeout(timer);
  }, [toast]);
  /** 当前解析到的模型名（来自全局设置的 API 配置），用于 MODEL 行 */
  const [lastModel, setLastModel] = useState<string>("");
  /** 最近一次 API 错误，展示在剧情区顶部 */
  const [apiError, setApiError] = useState<string | null>(null);

  // ── 剧本名编辑 ──
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  // ── 消息操作条：多 roll 翻页 ──
  /** turnId → 该幕的多个候选版本（index 0 为原始生成） */
  const [rollsMap, setRollsMap] = useState<Record<string, string[]>>({});
  /** turnId → 当前显示的版本下标 */
  const [rollIndexMap, setRollIndexMap] = useState<Record<string, number>>({});
  /** 正在重 roll 的幕 id */
  const [rerollingTurnId, setRerollingTurnId] = useState<string | null>(null);
  /** 正在编辑的幕 id 与草稿 */
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null);
  const [editingTurnDraft, setEditingTurnDraft] = useState("");

  // ── 对白语音朗读 ──
  /** 正在播放/加载的帧定位键（`${turnId}:${frameIndex}`） */
  const [playingVoiceKey, setPlayingVoiceKey] = useState<string | null>(null);
  /** 播放链路：请求序号 + 当前播放句柄，用于打断上一句 */
  const voiceRequestIdRef = useRef(0);
  const voicePlaybackRef = useRef<{ promise: Promise<void>; abort: () => void } | null>(null);
  /** 语音 blob 缓存：同一句反复点不重复请求 */
  const ensembleVoiceCacheRef = useRef<Map<string, Blob>>(new Map());

  /** 统一删除确认弹窗：解决原「一点就删、无法挽回」的危险操作 */
  const [confirmState, setConfirmState] = useState<{
    title: string;
    message: string;
    confirmLabel?: string;
    onConfirm: () => void;
  } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  /**
   * 世界书 sticky 驻留台账（2026-10-09）。
   * key = 世界书条目 uid，value = 剩余驻留轮数。命中 key 时刷新为 entry.sticky，
   * 之后每轮递减；>0 时该条目仍会被注入（防漏）。跨轮复用，故用 ref 而非 state。
   * ⚠️ 切换剧本时不清账也无妨（uid 冲突概率极低，且最多多注入一两轮）。
   */
  const worldBookStickyRef = useRef<StickyLedger>(new Map());
  /** 输入框（textarea）：随内容自动增高，行数到上限后在框内滚动 */
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  /**
   * 回车发送开关（2026-10-11 接入聊天 App 的同一项设置）。
   * 关闭时 Enter 只换行、靠发送按钮提交 —— 手机上**必须**能关：
   * 输入法的「发送」键就是 Enter，用户没有 Shift 可逃，否则打不了多行。
   */
  const [enterToSendEnabled, setEnterToSendEnabled] = useState(
    () => loadChatAppSettings().enterToSendEnabled === true
  );
  useEffect(() => {
    const syncEnterToSend = () => {
      setEnterToSendEnabled(loadChatAppSettings().enterToSendEnabled === true);
    };
    // 与聊天 App 共用同一个设置项：那边改了，这边立刻跟上。
    syncEnterToSend();
    window.addEventListener(CHAT_APP_SETTINGS_UPDATED_EVENT, syncEnterToSend);
    return () => window.removeEventListener(CHAT_APP_SETTINGS_UPDATED_EVENT, syncEnterToSend);
  }, []);
  // 发送后输入被清空 → 高度收回一行（否则会停在多行高度，看着像没清干净）
  useEffect(() => {
    if (!inputText) autoGrowTextarea(composerRef.current);
  }, [inputText]);

  // ── 面具（用户身份）状态 ──────────────────────────────
  const [identities, setIdentities] = useState<UserIdentity[]>([]);
  const [activePersonaId, setActivePersonaId] = useState<string | null>(null);

  // ── 初始化加载（2026-10-11 修：必须等两套存储都水合）──
  //
  // ⚠️ 旧实现直接 setScripts(loadEnsembleScripts())，是「世界书退出重进必须
  //   重选一遍才生效」的根因。这里其实有**两套互相独立的存储**，各自异步水合：
  //
  //   ① 剧本本体  → kvDb   （kvGet/kvSet，靠 hydrateKvDb() 灌内存缓存）
  //   ② 世界书    → settingsDb（readWorldBooksCache()，靠 ensureSettingsStorageHydrated()）
  //
  //   组件挂载时这两次水合通常都还没跑完，于是：
  //     · loadEnsembleScripts() → kvGet 全 null → 读到 [] → worldBookIds 丢失
  //     · loadWorldBooks()      → _worldBooks ?? [] → 读到 [] → 即便 id 还在也匹配不到书
  //   表现就是「生成时世界书块是空的、触发日志没命中」，用户手动再选一遍
  //   （触发一次带完整 currentScript 的写入）才偶然把状态救回来。
  //
  //   修法与 WorldBuilder / custom-app-runner 等既有页面一致：两个都 await 完再读。
  useEffect(() => {
    let cancelled = false;
    Promise.all([hydrateKvDb(), ensureSettingsStorageHydrated()])
      .catch(() => undefined)
      .then(() => {
        if (cancelled) return;
        setScripts(loadEnsembleScripts());
        const list = loadUserIdentities();
        setIdentities(list);
        // 默认激活第一个面具（与全局默认绑定一致）
        setActivePersonaId(list[0]?.id ?? null);
      });
    return () => { cancelled = true; };
  }, []);

  const activePersona =
    identities.find((i) => i.id === activePersonaId) ?? identities[0] ?? null;

  // 当前面具下的角色：角色绑定的面具 === 当前激活面具
  const activeId = activePersona?.id;
  const castableCharacters = activeId
    ? characters.filter((ch) => resolveUserIdentity(ch.id)?.id === activeId)
    : characters;

  // 当前面具下的剧本：剧本 personaId === 当前激活面具
  const visibleScripts = activeId
    ? scripts.filter((s) => !s.personaId || s.personaId === activeId)
    : scripts;

  // ── 对白语音朗读：点播放键 → 解析该角色语音配置 → 合成 → 播放 ──
  const playEnsembleVoice = useCallback(
    async (key: string, text: string, speaker?: string) => {
      // 再次点击同一句 → 打断停止
      if (playingVoiceKey === key) {
        try {
          voicePlaybackRef.current?.abort();
        } catch { /* ignore */ }
        voicePlaybackRef.current = null;
        setPlayingVoiceKey(null);
        return;
      }
      // 打断上一句
      try {
        voicePlaybackRef.current?.abort();
      } catch { /* ignore */ }
      voicePlaybackRef.current = null;

      const clean = pickVoiceText(text);
      if (!clean) return;

      // 角色 → 语音绑定：仅按 cast 成员精确匹配（不再回退面具，避免非 cast 角色误播）
      const castMember = currentScript?.cast?.find((c) => c.name === speaker);
      if (!castMember) return;
      const characterId = castMember.id;
      const voiceConfig = resolveVoiceConfig(characterId, "ensemble");
      if (!voiceConfig) {
        setToast("该角色还没绑定语音，去「设置 → 语音」里配一下");
        window.setTimeout(() => setToast(null), 2600);
        return;
      }

      const reqId = ++voiceRequestIdRef.current;
      setPlayingVoiceKey(key);
      try {
        unlockAudioPlayback();
        let blob = ensembleVoiceCacheRef.current.get(key);
        if (!blob) {
          blob = await synthesizeSpeech(clean, voiceConfig) ?? undefined;
          if (blob) ensembleVoiceCacheRef.current.set(key, blob);
        }
        if (!blob) throw new Error("语音合成为空");
        if (reqId !== voiceRequestIdRef.current) return; // 已被新请求打断
        const handle = playAudioBlobViaMediaElement(blob);
        voicePlaybackRef.current = handle;
        await handle.promise;
      } catch (err) {
        if (reqId === voiceRequestIdRef.current) {
          console.error("[ensemble voice] 播放失败", err);
          setToast("语音播放失败");
          window.setTimeout(() => setToast(null), 2600);
        }
      } finally {
        if (reqId === voiceRequestIdRef.current) {
          setPlayingVoiceKey(null);
          voicePlaybackRef.current = null;
        }
      }
    },
    [playingVoiceKey, currentScript, activePersona, setToast]
  );

  // 卸载时打断正在播放的语音
  useEffect(() => {
    return () => {
      try {
        voicePlaybackRef.current?.abort();
      } catch { /* ignore */ }
    };
  }, []);

  // ── 06 TYPOGRAPHY · 字体操作 ──
  /** 上传字体文件：转 base64 → 存 KV（本剧本）→ 记来源=upload。
      真正的注册在下面的 fontSource effect 里完成（依赖 script 状态更新）。 */
  const handleEnsembleFontUpload = useCallback(
    async (file: File) => {
      if (!currentScript) return;
      try {
        if (file.size > 12 * 1024 * 1024) {
          setToast("字体文件过大（>12MB）");
          window.setTimeout(() => setToast(null), 2600);
          return;
        }
        const dataUrl: string = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ""));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        if (!dataUrl) throw new Error("读取为空");
        saveEnsembleFontData(currentScript.id, dataUrl);
        setFontUploadName(file.name);
        setFontSourceDraft("upload");
        // 立即落库到剧本，使 effect 生效
        const updated: EnsembleScript = {
          ...currentScript,
          fontSource: "upload",
          fontUrl: undefined,
          fontFamily: ENSEMBLE_CUSTOM_FONT_FAMILY,
          updatedAt: new Date().toISOString(),
        };
        setCurrentScript(updated);
        saveOrUpdateEnsembleScript(updated);
        setToast("字体已应用");
        window.setTimeout(() => setToast(null), 1800);
      } catch (err) {
        console.warn("[ensemble] 字体上传失败", err);
        setToast("字体上传失败");
        window.setTimeout(() => setToast(null), 2600);
      }
    },
    [currentScript, setToast]
  );

  /** 使用链接字体：记来源=url（注册在 effect 里注入 @font-face）。 */
  const handleEnsembleFontUseUrl = useCallback(
    (url: string) => {
      if (!currentScript || !url) return;
      setFontSourceDraft("url");
      setFontUrlDraft(url);
      setFontUploadName("");
      const updated: EnsembleScript = {
        ...currentScript,
        fontSource: "url",
        fontUrl: url,
        fontFamily: ENSEMBLE_CUSTOM_FONT_FAMILY,
        updatedAt: new Date().toISOString(),
      };
      setCurrentScript(updated);
      saveOrUpdateEnsembleScript(updated);
      setToast("字体已应用");
      window.setTimeout(() => setToast(null), 1800);
    },
    [currentScript, setToast]
  );

  /** 清除自定义字体：删 KV 数据 + 清 source/url。 */
  const handleEnsembleFontClear = useCallback(() => {
    if (!currentScript) return;
    saveEnsembleFontData(currentScript.id, null);
    setFontSourceDraft(undefined);
    setFontUrlDraft("");
    setFontUploadName("");
    const updated: EnsembleScript = {
      ...currentScript,
      fontSource: undefined,
      fontUrl: undefined,
      fontFamily: undefined,
      updatedAt: new Date().toISOString(),
    };
    setCurrentScript(updated);
    saveOrUpdateEnsembleScript(updated);
  }, [currentScript]);

  // ── 06 TYPOGRAPHY · 自定义字体的运行时注册 ──
  // 剧本选定的字体在「进入/切换剧本」时注入 document.head（原生 <style>），
  // **不用 styled-jsx** —— 因为 .frame-body 等是普通 class，不带 jsx-hash，
  // styled-jsx 的 scoped 选择器根本不匹配（这就是此前「两种方式都不生效」的根因）。
  //   · upload：字体数据从 KV 取 base64，用 FontFace API 注册进 document.fonts
  //   · url   ：@font-face 的 src 指向远程链接
  // 两者都会**同时**注入一条「应用规则」，把正文/对白/旁白/角色名的
  // font-family 指向注册名（带 !important，压过根节点 font-sans 的继承）。
  useEffect(() => {
    const STYLE_ID = "ensemble-custom-font";
    const family = ENSEMBLE_CUSTOM_FONT_FAMILY;
    const getStyleEl = (): HTMLStyleElement => {
      let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
      if (!el) {
        el = document.createElement("style");
        el.id = STYLE_ID;
        document.head.appendChild(el);
      }
      return el;
    };

    const src = currentScript?.fontSource;

    // 未设置字体 → 清掉注入的样式与已注册的 FontFace（恢复默认字体栈）
    if (!currentScript || !src) {
      const el = document.getElementById(STYLE_ID);
      if (el) el.textContent = "";
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        // 1) 字体数据 / @font-face
        let faceCss = "";
        if (src === "upload") {
          const dataUrl = loadEnsembleFontData(currentScript.id);
          if (!dataUrl) {
            console.warn("[ensemble] 上传字体数据缺失（KV 无记录）");
            return;
          }
          const ff = new FontFace(family, `url(${dataUrl})`);
          await ff.load();
          if (cancelled) return;
          document.fonts.add(ff);
        } else if (src === "url" && currentScript.fontUrl) {
          faceCss = `@font-face{font-family:"${family}";src:url("${currentScript.fontUrl}");font-display:swap;}`;
        } else {
          return;
        }

        // 2) 应用规则：两档。
        //    · all   ：.ensemble-scope 内所有元素 → 剧本字体
        //    · story ：**先全改，再把 UI 区域还原**（两规则，后写覆盖）。
        //      ⚠️ 还原目标必须是**全局基础字体 `var(--app-font-family)`**
        //      （用户设为霞鹜文楷），**不能写死系统 sans** —— 否则会把全局
        //      文楷冲掉，导致设置页/功能页/标题栏/DATE 行退回原始字体。
        const scopeAll = currentScript.fontScope === "all";
        const applyCss = scopeAll
          ? `.ensemble-scope, .ensemble-scope *{font-family:"${family}" !important;}`
          : `.ensemble-scope, .ensemble-scope *{font-family:"${family}" !important;}` +
            `.ensemble-scope [data-ens-ui], .ensemble-scope [data-ens-ui] *{font-family:var(--app-font-family) !important;}`;

        getStyleEl().textContent = faceCss + applyCss;

        // 3) 触发加载并给反馈。
        //    ⚠️ 不要用 `load() 返回空` 判失败 —— 远程字体的加载有网络延迟，
        //    首次可能返回空（随后才就绪），此前就因此误报「链接不对」。
        //    改为：await load 后**只在成功时提示**；拿不到就静默等待，
        //    用 setTimeout + fonts.check 复查一次，仍失败才提示。
        try {
          await document.fonts.load(`14px "${family}"`);
          const ok = document.fonts.check(`14px "${family}"`);
          if (ok) {
            setToast("字体已生效");
            window.setTimeout(() => setToast(null), 1800);
          } else {
            // 等一拍再复查（远程字体常见）
            window.setTimeout(() => {
              if (document.fonts.check(`14px "${family}"`)) {
                setToast("字体已生效");
                window.setTimeout(() => setToast(null), 1800);
              } else {
                setToast("字体加载超时：请确认链接可跨域 / 文件为字体格式");
                window.setTimeout(() => setToast(null), 4000);
              }
            }, 1500);
          }
        } catch (e) {
          setToast("字体加载失败：链接不可访问或非字体文件");
          window.setTimeout(() => setToast(null), 4000);
          console.warn("[ensemble] 字体 load 失败", e);
        }
      } catch (err) {
        console.warn("[ensemble] 自定义字体加载失败", err);
        setToast("字体加载失败");
        window.setTimeout(() => setToast(null), 4000);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentScript?.id, currentScript?.fontSource, currentScript?.fontUrl, currentScript?.fontScope, currentScript]);


  useEffect(() => {
    if (currentScript) {
      // 载入剧本时先解析一次模型名，保证 MODEL 行即使未生成也有值
      setLastModel(ensembleModelLabel(currentScript.cast[0]?.id));
      // ── C1 修复（2026-10-10）──
      //   一进工作页就把「归档印记 / 统计」算好，不必等生成剧情或进归档面板。
      //   此前只在 generateTurn 里算，导致刚打开剧本看不到 ✓WRAPPED。
      setArchiveWrappedIds(
        computeWrappedTurnIds(
          currentScript.turns as unknown as Parameters<
            typeof computeWrappedTurnIds
          >[0],
          currentScript.archives
        )
      );
      setArchiveStats(
        computeArchiveStats(
          currentScript.turns as unknown as Parameters<
            typeof computeArchiveStats
          >[0],
          currentScript.archives
        )
      );
      // 切剧本时重置历史分页
      setEarlierBatches(1);
      setDeliveredTurnIds(getDeliveredTurnIds(currentScript.id));
    }
  }, [currentScript?.id]);

  // 从聊天室返回后要立刻看到「已录入聊天记录」标记：
  // 每次回到前台 / 窗口聚焦都重新读一次，避免必须重开剧本才刷新。
  useEffect(() => {
    if (view !== "workspace" || !currentScript) return;
    const refresh = () => setDeliveredTurnIds(getDeliveredTurnIds(currentScript.id));
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [view, currentScript?.id]);

  useEffect(() => {
    if (view === "workspace" && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [currentScript?.turns.length, isGenerating, view]);

  /**
   * 打开 Settings 全页（图1 · 1006）。
   * 顶栏右上角入口 → 先把当前剧本的值灌进草稿，再展示全页。
   */
  const openSettingsPage = () => {
    const s = currentScript;
    if (!s) return;
    // 1006 反馈④：原「场景设定」子弹窗已删除，内容并入开场白。
    // 老剧本只有 background 没 openingMessage → 做一次性迁移，内容不丢。
    setOpeningDraft(s.openingMessage?.trim() ? s.openingMessage : (s.background ?? ""));
    const chars = s.charsPerTurn ?? 600;
    setCharsDraft(chars);
    setCharsInput(String(chars));
    setContextDraft(s.contextLimit ?? 40);
    setPovDraft(s.narrativePov ?? "third");
    setOnlineSyncDraft(s.onlineSync ?? false);
    setFontSourceDraft(s.fontSource);
    setFontUrlDraft(s.fontUrl ?? "");
    setFontUploadName("");
    setFontSizeDraft(s.fontSize ?? 14);
    setShowToolsSheet(false);
    setShowSettingsSheet(true);
  };

  /**
   * 统一返回逻辑：逐层退回，最外层关闭 App。
   * 事件隔离：防止宿主容器的手势/点击监听吞掉本次点击。
   */
  const handleBack = (e?: React.SyntheticEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (view === "workspace") {
      setView("scripts");
    } else if (view === "create") {
      setView("scripts");
    } else if (view === "scripts") {
      if (activePersonaId) {
        setView("personas");
      } else if (typeof onClose === "function") {
        onClose();
      }
    } else if (typeof onClose === "function") {
      onClose();
    }
  };

  // 新建剧本
  const handleCreateScript = (e?: React.SyntheticEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (!titleInput.trim()) return;
    const chosenChars = characters.filter((c) => selectedCastIds.includes(c.id));
    const newScript: EnsembleScript = {
      id: "ens_" + Date.now(),
      title: titleInput.trim(),
      personaId: activePersona?.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      cast: chosenChars.map((c) => ({
        id: c.id,
        name: c.name,
        avatar: c.avatar,
        persona: c.persona || "",
      })),
      turns: [],
    };
    saveOrUpdateEnsembleScript(newScript);
    setScripts(loadEnsembleScripts());
    setCurrentScript(newScript);
    setTitleInput("");
    setSelectedCastIds([]);
    setView("workspace");
  };

  /** 重命名当前剧本（顶栏标题点击进入编辑） */
  const commitTitleRename = () => {
    if (!currentScript) return;
    const next = titleDraft.trim();
    setEditingTitle(false);
    if (!next || next === currentScript.title) return;
    const updated = { ...currentScript, title: next };
    setCurrentScript(updated);
    saveOrUpdateEnsembleScript(updated);
    setScripts(loadEnsembleScripts());
  };

  /**
   * 触发 AI 生成下一个轮次。
   * @param script     目标剧本
   * @param opts.forceActorId  指定扮演的角色（重 roll 用；缺省则随机挑一个非上轮角色）
   * @param opts.rerollTurnId  重 roll 的目标幕；给出时只返回内容，不落库
   */
  const triggerAiTurn = async (
    script: EnsembleScript,
    opts?: { forceActorId?: string; rerollTurnId?: string }
  ): Promise<string | null> => {
    if (isGenerating || script.cast.length === 0) return null;
    setIsGenerating(true);
    setIsComposing(true);
    if (!opts?.rerollTurnId) setApiError(null);
    try {
      const lastTurn = script.turns[script.turns.length - 1];
      // 只用于「取哪个 API 配置」的绑定锚点：整个剧本走同一套 API，
      // 谁的 id 都行，优先用钦定角色（重 roll），否则用第一个角色。
      const bindActorId = opts?.forceActorId || script.cast[0]?.id;

      // ── 本轮演员表（群像核心）──
      // 关键设计：**由模型按剧情需要决定谁出场、各写多长**，不是由 App 预先钦点。
      // 早先两版都错了：
      //   ① 一版固定「一次只出一个人」→ 群像名存实亡；
      //   ② 一版固定「一轮排 N 个人、每人 X 字」→ 变成配额制，人手一个坑，
      //      剧情被人数和字数绑架，短剧本还会把戏份从别的角色身上匀走。
      // 正确的做法是像写小说：这一轮该谁上场、写多长，由故事本身决定。
      // 所以这里只做「候选范围」的约束（谁在场上、谁禁止出现），
      // 具体点名交给模型，见下方提示词的「选角」段落。
      // forceActorId（重 roll 指定某角色）优先级最高：那就是钦定必须由 TA 开场。
      const forced =
        opts?.forceActorId
          ? script.cast.find((c) => c.id === opts.forceActorId)
          : undefined;

      // 钦定角色（仅重 roll 需要）——整轮回复不再由 App 预设演员表。
      const actorQueue: EnsembleCastMember[] = forced ? [forced] : [];
      const castDesc = script.cast
        .map((c) => `- ${c.name}: ${c.persona || "暂无特别设定"}`)
        .join("\n");

      const userDesc = activePersona
        ? `\n【用户身份设定（你需要在适当时回应 TA）】\n${activePersona.name}：${activePersona.bio || ""}${
            activePersona.customSettings ? ` ${activePersona.customSettings}` : ""
          }`
        : "";
      // 场景设定：有内容就整段作为背景依据注入，没有就不注入。
      //      这只是「导演给的世界观/氛围/隐藏剧情」，不是要求模型把内容抄进正文。
      const sceneBlock = script.background?.trim()
        ? `
【剧本全局场景设定（写作时的背景依据，不是正文内容）】
${script.background.trim()}
`
        : "";

      // 每轮输出长度：剧本级可调（「功能 → 剧本设置」）。
      // charsPerTurn 是给模型看的「整轮总字数目标」；maxTokensPerTurn 是硬护栏。
      //
      // ⚠️ token 护栏的三大坑（此前截断的根因全在这里）：
      //   ① 护栏太紧：整轮目标 chars 直接 ×1.6 换算，没给「多个角色分段」
      //      带来的重复格式开销留量；
      //   ② 最致命的是【thinking 模型】：像 gemini-3.8-flash-high 这类带
      //      思维链的模型，CoT 也计入 maxOutputTokens。护栏按正文换算时，
      //      思考一长就把正文的预算吃光，模型只能草草收笔 ——
      //      这正是截图里 TOKENS=236、以「——」收尾的成因。
      //   ③ 所以这里给 3 倍余量：宁可护栏宽到用不完（模型自己会停），
      //      也绝不让护栏比正文先到。
      const charsPerTurn = Math.max(60, script.charsPerTurn ?? 800);
      const totalChars = charsPerTurn;
      const effectiveMaxTokens =
        script.maxTokensPerTurn ?? charsToMaxTokens(totalChars);
      // 用户公式 M = N + 150（1010 收紧）：本轮实际允许的字数上限
      const maxChars = targetCharsToMaxChars(charsPerTurn);

      // 上一轮的主说话人：默认只在「被别人搭话」时出现，避免同一人连着霸场。
      const lastSpeakerNote = lastTurn
        ? `\n【上一幕的说话人】${lastTurn.senderName}。除非剧情里有人明确对他开口、他必须回应，否则这一幕请让**别的角色**主导，不要又从头到尾都是他。`
        : "";

      // ── 输出长度控制规则（2026-10-11 重写 · 只留一套口径）──
      //
      // ⚠️ 旧版这里和下面「篇幅」段互相打架，是「模型总是写超」的元凶：
      //   · 这里写「请**尽量写够**，不要草草结束」
      //   · 下面写「参考量级，**不是硬指标**，不要因为怕超字数提前收笔」
      //   两句话一个催长、一个说没上限，模型（尤其写小说的）自然往长里写。
      //   再叠加「硬性 token 上限对应 M 字」这种抽象换算，模型算不清，
      //   干脆无视 —— 护栏于是只剩 max_tokens 一道，而那道又被静默放宽（见 api-helpers）。
      //
      //   新口径（用户 §十二之二 定稿的「区间 + 明确上界」写法）：
      //     给**区间**、给**明确上界数字**、给**到位判据**，不给「尽量写够」这种催长词。
      const outputLenRule = `
【输出长度控制规则 · 必须遵守】
你要写的这一幕，正文（所有角色块 + 旁白合计）应落在 ${charsPerTurn}~${maxChars} 字之间。
1. 到 ${maxChars} 字**必须收尾**，宁短勿长。这是上界，不是建议值。
2. 也不要在 ${charsPerTurn} 字之前草草结束——该有的冲突、反应、转折写到位再收。
3. 写完后自己数一下：不足 ${charsPerTurn} 就补一处细节，超过 ${maxChars} 就砍掉枝节。
4. 严禁为了凑字数啰嗦、重复、灌水。
（提示：如果发现已经写超，请立刻收尾；系统会按这个上界截断，超出的部分会丢失。）`;

      // ── 04 NARRATIVE · 叙事人称（图1）──
      // 1006 第四次反馈 W2/W3（第二版 · 用户实机复验后返工）：
      //   第一版把「旁白禁用他/她」执行成了「凡是人物都写全称」，结果模型把
      //   **本该归到角色头上的动作/心理也塞进旁白块并写全名** → 旁白被污染。
      //   用户原话：「旁白只会说场景，不会说 chars 的内容，都好好归到 chars
      //   自己的内容里」。
      //
      //   第二版正解（本次）：
      //     ① **收紧旁白的内容边界**——旁白只写环境/场景/氛围/时间流逝，
      //        **不得出现任何角色名、角色动作或心理**；人物内容一律归角色自己的
      //        ［叙述］/［动作］/［心理］块。
      //     ② **角色帧内允许代词**——归属行已锚定是谁（渲染时带该角色的头像+名字），
      //        所以角色自己的块里写「他/她」不会歧义，反而是自然的中文。
      //     ③ 用户称呼仍严格按 narrativePov。
      const userName = activePersona?.name || "用户";
      const userPovRule =
        script.narrativePov === "second"
          ? `涉及用户本人时，**必须以「你」指代**（不要写「${userName}」，也不要写「他/她」指代用户）。
     例：✅「你推开门，冷风扑在脸上。」 ❌「${userName}推开门」 ❌「她推开门」（她=用户时）`
          : script.narrativePov === "first"
          ? `涉及用户本人时，**以「我」书写**（对白照常写角色台词，不改）。`
          : `涉及用户本人时，**写全称「${userName}」**，不用「你」，也不用「他/她」代指用户。`;

      const povBlock = `
═══════════ 叙事人称 · 强制规则（与格式铁律同级，违反必须重写）═══════════
当前设定：${
        script.narrativePov === "first"
          ? "第一人称沉浸"
          : script.narrativePov === "second"
          ? "第二人称代入"
          : "第三人称旁观"
      }

【人称铁律 1 · 用户怎么称呼】
${userPovRule}

【人称铁律 2 · 旁白只管「景」，不管「人」】（最容易写错，务必遵守）
［旁白］**只能**写：环境、场景、光线、天气、声音、气味、时间流逝、镜头式的氛围铺陈。
［旁白］里**绝对不允许出现**：
   · 任何角色的**名字**（不许写「金成帝」「皮韩宇」…）
   · 任何角色的**动作**（不许写"他推开门""她坐在窗边"）
   · 任何角色的**心理/情绪**（不许写"他松了口气""她心里一沉"）
   ✅ 正确旁白：「深夜的走廊只剩应急灯，绿光落在墙角。雨声从窗外压进来。」
   ❌ 错误旁白：「金成帝站在门口，他推开门走了进来。」← 这是**人物内容**，不属于旁白

【人称铁律 3 · 人物内容必须归到角色自己的块里】
一个角色的动作 / 神态 / 心理，**必须写在以该角色为归属的** ［叙述］/［动作］/［心理］ 块里，
不能塞进旁白。写法：先写归属行「角色名：」，再写 ［叙述］/［动作］ 块。
   金成帝：
   ［动作］:
   他推开门走进来，肩膀被雨打湿了一片。
   ［心理］:
   这雨下得没个完，他有点烦。

【人称铁律 4 · 角色自己的块里可以用「他/她」】
因为在 ［叙述］/［动作］/［心理］ 块里，归属行已经说清了是谁（渲染时会带这个
角色的头像和名字），所以**用「他/她」不会产生歧义**，反而更自然。
   ✅「他推开门走进来。」（上文归属行已写「金成帝：」）
   ✅「她站在门槛内，看着金成帝转身。」（同段有第二人时才点名区分，其余用代词）

【人称铁律 5 · 对白不受限】
［对白］是角色嘴里说的话，人称照角色自己的说话习惯写，不受以上约束。`;

      // ── 05 MEMORY LINK · 线上互通（图1 · 2026-10-09 M1 接入真实记忆库）──
      // 此前只是「把开关语义写进提示词」的占位符；现在真正去读记忆库：
      //   · 用户口径：全员并标注归属 / 读同一角色在单聊的记忆 / 共用单聊那套库
      //   · `EnsembleCastMember.id` 即真实 characterId → 逐角色检索，天然实现"读同角色记忆"
      //   · 关闭时只注入「不得引用线下记忆」的约束，不检索（省 token）
      // ── 05 单聊记忆注入（用户口径 2026-10-18）──
      //   · 只有「单人群像」（cast 仅 1 位角色）才真正注入：一个用户面具 + 一个角色，不会抢戏。
      //   · 多人群像一律不注入"角色与用户的私聊"——会把无关私事塞进多人场景，跑题且别人接不住。
      //     多人的连贯性由下方 C-2 交叉记忆负责（角色之间互相记得）。
      //   · 另外仍需「线上互通」开关打开。
      const isSoloScript = script.cast.length === 1;
      const soloInjectionEnabled = !!script.onlineSync && isSoloScript;
      const memoryResult = await buildEnsembleMemoryBlock(
        script.cast.map((c) => ({ id: c.id, name: c.name })),
        script.turns
          .slice(-10)
          .map((t) => t.content)
          .join("\n"),
        { enabled: soloInjectionEnabled }
      );
      let memoryBlock: string;
      if (!script.onlineSync) {
        memoryBlock = "\n【线上互通：关闭】剧情完全架空，不得引用用户与角色线下/单聊的任何记忆。";
      } else if (!isSoloScript) {
        memoryBlock =
          "\n【线上互通：多人场景】本剧本有多位角色，不注入你们各自的单聊记忆。请只依据剧本内已发生的剧情与其他角色的关系（见下方人物关系）来写，不要凭空提起剧本外的私下交谈。";
      } else {
        memoryBlock =
          memoryResult.text ||
          "\n【线上互通：开启】角色可以自然地「想起」用户在单聊里的相关记忆。";
      }

      // ── 05b CROSS MEMORY · 交叉记忆（C-2 · 2026-10-18）──
      // 只带「在场角色彼此之间」的认知，防止多人剧情里关系没有来历（突然变熟/突然敌对）。
      // 与上面全员注入分开放：交叉记忆放最后，权重更低，避免抢主线。
      const crossResult = await buildEnsembleCrossMemoryBlock(
        script.cast.map((c) => ({ id: c.id, name: c.name })),
        script.turns
          .slice(-10)
          .map((t) => t.content)
          .join("\n"),
        { enabled: !!script.onlineSync, maxPerRole: 3 }
      );
      const crossMemoryBlock = crossResult.text;
      // 记忆日志（供「触发日志」面板查看本幕用了谁的记忆）
      setMemoryLog({
        blocks: memoryResult.blocks,
        roleCount: memoryResult.roleCount,
        totalCount: memoryResult.totalCount,
        enabled: !!script.onlineSync,
        turnIndex: script.turns.length,
      });

      // ── 世界书 · 记忆库（2026-10-09 接入 · 纯增量）──
      //   五大引擎均已接入世界书，群像此前缺失，本次补齐。
      //   · constant 常驻条目（世界观 / 当前状态 / 文风规则）→ 永远注入
      //   · 关键词条目 → 命中才注入；带 sticky 的命中后驻留 N 轮（防漏）
      //   匹配原文 = 最近 10 轮正文（与单聊 `history.slice(-10)` 口径一致）；
      //   sticky 台账由组件顶层 ref 持有，跨轮复用。
      const boundBooks = pickBoundBooks(loadWorldBooks(), script.worldBookIds);
      const wbContextText = script.turns
        .slice(-10)
        .map((t) => t.content)
        .join("\n");
      const wbResult = buildEnsembleWorldBookBlock(
        boundBooks,
        wbContextText,
        worldBookStickyRef.current
      );
      const worldBookBlock = wbResult.text;
      // 触发日志（2026-10-09 M2-a）：记录本轮命中/未命中，供调试面板展示
      setWorldBookLog({
        hits: wbResult.hits,
        misses: wbResult.misses,
        scannedCount: wbResult.scannedCount,
        turnIndex: script.turns.length,
        at: Date.now(),
      });

      // ── 杀青归档 · 剧情记忆（2026-10-10 接入）──
      //   对齐 chill「杀青总结」：已杀青的剧情在 AI 眼里**真删**（不占 token、看不到），
      //   AI 只能靠这段归档回忆过往。这就是「归档是唯一真相」——
      //   用户改好归档后，老原文不再被重读，不会与修正后的归档打架。
      const archiveBlock = buildArchiveBlock(script.archives);
      const wrappedIds = computeWrappedTurnIds(
        script.turns as unknown as Parameters<typeof computeWrappedTurnIds>[0],
        script.archives
      );
      setArchiveWrappedIds(wrappedIds);
      setArchiveStats(
        computeArchiveStats(
          script.turns as unknown as Parameters<typeof computeArchiveStats>[0],
          script.archives
        )
      );

      // ── 01 OPENING · 开场白（图1）──
      const openingBlock = script.openingMessage?.trim()
        ? `
【开场白（本剧第一幕的铺垫，你要基于它自然展开第一幕）】
${script.openingMessage.trim()}
`
        : "";

      // ── 时间感知（2026-10-06）：两种模式都注入，改完下一轮即生效 ──
      //     set 时刻读取（而非组件挂载时），保证「设置好下一轮 AI 就会读到」。
      const storyTime = resolveStoryTime(script.timeAwareness);
      const timeBlock = buildTimeAwarenessBlock(storyTime);

      // ── 状态面板（2026-10-06）：把用户字段表拼成输出契约 ──
      const statusFields = script.statusPanel?.enabled
        ? script.statusPanel.fields ?? []
        : [];
      const statusBlock = statusFields.length
        ? buildStatusContractBlock(
            statusFields,
            script.cast.map((c) => c.name)
          )
        : "";

      const systemPrompt = `你是一位擅长群像叙事的小说作者，正在续写互动剧本《${script.title}》。

🚨 输出格式铁律（违反则整幕作废，必须重写）：
   每一幕**必须以「角色名：」独占一行开头**（如「岳霖玉：」），用来声明归属；
   然后再用 ［对白］/［叙述］/［动作］/［心理］/［旁白］ 五种暗号块承载内容。
   **绝对禁止**直接裸写小说段落、或把动作/台词混在一段里 —— 那样系统无法排版。

═══════════ 参演阵容（全员名单）═══════════
${castDesc}${userDesc}${povBlock}
${sceneBlock}${openingBlock}${memoryBlock}${crossMemoryBlock}${archiveBlock}${worldBookBlock}${timeBlock}${outputLenRule}
═══════════ 唯一的格式契约：归属行 + 五种暗号块 ═══════════
排版完全由「行首标记」驱动。规则只有两条：

【第一条 · 归属行】要写某个角色的内容前，先单独占一行写「角色名：」
（中文全角冒号，**这一行除名字和冒号外什么都不写**）。它声明「下面紧跟的
所有暗号块，都归这个角色」。同一角色只需写一次，不用每个块都重复写。
    岳霖玉：

【第二条 · 五种暗号块】归属行之后，每个内容块都以暗号开头，独占一行：
    ［对白］:   → 角色**嘴里说出来的话**（台词）
    ［叙述］:   → **叙述性文字**：动作 / 环境 / 神态
    ［动作］:   → 同［叙述］，也用于动作（两者同义、同色）
    ［心理］:   → 角色**内心**的念头、独白、情绪
    ［旁白］:   → **镜头级旁白**：只写环境/场景/氛围/时间流逝
                 （**不写任何角色名、角色动作或心理**，那些归角色自己的块；
                  旁白不属于任何角色，单独写在归属行之外）

⚠️ 正文里**禁止出现任何其它符号**：不要圆括号（）、不要方括号【】、
   不要引号 ""、不要星号 *、《》、~、#。
   **台词一律不加引号、不加括号**，直接写。
   动作 / 叙述一律放进 ［叙述］/［动作］ 块，**不要裸写在角色名后面**。

═══════════ 双语格式（写死，务必遵守）═══════════
本剧本默认采用双语：只要角色说韩语，就必须**先写韩语原句，紧跟一行中文翻译**。
**中文翻译行不加任何括号**，直接另起一行。固定为：
    ［对白］:
    「밥 먹었어?」
    잘 먹었어.

不得只写中文、也不得只写韩语。翻译行紧跟在韩语下面，不要空行。
如果角色说的是中文，就直接写中文台词，同样不加括号。
［对白］块里可以写多行（韩语 + 中文译文 + 后续中文句），**它们都是台词、都加粗显示**。

【正确示范】多角色 + 叙述 + 旁白 + 心理 + 对白 + 双语混排：
    ［旁白］:
    深夜的走廊只剩应急灯，绿光落在墙角。雨声从窗外压进来。
    岳霖玉：
    ［叙述］:
    她站在门槛内，看着转身准备下楼的金成帝，轻声喊住了他。
    ［对白］:
    「날씨 많이 추운데, 조심해서 가.」
    밖은 많이 추워, 조심해서 가.
    ［心理］:
    她用韩语说话时尾音总是下意识放轻，像怕惊扰到别人一样。
    金成帝：
    ［动作］:
    他停在转角的阴影里，手插在黑色夹克口袋里，侧过头看了她一眼。
    ［对白］:
    「어, 너도 얼른 들어가.」
    알겠어, 너도 얼른 들어가.

（注意：［叙述］/［动作］→ 灰；［心理］→ 与叙述同色；［对白］→ 黑色；
［旁白］→ 淡灰斜体；台词与译文都不加括号。）
⚠️ 注意上面示范：**旁白只写了环境**（灯 / 绿光 / 雨声），**没有一个角色名、没有人物动作**；
   而人物动作（"她站在门槛内…""他停在转角…"）都**归在该角色自己的［叙述］/［动作］块里**，
   块内用「她/他」是允许的（归属行已说清是谁）。

【推荐节奏 · 先叙述后开口】
    每个角色开口**之前**，建议先用一个 ［叙述］/［动作］ 块写他当下的动作或
    神态，再写 ［对白］。这样读者先看到「他在做什么」，再听到「他说什么」，
    画面感更强，也更利于系统排版。不要把动作塞进 ［对白］ 块里。

    【节奏许可 · 但绝不能合并】
        上一条只是建议。如果这一轮只想写动作＋一句话，可以**省略**［叙述］块，
        但**台词必须仍然单独放在［对白］块里**。
        ⚠️ 严禁把动作、神态、心理和台词写进同一个块 —— 尤其是严禁写成
           （他停好车，扫了眼屏幕）【心里话】说出口的话 这种混排。
           这个 APP 会把［对白］块原样发到聊天软件里，一旦混排就会被对方看见。

═══════════ 选角：这一幕谁上场，由你按剧情决定 ═══════════
这是群像剧，核心是**多角色在同一幕里真实互动**，不是轮流独白。

1. 你要自己判断：接着上一幕的情境，**这一幕该有哪几个角色在场**。
   可以是一个人独自反应，也可以两三个人交锋 —— 由故事需要决定，不必每轮人数相同。
2. 但只要这一幕出现了两个及以上角色，他们之间**必须有真实交流**：
   后一个角色要承接、回应、打断或反驳前一个角色的言行，产生摩擦、试探、
   沉默或转折。严禁各写各的、互不相干。
3. 除确有必要，同一幕请优先让**不同角色**都有戏份，不要总是同一个人在说话。
${lastSpeakerNote}
4. 未在本幕出场的角色，一个字都不要替他们写（不要预告、不要提及他们的心理）。

═══════════ 篇幅：有上界，写到上界即停 ═══════════
5. 篇幅口径**只有一个**，就是上面【输出长度控制规则】里的 ${charsPerTurn}~${maxChars} 字，
   这里不再重复、也不放宽。**${maxChars} 字是硬上界。**
6. 各角色篇幅**不必平均**：谁在这场戏里是重心，谁就多写；
   只是被带到的角色，几句也可以。让节奏自然，不要人均配额。
   但整幕合计必须落在上述区间内——重心角色多写 ≠ 允许整幕写超。

═══════════ 结尾（此前最容易出错的地方，务必遵守）══════════
7. 你可以让剧情停在悬念上（"话没说完的事" 留给读者想象），
   但**表达本身必须是完整闭合的**：
   - 严禁把句子写到一半就断掉，严禁用「——」「……」「，」作为全篇的最后一个字符；
   - 整段的最后一句必须是语法完整、语义闭合的句子，用句号(。)、问号(？)或叹号(！)收尾。
   - ✅ 正确示范：他伸手去够那个信封，指尖停在半空，终究没有落下去。
   - ❌ 错误示范：他伸手去够那个信封，正要——
   （注意：写"动作进行中"没问题，但要把那个动作写成一句完整的话，而不是切在半途。）

═══════════ 其它硬性要求 ═══════════
8. 严禁输出章节标题、Markdown 标题（#）、序号列表、舞台说明、作者点评或总结。
   严禁跳出角色当作者。
9. 严格贴合每个角色的视角、语气、身份和性格，说话方式要有辨识度。
10. **旁白只写景、不写人**：［旁白］里不得出现任何角色名、角色动作或心理；
   人物内容一律归到该角色自己的 ［叙述］/［动作］/［心理］ 块。
   （角色块内用「他/她」是允许的，归属行已经说清是谁。）
11. 紧扣上一幕推进情节，制造新的张力或情感转折，不要复述已知信息。${statusBlock}`;

      // ── 重 roll 时：剔除被重 roll 的这一幕，只按它之前的上下文重新生成 ──
      // ── 上下文回合（2026-10-10 杀青接入）──
      //   不再固定砍「最近 N 幕」，而是给「杀青点之后的全部剧情」。
      //   已杀青的幕由 computeVisibleTurns 排除（真删）；token 体量由用户手动杀青控制。
      //   2026-10-10 C3：再套一层「未杀青上限」兜底（contextLimit，防不杀青撑爆 token）。
      //   重 roll 时再剔除被重 roll 的那一幕，只按它之前的上下文重新生成。
      const visibleTurnsAll = computeVisibleTurns(
        script.turns as unknown as Parameters<typeof computeVisibleTurns>[0],
        script.archives
      );
      const capLimit = script.contextLimit && script.contextLimit > 0
        ? script.contextLimit
        : visibleTurnsAll.length;
      const visibleTurns = visibleTurnsAll.slice(-capLimit);
      const contextTurns = opts?.rerollTurnId
        ? visibleTurns.filter((t) => t.id !== opts.rerollTurnId)
        : visibleTurns;

      // ── 长度复述（2026-10-11 · 治「指令只管一轮」的核心改动）──
      //
      // 病根：outputLenRule / 格式铁律等全部塞在 systemPrompt 里，而 system 是
      //   整个对话的**第一条**消息。剧情跑到几十上百幕后，上下文长达数万 token，
      //   模型对开头那段指令的服从度断崖下降（lost in the middle）——
      //   表现就是「长度指令只活一轮或几轮，之后完全失效」。
      //
      // 治法：把关键约束**复述到离生成点最近的位置**（最后一条 user 消息之后）。
      //   模型对「紧接着自己要说的话之前」的约束最敏感，这是所有长上下文平台的
      //   通用做法（把硬约束放在末位而非首位）。system 里那份保留不动，
      //   两者形成「首尾夹击」：远处有完整规则，近处有当轮硬数字。
      const lengthEcho = `【本幕篇幅硬约束 · 立即生效】
本幕正文合计必须落在 ${charsPerTurn}~${maxChars} 字；到 ${maxChars} 字必须收尾，宁短勿长。
其它规则（格式契约 / 归属行 / 五种暗号块 / 旁白只写景 / 双语）一律照上面系统要求执行。`;

      const messagesPayload = [
        { role: "system", content: systemPrompt },
        ...contextTurns.map((t) => ({
          role: t.senderType === "user" ? "user" : "assistant",
          // 历史回合按**新契约**回灌，形成格式自强化（模型会跟着学看到的格式）：
          //   · 旁白幕           → `［旁白］:\n正文`
          //   · 角色幕           → `角色名：\n［对白］:\n正文`
          //
          // ⚠️ 必须用**全角方括号** ［］：半角 [ ] 在 JS 模板字符串里会被解析成
          //    数组字面量并求值，方括号会被静默吃掉，模型就再也看不到标记格式。
          //    这正是此前「模型不用方括号、解析器认不出、整幕降级为旁白」的根因。
          content:
            t.senderType === "narration" || t.senderId === "narration"
              ? `［旁白］:\n${t.content}`
              : `${t.senderName}：\n［对白］:\n${t.content}`,
        })),
        // ⚠️ 结尾复述：必须是最后一条消息，且用 user 角色（模型对 user 的
        //   服从度高于 system 尾注；同时也避免部分中转把 system 中途消息丢弃）。
        { role: "user", content: lengthEcho },
      ];

      // ── 走绑定桥：从「设置 → API 配置」取真实配置 ──
      const apiConfig = resolveEnsembleApiConfig(
        bindActorId,
        script.apiConfigIdOverride,
        script.modelOverride
      );
      if (!apiConfig) {
        if (!opts?.rerollTurnId) {
          setApiError("尚未配置 API，请到「设置 → API 配置」添加一个可用模型");
        }
        return null;
      }
      setApiError(null);
      if (!opts?.rerollTurnId) {
        setLastModel(apiConfig.defaultModel || apiConfig.name || "未知模型");
      }

      const result = await simpleLLMCall(apiConfig, messagesPayload, {
        temperature: 0.9,
        max_tokens: effectiveMaxTokens,
        // 严格模式：拒绝 api-helpers 里 8192 的 Anthropic 兜底，
        // 确保发出去的就是上面算出来的护栏值（否则护栏会被静默放宽到 8192）。
        strictMaxTokens: true,
        // 标签用途只是日志里认人，全员名单可能很长，截断到前 3 个即可。
        label: `群像·${script.cast.slice(0, 3).map((c) => c.name).join("/")}${
          script.cast.length > 3 ? "等" : ""
        }`,
      });

      let replyContent = (result.content || "").trim();
      if (!replyContent) {
        if (!opts?.rerollTurnId) {
          setApiError(result.error || "模型返回空内容");
        }
        return null;
      }

      // ── 护栏诊断落表（2026-10-11）──
      //   把「发出去的闸门值 / 实际用量 / 结束原因 / 实际字数」记下来，
      //   在「触发日志」面板里直接渲染，不用开 DevTools。
      //   正文按「去掉标记行后的纯文本」计字，跟用户看到的字数口径一致。
      const plainForCount = replyContent
        .split("\n")
        .filter((line) => {
          const t = line.trim();
          if (!t) return false;
          // 归属行「角色名：」与暗号行「［对白］:」不计入正文字数
          if (/^［(对白|叙述|动作|心理|旁白)］\s*[:：]?$/.test(t)) return false;
          if (/^[^［\s]{1,12}[:：]$/.test(t)) return false;
          return true;
        })
        .join("");
      setGuardrailLog({
        sentMaxTokens: result.sentMaxTokens ?? null,
        completionTokens: result.completionTokens ?? null,
        finishReason: result.finishReason ?? null,
        contentChars: plainForCount.length,
        targetChars: charsPerTurn,
        maxChars,
        turnIndex: script.turns.length,
        at: Date.now(),
      });

      // 2026-10 修复（图3「岳霖玉：整段斜体灰 + 无头像 + 内容重复」根因）：
      //   旧实现在整段最前面无条件削掉「任意已知角色名 + 冒号」，本意是清理
      //   模型偶尔多写的装饰性署名。但它把两类东西混为一谈：
      //     · 伪署名：模型在正文外多补的一层「［岳霖玉］:」装饰 → 该削
      //     · 真署名：整幕的第一个说话人标记「岳霖玉：」→ 绝不能削
      //   结果是：若模型以「岳霖玉：」而非「［旁白］:」开场，首帧的说话人
      //   标记会被整条吃掉 → 解析器把它当无归属散行兜底成 narration（斜体灰、
      //   无头像），且 pendingHead 还会把这段正文再并进下一个角色的帧 → 内容
      //   重复渲染一遍。
      //
      //   修复策略：不再做「裸角色名开头」的削除。解析器 matchSpeakerPrefix
      //   本来就能正确认领行首署名，这个前置削除纯属多余且有害。
      //   只保留唯一一种真正需要清理的情况：模型把「［角色名］:」这类**方括号
      //   装饰**重复写在了段首（解析器会把方括号内容认成角色名，若与实际正文
      //   说话人重复才需处理）—— 但这种情况交给解析器去认即可，不做前置改写。
      //
      //   因此这里只保留「剥掉整段最前面可能存在的多余空行/装饰符」，不动署名。

      // 截断检测（此前的「东西给我，先——」断句）：
      // ① finishReason=length → 请求侧 token 上限先到，内容被硬切；
      // ② 正文以破折号/省略号/逗号收尾 → 模型自己写到一半停了。
      // token 护栏已按整轮字数 ×3 放宽（含 thinking 余量），①基本不会再触发。
      const brokenTail = /[—–\-]{1,2}\s*$|[.．…]{2,}\s*$|[，,]\s*$/.test(replyContent);
      const hitTokenCap = result.wasTruncated === true;

      if (!opts?.rerollTurnId && (hitTokenCap || brokenTail)) {
        setApiError(
          hitTokenCap
            ? "这一轮被 token 上限截断了（模型没写完）。到「功能 → 剧本设置」把每轮字数调大一点再试。"
            : "这一轮的结尾是断句（模型自己没写完整）。重 roll 一次一般就好。"
        );
      }

      // 重 roll 模式：只把新内容交回调用方（原文保持整段，交给调用方按角色分割）
      if (opts?.rerollTurnId) {
        return replyContent;
      }

      // ── 帧模型（第 1 项：单消息流）──
      // 不再把整幕切成「一人一条 turn」，而是「一条 turn = 整幕原文」。
      // 渲染层再调用 parseEnsembleReply 把它切帧，在同一个消息流里连续渲染，
      // 角色名内联显示（不再一人一张卡）。
      //
      // 为什么要保留整段原文：重 roll（整幕重生成）与编辑都以「幕」为单位，
      // 落库时存原文最稳，不会因解析规则调整而丢失模型原始输出。
      const baseTs = Date.now();
      const baseIso = new Date().toISOString();
      // 解析时带 persona：让「岳霖玉：」这类用户 persona 署名能被认领出帧，
      // 从而 leadFrame 拿得到说话人与头像（否则整幕会被误判为旁白）。
      const parseCast = castWithPersona(script.cast, activePersona);
      const parsed = parseEnsembleReply(replyContent, parseCast, parseCast);
      const frames = parsed.frames;
      // ── 格式健康检查（2026-10 第5轮新增）──
      // 若整幕没有解析出**任何对话帧**，说明模型没按契约写（多半是漏写归属行
      // 或暗号，整幕塌成一坨 narration）→ 用户会看到「无头像、无名字、全灰」。
      // 这时给出明确提示，引导重 roll，而不是让用户对着烂排版发懵。
      const hasDialogue = frames.some((f) => f.kind === "dialogue");
      if (!opts?.rerollTurnId && !hasDialogue) {
        setApiError(
          "这一轮模型没按格式输出（缺少 ［对白］ 块或归属行），整幕会没有头像和名字。建议重 roll 一次。"
        );
      }
      // 说话人署名：整幕可能有多人，取帧里首位有归属的说话人作为「幕主导者」，
      // 用于消息流的时间轴归属与头像兜底（纯旁白幕则记为旁白）。
      const leadFrame = frames.find((f) => f.kind === "dialogue");
      const nextTurn: EnsembleTurn = {
        id: `turn_${baseTs}`,
        senderId: leadFrame?.speakerId ?? (leadFrame ? undefined : "narration"),
        senderName: leadFrame?.speaker ?? "旁白",
        senderType: leadFrame ? "character" : "narration",
        content: replyContent,
        rawText: replyContent,
        timestamp: baseIso,
        tokens: replyContent.length,
        model: apiConfig.defaultModel || apiConfig.name || undefined,
        // 状态数据落库（第六暗号剥离产物）：供点头像查看角色卡。
        // 只有启用状态面板且真的解析出条目才存，避免存空数组。
        statusData: parsed.statusData.length
          ? JSON.stringify(parsed.statusData)
          : undefined,
      };

      let updated = appendEnsembleTurn(script.id, nextTurn) ?? script;
      setCurrentScript(updated);
      setScripts(loadEnsembleScripts());

      // 分镜配图：开开关后从下一轮开始生效，异步生成不阻塞剧情
      if (script.storyboardEnabled) {
        void (async () => {
          const outcome = await generateStoryboardImage(script, nextTurn);
          if (!outcome.ok || !outcome.url) return;
          const tagged = updateEnsembleTurn(script.id, nextTurn.id, { storyboardUrl: outcome.url });
          if (tagged) {
            setCurrentScript(tagged);
            setScripts(loadEnsembleScripts());
          }
        })();
      }
      return replyContent;
    } catch (e) {
      console.error("AI turn generation failed:", e);
      return null;
    } finally {
      setIsGenerating(false);
      setIsComposing(false);
    }
  };

  /** 重 roll 某一幕：为该角色再生成一版，追加进 rollsMap 并切到新版本 */
  const handleRerollTurn = async (turn: EnsembleTurn) => {
    if (!currentScript || !turn.senderId || rerollingTurnId) return;
    setRerollingTurnId(turn.id);
    const generated = await triggerAiTurn(currentScript, {
      forceActorId: turn.senderId,
      rerollTurnId: turn.id,
    });
    setRerollingTurnId(null);
    if (!generated) return;

    setRollsMap((prev) => {
      const existing = prev[turn.id] ?? [turn.content];
      const next = [...existing, generated];
      setRollIndexMap((ri) => ({ ...ri, [turn.id]: next.length - 1 }));
      return { ...prev, [turn.id]: next };
    });

    // 立刻把当前展示版本落库，保证退出重进不丢
    const updated = updateEnsembleTurn(currentScript.id, turn.id, {
      content: generated,
      tokens: generated.length,
    });
    if (updated) {
      setCurrentScript(updated);
      setScripts(loadEnsembleScripts());
    }
  };

  /** 切换某一幕显示的 roll 版本 */
  const switchRoll = (turnId: string, dir: -1 | 1) => {
    if (!currentScript) return;
    const versions = rollsMap[turnId];
    if (!versions || versions.length <= 1) return;
    const cur = rollIndexMap[turnId] ?? 0;
    const next = Math.min(Math.max(cur + dir, 0), versions.length - 1);
    if (next === cur) return;
    setRollIndexMap((prev) => ({ ...prev, [turnId]: next }));
    const updated = updateEnsembleTurn(currentScript.id, turnId, {
      content: versions[next],
      tokens: versions[next].length,
    });
    if (updated) {
      setCurrentScript(updated);
      setScripts(loadEnsembleScripts());
    }
  };

  /**
   * 删除某一幕。
   *
   * 语义（按需求 1.1）：**一次只删掉当前显示的那一版 roll**。
   * - 该幕还有其它版本 → 只从 rollsMap 移除当前版本，并自动切到相邻版本，幕本身保留；
   * - 只剩最后这一版 → 才真正把整幕从剧本里删掉。
   */
  const removeOneRoll = (turnId: string) => {
    if (!currentScript) return;
    const versions = rollsMap[turnId];
    const cur = rollIndexMap[turnId] ?? 0;

    // 还有多版本：只砍这一版
    if (versions && versions.length > 1) {
      const nextVersions = versions.filter((_, i) => i !== cur);
      const nextIndex = Math.min(cur, nextVersions.length - 1);
      setRollsMap((prev) => ({ ...prev, [turnId]: nextVersions }));
      setRollIndexMap((prev) => ({ ...prev, [turnId]: nextIndex }));

      const updated = updateEnsembleTurn(currentScript.id, turnId, {
        content: nextVersions[nextIndex],
        tokens: nextVersions[nextIndex].length,
      });
      if (updated) {
        setCurrentScript(updated);
        setScripts(loadEnsembleScripts());
      }
      setToast(
        `已删除 1/1 版，剩余 ${nextVersions.length} 版（${nextIndex + 1}/${
          nextVersions.length
        }）`
      );
      return;
    }

    // 最后一版：真正删幕，并清理 roll 记录
    const updated = deleteEnsembleTurn(currentScript.id, turnId);
    if (updated) {
      setCurrentScript(updated);
      setScripts(loadEnsembleScripts());
    }
    setRollsMap((prev) => {
      const next = { ...prev };
      delete next[turnId];
      return next;
    });
    setRollIndexMap((prev) => {
      const next = { ...prev };
      delete next[turnId];
      return next;
    });
  };

  /** 组装某一幕的删除确认（文案随剩余版本数变化，避免误删整幕） */  const requestDeleteTurn = (turn: EnsembleTurn) => {
    const total = rollsMap[turn.id]?.length ?? 1;
    const cur = (rollIndexMap[turn.id] ?? 0) + 1;
    setConfirmState({
      title: total > 1 ? `删除第 ${cur} 版？` : "删除这一幕？",
      message:
        total > 1
          ? `这一幕共有 ${total} 个版本，只会删掉你正在看的第 ${cur} 版，其余版本保留，自动切到相邻版本。`
          : `${turn.senderName} 的这一幕将被永久删除，无法恢复。`,
      confirmLabel: total > 1 ? "删除这一版" : "删除",
      onConfirm: () => {
        removeOneRoll(turn.id);
        setConfirmState(null);
      },
    });
  };

  /** 关闭所有子弹窗，回到剧本界面（统一返回语义：不再弹回「功能」面板） */
  const closeAllSheets = () => {
    setShowCssSheet(false);
    setShowSettingsSheet(false);
    setShowModelSheet(false);
    setModelPickerApiId(null);
    setModelListError(null);
    setShowToolsSheet(false);
    // 离开 CSS 面板时丢弃未应用的预览草稿（已保存的 customCss 不受影响）
    setCssDraft(currentScript?.customCss || "");
  };

  // ══════════════════════════════════════════════════════
  // 统一的「一层一层退」导航模型
  // 层级：剧本界面(0) → 功能面板(1) → 子弹窗(2) → 模型二级(3)
  // 顶栏/浮层的返回键都只调 handleSheetBack()，由它决定退到哪一层，
  // 于是不会再出现「子面板点了返回反而弹出功能面板」的错乱。
  // ══════════════════════════════════════════════════════
  // 注：anySheetOpen / sheetIsPrimary 两个派生量曾用于返回键文案，
  // 现已由 handleSheetBack() 自行判定层级（1006 清理），故删除。

  /**
   * 退一层：
   * - 模型卡片若处于内联展开 → 先收起该卡片（1007：不再有独立二级弹窗）
   * - 其余子弹窗 → 「功能」面板（用户要求：子面板关闭后停在功能面板，模糊背景常驻）
   * - 「功能」面板 → 剧本界面
   */
  const handleSheetBack = () => {
    if (showModelSheet && modelPickerApiId) {
      setModelPickerApiId(null);
      setModelListError(null);
      return;
    }
    if (showToolsSheet) {
      // 功能面板本身：整层关闭，回到剧本界面
      closeAllSheets();
      return;
    }
    if (
      showCssSheet ||
      showSettingsSheet ||
      showModelSheet
    ) {
      // Settings 全页（图1）是**全屏页**，返回直接回剧本界面，不弹回功能面板。
      if (showSettingsSheet) {
        setShowSettingsSheet(false);
        return;
      }
      // 其余子弹窗：只关掉自己，保持在功能面板上（背景继续模糊，不重新弹出）
      setShowModelSheet(false);
      setModelPickerApiId(null);
      setModelListError(null);
      setCssDraft(currentScript?.customCss || "");
      setShowToolsSheet(true);
      return;
    }
  };

  /** 中断当前生成：卸载掉正在运行的生成循环（apiError 会带出 AbortError） */
  const cancelGenerating = () => {
    setIsComposing(false);
    setApiError(null);
    setToast("已取消本轮生成");
  };

  /** ─── 杀青归档（2026-10-10）───────────────────────────────
   *  对齐 chill「杀青总结」：手动触发 → 调当前群像模型总结最近未归档的前 N 条
   *  → 追加一条归档 → 该范围在 AI 眼里真删（靠 computeVisibleTurns 排除）。
   *  可编辑、可「换个模型重来」（撤销上一次）。
   */

  /** 打开面板时刷新统计与档案草稿。 */
  const refreshArchivePanel = () => {
    const s = currentScript;
    if (!s) return;
    refreshArchivePanelFor(s);
  };

  /**
   * 用「指定剧本快照」刷新面板（不读 state）。
   *
   * ⚠️ B1 修复（2026-10-10）：杀青后必须传**新建的 updated**，
   *    而不是刚 `setCurrentScript` 的旧 state —— React 的 state 更新是异步的，
   *    立刻读 currentScript 拿到的是旧值，导致「档案要重进面板才出现」。
   */
  const refreshArchivePanelFor = (s: EnsembleScript) => {
    setArchiveStats(
      computeArchiveStats(
        s.turns as unknown as Parameters<typeof computeArchiveStats>[0],
        s.archives
      )
    );
    setArchiveWrappedIds(
      computeWrappedTurnIds(
        s.turns as unknown as Parameters<typeof computeWrappedTurnIds>[0],
        s.archives
      )
    );
    const merged = (s.archives ?? [])
      .map((a) => a.content.trim())
      .filter(Boolean)
      .join("\n\n");
    setArchiveContentDraft(merged);
    setArchiveError(null);
  };

  /**
   * 提炼并杀青：总结最近未归档的前 N 条，追加为一条归档。
   * withChat / skipChat 由「杀青前确认是否注入聊天记录」弹窗透传。
   */
  const handleWrap = async (count: number, withChat?: boolean, skipChat?: boolean) => {
    const s = currentScript;
    if (!s || archiveBusy) return;
    const n = Math.max(1, Math.floor(count) || 1);
    const pendingAll = computePendingTurns(
      s.turns as unknown as Parameters<typeof computePendingTurns>[0],
      s.archives
    );
    if (pendingAll.length === 0) {
      setArchiveError("没有新的未归档剧情可杀青。");
      return;
    }
    const target = pendingAll.slice(0, n);
    // 杀青前先问一句：还没归入的聊天要不要一起注入
    const openSessions = getPendingSessions(s.id);
    if (withChat == null && skipChat == null && openSessions.length > 0) {
      setWrapConfirm({ count: n });
      return;
    }
    const injectChat = withChat === true;
    const skippedChat = skipChat === true;
    setArchiveBusy(true);
    setArchiveError(null);
    try {
      const apiConfig = resolveEnsembleApiConfig(
        s.cast[0]?.id,
        s.apiConfigIdOverride,
        s.modelOverride
      );
      if (!apiConfig) throw new Error("未找到可用的 API 配置，请先在设置里绑定模型。");

      const lastTurn = target[target.length - 1];
      // 头部标签用**剧情时间**（用户 2026-10-10 拍板）：跑架空剧情时，
      // 若用现实时间会与正文里的【时间戳】对不上。
      const storyTime = resolveStoryTime(s.timeAwareness);
      const rangeLabel = makeStoryRangeLabel(
        storyTime?.date ?? (lastTurn?.createdAt ? new Date(lastTurn.createdAt) : null)
      );
      const prevArchive = (s.archives ?? [])
        .slice(-1)
        .map((a) => a.content)
        .join("");
      const prompt = buildArchiveSummaryPrompt(
        target as unknown as Parameters<typeof buildArchiveSummaryPrompt>[0],
        { rangeLabel, previousArchive: prevArchive }
      );

      // 选了「一起注入」：把还没归入的聊天当成剧情的一部分一起交给模型总结，
      // 由模型自然写成剧情，而不是让用户自己去对比拼接。
      let chatInjection = "";
      if (injectChat) {
        const blocks = loadSessionTranscript()
          .map(({ session, messages }) => {
            if (messages.length === 0) return "";
            const lines = messages.map(m => {
              const who = m.role === "user" ? "「我」" : m.senderName || session.characterName;
              return `${who}：${m.content}`;
            });
            return `【${new Date(session.startedAt).toLocaleString("zh-CN")} · 与 ${session.characterName} 的线上聊天】\n${lines.join("\n")}`;
          })
          .filter(Boolean);
        if (blocks.length > 0) {
          chatInjection =
            `\n\n====================\n【线上聊天记录 · 必须并入剧情】\n` +
            `以下是同一段时间线里发生在聊天软件上的对话，属于剧情的一部分。` +
            `请把它当作剧情自然的一部分写进档案（用剧情叙述的笔法，不必逐条罗列），` +
            `不要单独列成"聊天记录"清单。\n` +
            blocks.join("\n\n");
        }
      }
      const userPrompt = chatInjection ? `${prompt}${chatInjection}` : prompt;

      const res = await simpleLLMCall(apiConfig, [
        {
          role: "system",
          content:
            "你是一个剧本归档助手。只总结给到的剧情本身，不添加任何设定、指令或未来建议。",
        },
        { role: "user", content: userPrompt },
      ]);
      if (res.error) throw new Error(res.error);
      let content = (res.content ?? "").trim();
      if (!content) throw new Error("模型返回为空，请重试或换个模型。");

      // 没归入的聊天必须在归档末尾留下缺漏标注，否则用户无法判断剧情是否连贯
      const pending = getPendingSessions(s.id);
      if (pending.length > 0) {
        const lines = pending.map(p => {
          const start = new Date(p.startedAt).toLocaleString("zh-CN");
          const end = new Date(p.startedAt + 1000 * 60).toLocaleString("zh-CN");
          const msgCount = loadSessionTranscript(p.id)[0]?.messages.length ?? 0;
          return `- ${start} ~ ${end} 与 ${p.characterName} 的聊天${skipChat ? "（本次未注入）" : ""}：${msgCount} 句，起点「${p.originContent.slice(0, 30)}…」`;
        });
        content +=
          `\n\n【归档缺漏提示】以下时间段的聊天记录未并入本档案，请检查剧情是否连贯：\n` +
          lines.join("\n");
      }

      const entry: EnsembleArchiveEntry = {
        id: `arc_${Date.now().toString(36)}`,
        createdAt: new Date().toISOString(),
        lastTurnId: lastTurn?.id,
        turnCount: target.length,
        content,
        model: s.modelOverride || apiConfig.defaultModel,
      };
      const updated = {
        ...s,
        archives: [...(s.archives ?? []), entry],
      };
      setCurrentScript(updated);
      saveOrUpdateEnsembleScript(updated);
      setScripts(loadEnsembleScripts());
      refreshArchivePanelFor(updated);

      // C-1 桥接：把这次杀青同步进参与角色的记忆库（只进归档层，不污染时间线）。
      // 失败不阻断杀青本身，只提示一下。
      void syncEnsembleArchiveToMemory(updated, entry).then(result => {
        if (result.written > 0) {
          setToast(`已杀青 ${target.length} 幕 · ${result.written} 位角色已记住`);
        } else {
          setToast(`已杀青 ${target.length} 幕`);
        }
      }).catch(() => setToast(`已杀青 ${target.length} 幕`));
    } catch (e) {
      setArchiveError(e instanceof Error ? e.message : String(e));
    } finally {
      setArchiveBusy(false);
    }
  };

  /** 撤销上次杀青（换个模型重来）：弹出最后一条归档。 */
  const handleUndoWrap = () => {
    const s = currentScript;
    if (!s || archiveBusy) return;
    const list = s.archives ?? [];
    if (list.length === 0) {
      setArchiveError("没有可撤销的归档。");
      return;
    }
    const updated = { ...s, archives: list.slice(0, -1) };
    const removed = list[list.length - 1];
    setCurrentScript(updated);
    saveOrUpdateEnsembleScript(updated);
    setScripts(loadEnsembleScripts());
    refreshArchivePanelFor(updated);
    // 同步撤回这条归档在参与角色记忆库里的副本
    if (removed) void removeEnsembleArchiveFromMemory(updated, removed).catch(() => undefined);
    setToast("已撤销上次杀青");
  };

  /**
   * 保存档案（2026-10-11 修）：把编辑框内容回写到归档。
   *
   * 实机症状「能编辑、点保存没反应」，根因是**读取口径与写入口径不一致**：
   *   · 读（refreshArchivePanelFor）：把**全部归档** content 拼接后塞进编辑框
   *   · 写（旧实现）：只回写到**最后一条**归档
   *   一旦存在多条归档（或最后一条为空——你截图里正是「0 已杀青却有条文」这种
   *   导入残留态），写回去的内容就不等于用户看到的内容，看起来「保存不了」。
   *
   * 现在按编辑框的同一口径整体回写：内容归到最后一条，前面的清空，
   * 保证「存下来的 === 刚才看到的」。
   */
  const handleSaveArchiveContent = () => {
    const s = currentScript;
    if (!s) return;
    const list = s.archives ?? [];
    if (list.length === 0) return;
    const content = archiveContentDraft;
    if (!content.trim()) {
      setArchiveError("档案内容为空，已取消保存（不会清空已有归档）。");
      return;
    }
    const lastIndex = list.length - 1;
    const next = list.map((a, i) =>
      i === lastIndex ? { ...a, content } : a.content ? { ...a, content: "" } : a
    );
    const updated: EnsembleScript = { ...s, archives: next };
    setCurrentScript(updated);
    saveOrUpdateEnsembleScript(updated);
    setScripts(loadEnsembleScripts());

    // 记忆库那份是独立副本，改了群像归档就要同步过去。
    // 先按旧内容删掉（进墓碑），再按新内容写一份，避免同一条内容留下两份。
    const oldEntry = list[lastIndex];
    if (oldEntry) {
      void removeEnsembleArchiveFromMemory(updated, oldEntry)
        .then(() => syncEnsembleArchiveToMemory(updated, next[lastIndex]))
        .catch(() => undefined);
    }

    // 存完重填草稿：否则 textarea 仍是旧内容，看起来像「没保存」
    refreshArchivePanelFor(updated);
    setToast("档案已保存");
  };

  /** 打开「模型切换」：默认停在 API 一级列表，重置上次的二级态 */
  const openModelSheet = () => {
    // 这里不做过滤：硅基流动在渲染层被折叠成「工具调用」小按键，需要拿到完整列表。
    setApiConfigList(loadApiConfigs());
    setModelPickerApiId(null);
    setModelNameList([]);
    setModelListError(null);
    setShowHiddenApis(false);
    setShowModelSheet(true);
  };

  /**
   * 进入某个 API 的二级列表（该 API 下的全部模型，需求 1.6）。
   * 优先用配置里已存的可用模型；没有（或为空）时才实时拉取。
   */
  const openModelPickerForApi = async (cfg: ApiConfig) => {
    setModelPickerApiId(cfg.id);
    setModelListError(null);

    const saved = (cfg as ApiConfig & { availableModels?: string[] })
      .availableModels;
    if (Array.isArray(saved) && saved.length > 0) {
      setModelNameList(saved);
      return;
    }

    setModelNameList([]);
    setIsLoadingModels(true);
    try {
      const names = await fetchModelNames(cfg);
      setModelNameList(names);
      if (names.length === 0) setModelListError("该接口未返回任何模型");
    } catch (err) {
      setModelListError(err instanceof Error ? err.message : "拉取模型列表失败");
    } finally {
      setIsLoadingModels(false);
    }
  };

  /** 选中某 API 下的具体模型 → 写进剧本级覆盖（apiConfigIdOverride + modelOverride） */
  const pickModelForApi = (apiId: string, modelName: string) => {
    if (!currentScript) return;
    const updated = {
      ...currentScript,
      apiConfigIdOverride: apiId,
      modelOverride: modelName,
    };
    setCurrentScript(updated);
    saveOrUpdateEnsembleScript(updated);
    setScripts(loadEnsembleScripts());
    setLastModel(modelName);
    // 1007：模型列表已改为**卡片内联展开**，选中后不再关整层弹窗，
    // 只收起该卡片（用户可继续比别的 API），由底部「完成」统一退出。
    setModelPickerApiId(null);
    setModelListError(null);
    setToast(`已切换为 ${modelName}`);
  };

  /**
   * 卡片内联展开/收起（1007 图1）。
   * 点同一张卡片 → 收起；点别的卡片 → 切到那张并拉它的模型列表。
   */
  const toggleModelExpand = (cfg: ApiConfig) => {
    if (modelPickerApiId === cfg.id) {
      setModelPickerApiId(null);
      setModelListError(null);
      return;
    }
    void openModelPickerForApi(cfg);
  };

  /**
   * 点卡片主体 → 直达选择（2026-10-09 M-模型块直达）。
   * 用户口径：「点整个块直接选择」——点卡片空白处即切到该 API 的**当前模型**
   * （即上次选定的 modelOverride，没选过则用 defaultModel）。
   * 想挑别的具体模型 → 点右侧 MODEL ▾ 展开列表（e.stopPropagation 隔开）。
   *
   * 与 toggleModelExpand 的区别：那个是「展开列表」，这个是「直接用」。
   * 若该卡片已经是当前选中项且已展开，则等价于收起（避免点击无反馈）。
   */
  const selectApiDefaultModel = (cfg: ApiConfig) => {
    if (!currentScript) return;
    // 已选中且已展开 → 当作收起（可预期的手感）
    if (currentScript.apiConfigIdOverride === cfg.id && modelPickerApiId === cfg.id) {
      setModelPickerApiId(null);
      setModelListError(null);
      return;
    }
    // 该 API 的「当前模型」：优先上次为该 API 选定的，否则其默认模型
    const targetModel =
      currentScript.apiConfigIdOverride === cfg.id && currentScript.modelOverride
        ? currentScript.modelOverride
        : cfg.defaultModel || cfg.provider || "UNKNOWN";
    const updated = {
      ...currentScript,
      apiConfigIdOverride: cfg.id,
      modelOverride: targetModel,
    };
    setCurrentScript(updated);
    saveOrUpdateEnsembleScript(updated);
    setScripts(loadEnsembleScripts());
    setLastModel(targetModel);
    setModelPickerApiId(null);
    setModelListError(null);
    setToast(`已切到 ${cfg.name || cfg.provider || "该模型"}`);
  };

  /** 提交某一幕的编辑 */
  const commitTurnEdit = (turnId: string) => {
    if (!currentScript) return;
    const text = editingTurnDraft.trim();
    setEditingTurnId(null);
    if (!text) return;
    const updated = updateEnsembleTurn(currentScript.id, turnId, {
      content: text,
      tokens: text.length,
    });
    if (updated) {
      setCurrentScript(updated);
      setScripts(loadEnsembleScripts());
    }
  };

  // 剧幕落库的辅助：写入我的台词（旁白/角色台词统一入口）
  const handleSendTurn = async () => {
    if (!inputText.trim() || !currentScript) return;
    const text = inputText.trim();
    setInputText("");

    const newTurn: EnsembleTurn = {
      id: "turn_" + Date.now(),
      senderId: activePersona?.id || currentUser?.name || "user",
      senderName: activePersona?.name || currentUser?.name || "你",
      senderType: "user",
      content: text,
      timestamp: new Date().toISOString(),
      tokens: text.length,
    };

    const updated = appendEnsembleTurn(currentScript.id, newTurn);
    if (updated) {
      setCurrentScript(updated);
      setScripts(loadEnsembleScripts());
    }
  };

  // ══════════════════════════════════════════════════════
  // 视图 1：用户面具选择
  // ══════════════════════════════════════════════════════
  if (view === "personas") {
    return (
      <div className="flex flex-col h-full bg-[#f6f6f8] text-[#1a1a1a] font-sans overflow-hidden">
        <EnsembleHeader
          title="群像剧"
          onBack={() => handleBack()}
          showBack={!!onClose}
        />

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <div className="text-xs text-black/45 px-1 pt-1">
            选择一个面具，进入它所属的角色群像
          </div>

          {identities.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-center text-black/40 space-y-3">
              <Users size={36} className="stroke-[1.5]" />
              <div className="text-sm">尚未创建用户面具</div>
              <div className="text-[11px] text-black/30 px-8 leading-relaxed">
                请先到「设置 → 用户面具」中创建面具，并为角色绑定面具后即可在此选择。
              </div>
            </div>
          ) : (
            identities.map((p) => {
              const ownedChars = characters.filter(
                (ch) => resolveUserIdentity(ch.id)?.id === p.id
              );
              const isActive = p.id === activePersonaId;
              return (
                <button
                  key={p.id}
                  type="button"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setActivePersonaId(p.id);
                    setView("scripts");
                  }}
                  className={`w-full text-left rounded-2xl p-4 border shadow-sm transition active:scale-[0.99] flex items-center gap-3.5 ${
                    isActive
                      ? "border-[#1a1a1a] bg-white"
                      : "border-black/[0.05] bg-white/80 hover:bg-white"
                  }`}
                  style={{ touchAction: "manipulation" }}
                >
                  <div className="w-12 h-12 rounded-full overflow-hidden bg-black/10 flex items-center justify-center text-sm font-semibold shrink-0">
                    {p.avatarUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={p.avatarUrl}
                        alt={p.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      p.name.slice(0, 1)
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm truncate">{p.name}</div>
                    <div className="text-[11px] text-black/45 line-clamp-1 mt-0.5">
                      {p.occupation ? `${p.occupation} · ` : ""}
                      {p.bio || "暂无简介"}
                    </div>
                    <div className="text-[11px] text-black/35 font-mono mt-1">
                      {ownedChars.length} 位角色
                    </div>
                  </div>
                  <ChevronLeft size={18} className="rotate-180 text-black/25 shrink-0" />
                </button>
              );
            })
          )}
        </div>
      </div>
    );
  }

  // ══════════════════════════════════════════════════════
  // 视图 2：剧本列表（当前面具下）
  // ══════════════════════════════════════════════════════
  if (view === "scripts") {
    return (
      <div className="relative flex flex-col h-full bg-[#f6f6f8] text-[#1a1a1a] font-sans overflow-hidden">
        <EnsembleHeader
          title="群像剧"
          subtitle={activePersona ? `面具 · ${activePersona.name}` : undefined}
          onBack={(e?: any) => handleBack(e)}
          right={
            <button
              type="button"
              aria-label="新建"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setView("create");
              }}
              className="w-11 h-11 grid place-items-center rounded-full hover:bg-black/5 text-black/70 active:scale-90 transition"
              style={{ WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
            >
              <Plus size={22} strokeWidth={1.8} />
            </button>
          }
        />

        {/* 剧本列表（探索群像 tab 已隐藏，代码保留待后续开放） */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {visibleScripts.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-center text-black/40 space-y-3">
              <Users size={36} className="stroke-[1.5]" />
              <div className="text-sm">暂无群像剧</div>
              <button
                type="button"
                onClick={() => setView("create")}
                className="px-4 py-2 bg-[#1a1a1a] text-white rounded-xl text-xs font-medium shadow-sm active:scale-95 transition"
              >
                创建第一个群像剧
              </button>
            </div>
          ) : (
            visibleScripts.map((s) => (
              <div
                key={s.id}
                role="button"
                tabIndex={0}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setCurrentScript(s);
                  // 切剧本时重置历史分页（只显示最后一段）
                  setEarlierBatches(1);
                  setView("workspace");
                }}
                className="bg-white/80 backdrop-blur-sm border border-black/[0.04] rounded-2xl p-4 shadow-sm active:scale-[0.99] transition cursor-pointer flex flex-col gap-2.5"
                style={{ touchAction: "manipulation" }}
              >
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-sm text-[#1a1a1a] line-clamp-1">
                    {s.title}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <div className="text-[11px] text-black/40 font-mono">
                      {s.cast.length} CAST
                    </div>
                    <button
                      type="button"
                      title="删除剧本"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setConfirmState({
                          title: "删除这个剧本？",
                          message: `《${s.title}》及其 ${s.turns.length} 幕剧情将被永久删除，无法恢复。`,
                          onConfirm: () => {
                            deleteEnsembleScript(s.id);
                            setScripts(loadEnsembleScripts());
                            setConfirmState(null);
                          },
                        });
                      }}
                      className="p-1 rounded hover:text-red-500 text-black/25"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
                <div className="flex items-center justify-between pt-1 border-t border-black/[0.02]">
                  <div className="flex -space-x-1.5 overflow-hidden">
                    {s.cast.map((c) => (
                      <div
                        key={c.id}
                        className="w-5 h-5 rounded-full border border-white bg-black/10 overflow-hidden flex items-center justify-center text-[11px]"
                      >
                        {c.avatar ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={c.avatar}
                            alt={c.name}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          c.name.slice(0, 1)
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="text-[11px] text-black/35 font-mono">
                    {s.turns.length} 幕
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* 删除剧本确认弹窗 */}
        {confirmState && (
          <ConfirmDialog
            title={confirmState.title}
            message={confirmState.message}
            confirmLabel={confirmState.confirmLabel}
            onCancel={() => setConfirmState(null)}
            onConfirm={confirmState.onConfirm}
          />
        )}
      </div>
    );
  }

  // ══════════════════════════════════════════════════════
  // 视图 3：创建剧本
  // ══════════════════════════════════════════════════════
  if (view === "create") {
    return (
      <div className="flex flex-col h-full bg-white text-[#1a1a1a] font-sans overflow-hidden">
        <EnsembleHeader
          title="新建群像剧"
          onBack={(e?: any) => handleBack(e)}
          right={
            <button
              type="button"
              aria-label="完成"
              disabled={!titleInput.trim() || selectedCastIds.length === 0}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => handleCreateScript(e)}
              className="px-3 h-11 rounded-full text-xs font-semibold text-[#1a1a1a] disabled:opacity-30 active:scale-95 transition inline-flex items-center gap-1"
              style={{ WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
            >
              <Check size={16} strokeWidth={2.4} />
              完成
            </button>
          }
        />

        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          <div>
            <label className="text-xs font-semibold text-black/60 block mb-1.5">
              剧本标题
            </label>
            <input
              type="text"
              value={titleInput}
              onChange={(e) => setTitleInput(e.target.value)}
              placeholder="例如：首尔夜色下的群像"
              className="w-full bg-black/[0.03] border border-black/5 rounded-xl px-3 py-2.5 text-xs text-[#1a1a1a] outline-none focus:border-black/20"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-black/60 block mb-2">
              选择参演角色 ({selectedCastIds.length})
            </label>
            {activePersona && (
              <div className="text-[11px] text-black/40 mb-2 px-0.5">
                仅显示绑定到面具「{activePersona.name}」的角色
              </div>
            )}
            {castableCharacters.length === 0 ? (
              <div className="text-xs text-black/35 text-center py-8 bg-black/[0.02] rounded-xl">
                当前面具下暂无绑定角色
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {castableCharacters.map((c) => {
                  const isSelected = selectedCastIds.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setSelectedCastIds((prev) =>
                          isSelected
                            ? prev.filter((id) => id !== c.id)
                            : [...prev, c.id]
                        );
                      }}
                      className={`flex items-center gap-2.5 p-2.5 rounded-xl border transition text-left ${
                        isSelected
                          ? "border-[#1a1a1a] bg-black/[0.04]"
                          : "border-black/5 bg-black/[0.01]"
                      }`}
                      style={{ touchAction: "manipulation" }}
                    >
                      <div className="w-8 h-8 rounded-full bg-black/10 overflow-hidden flex items-center justify-center text-xs shrink-0">
                        {c.avatar ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={c.avatar}
                            alt={c.name}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          c.name.slice(0, 1)
                        )}
                      </div>
                      <div className="text-xs font-medium line-clamp-1">{c.name}</div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ══════════════════════════════════════════════════════
  // 视图 4：剧本剧场（对话）
  // ══════════════════════════════════════════════════════
  // 同步「当前会话字号倍率」到模块级变量：ts() 在各内联 style 里即时读取。
  // 必须在 return 前调用（同一渲染周期内生效）。
  syncEnsembleFontSize(currentScript?.fontSize);
  syncEnsembleFontFamily(currentScript?.fontFamily);
  return (
    <div
      className="ensemble-scope flex flex-col h-full relative bg-[#f6f6f8] text-[#1a1a1a] font-sans overflow-hidden"
      style={
        currentScript?.fontFamily
          ? { fontFamily: `"${currentScript.fontFamily}", "Songti SC", "Noto Sans SC", system-ui, sans-serif` }
          : undefined
      }
    >
      {/* 字号缩放桥接已删除（2026-10）：群像内部字号一律写死，
          不再跟随全局 --app-text-scale，故无需 .ensemble-scope 的 34 行覆盖。 */}

      {/* 当前会话字体（剧本级 · 06 TYPOGRAPHY）：
          运行时以原生 <style> 注入 document.head（见上面的 fontSource effect）。
          **不用 styled-jsx** —— .frame-body 是普通 class 不带 jsx-hash，scoped 选择器不匹配。 */}

      {/* 剧本级自定义 CSS：仅作用于本 App 的 .ensemble-scope 命名空间 */}
      {/* 用户卡片：输入内容一律纯黑（1006 反馈 R1）。
          用户投稿不切帧，走 BodyText 原样渲染，颜色由这里统一压黑。 */}
      <style jsx global>{`
        .ensemble-scope .frame-user,
        .ensemble-scope .frame-user .frame-body,
        .ensemble-scope .frame-user div,
        .ensemble-scope .frame-user span,
        .ensemble-scope .frame-user p {
          color: #1f1f1f !important;
        }
        /* 1007：工作区滚动条隐藏视觉（保留滚动能力）。
           配合 scrollbar-gutter: stable both-edges，左右 gutter 等宽，
           彻底消除「右内缩比左大 12–15px」的滚动条占位差。 */
        .ensemble-scope .ensemble-workspace-scroll::-webkit-scrollbar {
          width: 0;
          height: 0;
          display: none;
        }
        /* 1007b：居中浮窗的统一入场 —— 缩放 + 上浮 8px + 模糊收敛。
           替代原有的「底部 sheet 上滑」，去掉从底部弹起的感觉。 */
        @keyframes softRise {
          from {
            opacity: 0;
            transform: translateY(8px) scale(0.96);
            filter: blur(6px);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
            filter: blur(0);
          }
        }
      `}</style>
      {currentScript?.customCss?.trim() ? (
        <style
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: currentScript.customCss }}
        />
      ) : null}

      {/* CSS 草稿即时预览：编辑面板打开时把草稿注入（不改库）。
          放在已保存样式之后，同优先级下后者覆盖前者，所见即所得。 */}
      {showCssSheet && cssDraft.trim() ? (
        <style
          data-ensemble-css-preview
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: cssDraft }}
        />
      ) : null}
      {!currentScript ? (
        /* 兜底：剧本意外丢失时也不能变成"回不去的白屏" */
        <EnsembleHeader
          title="群像剧"
          onBack={(e?: any) => handleBack(e)}
          showBack={!!onClose}
        />
      ) : (
        <>
          <EnsembleHeader
            title={
              editingTitle ? (
                <input
                  autoFocus
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={commitTitleRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitTitleRename();
                    if (e.key === "Escape") setEditingTitle(false);
                  }}
                  className="text-[15px] font-semibold tracking-tight text-center bg-black/[0.05] rounded-lg px-2 py-0.5 outline-none w-full"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setTitleDraft(currentScript.title);
                    setEditingTitle(true);
                  }}
                  className="text-[15px] font-semibold tracking-tight truncate max-w-full hover:opacity-70 transition-opacity"
                  title="点击修改剧本名"
                >
                  {currentScript.title}
                </button>
              )
            }
            subtitle={`${currentScript.cast.length} CAST${
              activePersona ? ` · ${activePersona.name}` : ""
            }${
              (() => {
                const hint = describePendingSessions(currentScript.id);
                return hint ? ` · ${hint}` : "";
              })()
            }`}
            /* 顶栏返回 = 离开本剧本，回剧本列表。
               面板的返回统一交给工作区左上角的小返回键（见下方 workspaceBackBtn），
               两者职责分离，不再出现「点了返回却弹出功能面板」的错乱。 */
            onBack={(e?: any) => handleBack(e)}
            /* 1006 反馈 R3：剧本设置入口移到工作区顶栏右上角（原在 + 号功能面板内）。 */
            right={
              <button
                type="button"
                aria-label="剧本设置"
                title="剧本设置"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openSettingsPage();
                }}
                className="w-11 h-11 grid place-items-center rounded-full hover:bg-black/5 text-black/50 active:scale-90 transition"
                style={{
                  WebkitTapHighlightColor: "transparent",
                  touchAction: "manipulation",
                }}
              >
                <Settings size={19} strokeWidth={1.9} />
              </button>
            }
          />


          {/* 3.1：顶栏「取消生成」与「← 返回剧本」按键已删除。
              关闭/返回由 MiniSheet 自身顶栏箭头负责，不在工作区顶部重复。

              1007 第二轮修正（上一轮用 scrollbar-gutter: both-edges 改错了）：
                both-edges 的语义是「**左右两侧都预留** gutter」，等于凭空在左右
                各加一条 ~15px 的空隙 → 实机反而比之前 10px 更宽、更丑。
                正确做法：**不给任何 gutter**，滚动条本身完全隐藏
                （scrollbar-width:none + ::-webkit-scrollbar 已在全局样式里隐藏），
                于是左右 padding 就是纯粹的 px-4(16px)，两侧严格相等。
                再叠加 .ensemble-frames 的 10px 帧内缩 = 正文左右各 26px，对称。 */}
          <div
            ref={scrollRef}
            className="ensemble-workspace-scroll flex-1 overflow-y-auto px-[18px] py-4 space-y-[14px] min-h-0"
            style={{
              scrollbarWidth: "none",
              msOverflowStyle: "none",
            }}
          >
            {apiError && (
              <div className="text-[11px] text-red-600 bg-red-50 border border-red-200 rounded-xl px-3 py-2 leading-relaxed">
                API 调用失败：{apiError}
              </div>
            )}

            {currentScript.turns.length === 0 && !isGenerating && (
              <div className="flex flex-col items-center justify-center h-56 text-center text-black/35 space-y-2">
                <Users size={28} className="stroke-[1.5]" />
                <div className="text-xs">剧本已就绪，开始第一幕吧</div>
              </div>
            )}

            {/* ── 历史分页（2026-10-10）：每 10 轮一段，默认只显示最后一段 ──
                纯 UI 分页（不改数据）。点「加载更早记录」逐段往上展开，
                对齐 chill 的 FETCH EARLIER LOGS 交互。 */}
            {(() => {
              const total = currentScript.turns.length;
              const shownCount = Math.min(total, earlierBatches * HISTORY_BATCH);
              const hiddenCount = total - shownCount;
              if (hiddenCount <= 0) return null;
              return (
                <div className="flex items-center gap-2 pt-1 pb-2">
                  <span
                    className="flex-1 h-px"
                    style={{
                      backgroundImage:
                        "repeating-linear-gradient(to right, rgba(0,0,0,0.10) 0 1px, transparent 1px 4px)",
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      // ── C4（2026-10-10）：加载更早记录时保持阅读位置 ──
                      //   往上插入内容后，若浏览器把视口重算到别处会「跳」。
                      //   这里记住「视口顶部在整体内容里的绝对位置」，插入后还原。
                      const el = scrollRef.current;
                      const changed = el ? el.scrollHeight : 0;
                      setEarlierBatches((n) => n + 1);
                      if (el) {
                        const topBefore = el.scrollTop;
                        requestAnimationFrame(() => {
                          requestAnimationFrame(() => {
                            const node = scrollRef.current;
                            if (!node) return;
                            // scrollHeight 变化量 = 上方插入的高度差；据此补回 scrollTop
                            const delta = node.scrollHeight - changed;
                            node.scrollTop = topBefore + delta;
                          });
                        });
                      }
                    }}
                    className="shrink-0 px-3.5 py-1.5 rounded-full bg-white border border-black/[0.06] text-[11px] font-medium text-black/55 tracking-[0.04em] active:scale-[0.96] transition-transform"
                  >
                    加载更早记录 · 还有 {hiddenCount} 幕
                  </button>
                  <span
                    className="flex-1 h-px"
                    style={{
                      backgroundImage:
                        "repeating-linear-gradient(to right, rgba(0,0,0,0.10) 0 1px, transparent 1px 4px)",
                    }}
                  />
                </div>
              );
            })()}

            {currentScript.turns
              .slice(
                -Math.min(
                  currentScript.turns.length,
                  earlierBatches * HISTORY_BATCH
                )
              )
              .map((turn, turnIndex, shownArr) => {
                // 分页后 slice 的序号会从 0 重来 → 换算回「全量序号」，
                // 保证 ✓ 分隔标记里的三位序号与真实轮次一致（不影响任何计算）。
                const fullIndex =
                  currentScript.turns.length - shownArr.length + turnIndex;
              const isUser = turn.senderType === "user";
              const isNarrationTurn = turn.senderType === "narration";
              const isNarrator = isNarrationTurn || turn.senderId === "narration";
              const castChar = currentScript.cast.find((c) => c.id === turn.senderId);

              // ── 「来自聊天」卡：聊天室聊完返回剧情后的整段对话 ──
              // 它是一个独立条目，不是旁白（以前误设 senderType="narration" 被整块隐藏了）
              if (turn.senderName === "来自聊天" || turn.senderId === "from_chat") {
                return (
                  <div key={turn.id}>
                    <div className="flex items-center gap-2 px-[10px] pt-3 pb-1.5">
                      <span
                        className="shrink-0 font-mono text-black/20 tabular-nums"
                        style={{ fontSize: TYPE.MICRO }}
                      >
                        {formatMinute(turn.timestamp).slice(-5)}
                      </span>
                      <span
                        className="flex-1 h-px"
                        style={{
                          backgroundImage:
                            "repeating-linear-gradient(to right, rgba(0,0,0,0.07) 0 1px, transparent 1px 4px)",
                        }}
                      />
                      <span
                        className="shrink-0 font-mono text-black/20 tabular-nums"
                        style={{ fontSize: TYPE.MICRO }}
                      >
                        {String(fullIndex).padStart(3, "0")}
                      </span>
                    </div>
                    <div
                      className="group bg-white rounded-[14px] px-0 border border-dotted border-black/[0.16] shadow-[0_1px_3px_rgba(0,0,0,0.03)]"
                      style={{ paddingTop: 18, paddingBottom: 16 }}
                    >
                      <div
                        className="flex items-center gap-2 pl-[9px] pr-[10px] pt-[26px] pb-4"
                      >
                        <span className="shrink-0 w-[20px] h-[20px] rounded-[5px] flex items-center justify-center"
                          style={{ background: "rgba(34,120,80,0.85)" }}>
                          <MessageCircle size={9} strokeWidth={0} className="fill-white text-white" />
                        </span>
                        <span
                          className="shrink-0 font-medium tracking-[0.16em] text-black/45"
                          style={{ fontSize: TYPE.MICRO - 2 }}
                        >
                          来自聊天
                        </span>
                        <span
                          className="flex-1 h-px"
                          style={{
                            backgroundImage:
                              "repeating-linear-gradient(to right, rgba(0,0,0,0.10) 0 1px, transparent 1px 4px)",
                          }}
                        />
                        <span
                          className="shrink-0 px-1.5 py-[2px] rounded-[4px] border border-dashed border-black/[0.18] text-black/30 tracking-[0.08em]"
                          style={{ fontSize: TYPE.MICRO - 3 }}
                        >
                          CHAT
                        </span>
                      </div>
                      <div
                        className="whitespace-pre-wrap break-words text-black/70"
                        style={{
                          paddingLeft: tpx(FRAME_BODY_INSET),
                          paddingRight: tpx(FRAME_TEXT_INSET),
                          fontSize: tpx(15),
                          lineHeight: 1.95,
                        }}
                      >
                        {turn.content}
                      </div>
                      {/* 底部操作栏：只保留删除（这段对话不是模型生成，重roll/投递无意义） */}
                      <div
                        className="flex items-center justify-end pt-2"
                        style={{ paddingLeft: tpx(FRAME_BODY_INSET), paddingRight: tpx(FRAME_TEXT_INSET) }}
                      >
                        <TurnActionBar
                          turn={turn}
                          versions={[]}
                          index={0}
                          isRerolling={false}
                          canReroll={false}
                          inline
                          onReroll={() => {}}
                          onSwitch={() => {}}
                          onDelete={() => {
                            setConfirmState({
                              title: "删除这段聊天记录？",
                              message: "这一段「来自聊天」的对话将从剧情里移除，无法恢复。聊天室里的原记录不受影响。",
                              confirmLabel: "删除",
                              onConfirm: () => {
                                removeOneRoll(turn.id);
                                setConfirmState(null);
                              },
                            });
                          }}
                        />
                      </div>
                    </div>
                  </div>
                );
              }

              // ── 旁白卡：黑底 P 图标 + NARRATION 标签 ──
              // 仅用于「非帧模型」的历史旁白 turn（旧数据 / 用户手发旁白）。
              // 帧模型生成的整幕（含纯旁白幕）统一走下方帧流渲染。
              // 历史遗留的旁白 turn（非帧模型 / 旧数据）：旁白不是独立卡片，
              // 统一并入下方常规卡片渲染，由帧层负责斜体灰样式。
              if (isNarrator && turn.rawText === undefined) {
                return null;
              }

              return (
                <div key={turn.id}>
                  {/* ── 卡片间分隔标记（抄 chill 格式）─────────────────────
                      1008 用户批注：「字色太深太大」「USR 和 SCN 都删掉」
                      → 去掉 USR/SCN 标签，只留 **时间 + 虚线 + 三位序号**，
                        颜色压到 black/20，字号再小一档（10px）。 */}
                  <div className="flex items-center gap-2 px-[10px] pt-3 pb-1.5">
                    <span
                      className="shrink-0 font-mono text-black/20 tabular-nums"
                      style={{ fontSize: TYPE.MICRO }}
                    >
                      {formatMinute(turn.timestamp).slice(-5)}
                    </span>
                    <span
                      className="flex-1 h-px"
                      style={{
                        backgroundImage:
                          "repeating-linear-gradient(to right, rgba(0,0,0,0.07) 0 1px, transparent 1px 4px)",
                      }}
                    />
                    <span
                      className="shrink-0 font-mono text-black/20 tabular-nums"
                      style={{ fontSize: TYPE.MICRO }}
                    >
                      {String(fullIndex).padStart(3, "0")}
                    </span>
                  </div>

                  <div
                    key={turn.id}
                    // 1008 抄 chill 格式：卡片改 **dotted 虚线边框**（原 0.04 实线太隐形）。
                    // 1008e 用户第4条「最后是整体拉松」：用户卡的上下留白 + 内部块距
                    //   各放宽一档（pt 15→18 / pb 12→16 / space-y 12→16），AI 卡维持原值。
                    className={`group bg-white rounded-[14px] px-0 border border-dotted border-black/[0.16] transition-shadow duration-200 hover:shadow-[0_2px_16px_rgba(0,0,0,0.05)] shadow-[0_1px_3px_rgba(0,0,0,0.03)] ${
                      isUser ? "pt-[18px] pb-4 space-y-4" : "pt-0 pb-3 space-y-3"
                    }`}
                  >
                  {/* ── AI 幕顶栏（抄 chill）：▶ 黑方块 + NARRATION + 虚线 + Multi ──
                      1008 用户拍板：AI 幕统一挂 `NARRATION` 顶栏，用户投稿幕不挂。
                      1008d A1：**整体缩小 2px**（22px 方块 → 20px）、
                        左内衬改为 **距卡片左边框 9px**（原 10px）。
                      1008e：**整体往下挪 6px**（用户实机批注）。
                        实现：pt 20 → 26（顶栏整体下沉，pb 保持 4 不变）。 */}
                  {!isUser && (
                    <div className="flex items-center gap-2 pl-[9px] pr-[10px] pt-[26px] pb-4">
                      <span className="shrink-0 w-[20px] h-[20px] rounded-[5px] bg-[#111111] flex items-center justify-center">
                        <Play size={8} strokeWidth={0} className="fill-white text-white ml-[1px]" />
                      </span>
                      <span
                        className="shrink-0 font-medium tracking-[0.16em] text-black/45"
                        style={{ fontSize: TYPE.MICRO - 2 }}
                      >
                        NARRATION
                      </span>
                      <span
                        className="flex-1 h-px"
                        style={{
                          backgroundImage:
                            "repeating-linear-gradient(to right, rgba(0,0,0,0.10) 0 1px, transparent 1px 4px)",
                        }}
                      />
                      {/* ── 杀青印记（2026-10-10）：已归档的幕打 ✓ WRAPPED ──
                          对齐 chill：已杀青的剧情对 AI 隐藏，UI 上留印记告知用户。
                          2026-10-10 用户反馈：改**红色**更醒目（原灰底不够显眼）。 */}
                      {archiveWrappedIds.has(turn.id) && (
                        <span
                          className="shrink-0 px-1.5 py-[2px] rounded-[4px] border border-dashed border-red-400 text-red-500 font-semibold tracking-[0.08em] -rotate-[3deg]"
                          style={{ fontSize: TYPE.MICRO - 3 }}
                        >
                          ✓ WRAPPED
                        </span>
                      )}
                      <span
                        className="shrink-0 px-1.5 py-[2px] rounded-[4px] border border-dotted border-black/[0.18] text-black/30 tracking-[0.08em]"
                        style={{ fontSize: TYPE.MICRO - 2 }}
                      >
                        Multi
                      </span>
                    </div>
                  )}
                  {/* 帧模型：一条 turn 承载整幕，卡内按帧连续渲染，角色名内联。
                      用户投稿（自己写的一幕）不切帧，按原样三色渲染。 */}
                  {isUser || turn.rawText === undefined ? (
                    <>
                      {/* 用户投稿卡头部（1008e · 用户第4条「头像和名字整块格式照搬 AI 卡片，
                          包括字号字色甚至是缩进等等全部一样」）：
                          一比一复制 AI 卡的 renderBlockHead ——
                            左基准 FRAME_HEAD_INSET(25) / 头像 AVATAR_PX(33) + 方角虚线框
                            / 间距 AVATAR_GAP(12) / 名字 T_NAME(11) + C_NAME(#5a5a5e) + 600。 */}
                      <div
                        className="flex items-center mb-4"
                        style={{
                          gap: tpx(AVATAR_GAP),
                          paddingLeft: tpx(FRAME_HEAD_INSET),
                          paddingRight: tpx(FRAME_TEXT_INSET),
                        }}
                      >
                        <div
                          className="rounded-[8px] border border-dotted border-black/20 bg-black/[0.03] overflow-hidden flex items-center justify-center shrink-0"
                          style={{ width: tpx(AVATAR_PX), height: tpx(AVATAR_PX) }}
                        >
                          {castChar?.avatar ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={castChar.avatar}
                              alt={turn.senderName}
                              className="w-full h-full object-cover"
                            />
                          ) : activePersona?.avatarUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={activePersona.avatarUrl}
                              alt={turn.senderName}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <span
                              className="font-semibold text-black/35"
                              style={{ fontSize: tpx(15) }}
                            >
                              {turn.senderName.slice(0, 1)}
                            </span>
                          )}
                        </div>
                        {/* 名字：与 AI 卡完全同款（frame-name + T_NAME + C_NAME + 600） */}
                        <div
                          className="frame-name font-semibold tracking-wide"
                          style={{
                            fontSize: tpx(T_NAME),
                            color: C_NAME,
                            fontWeight: 600,
                            opacity: 1,
                          }}
                        >
                          {turn.senderName}
                        </div>
                        {/* 用户要求：投递→聊天→返回剧情之后，下一轮用户卡片上要能看到
                            「已录入聊天记录」。只有真的把聊天内容归入了才显示。 */}
                        {isUser && deliveredTurnIds[turn.id] && (
                          <span
                            className="shrink-0 ml-auto mr-3 px-1.5 py-[2px] rounded-[4px] border border-dashed"
                            style={{
                              fontSize: TYPE.MICRO - 3,
                              borderColor: "rgba(34,120,80,0.45)",
                              color: "rgba(24,110,70,0.9)",
                              letterSpacing: "0.06em",
                            }}
                            title={`${new Date(deliveredTurnIds[turn.id]).toLocaleString("zh-CN")} 已录入聊天记录`}
                          >
                            已录入聊天记录
                          </span>
                        )}
                      </div>

                      {editingTurnId === turn.id ? (
                        <div className="space-y-2">
                          <textarea
                            autoFocus
                            value={editingTurnDraft}
                            onChange={(e) => setEditingTurnDraft(e.target.value)}
                            rows={4}
                            className="w-full bg-black/[0.03] border border-black/10 rounded-xl p-2.5 text-[13px] leading-[1.85] outline-none focus:border-black/25 resize-none"
                          />
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setEditingTurnId(null)}
                              className="px-3 py-1 text-[11px] text-black/50 hover:bg-black/5 rounded-lg"
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              onClick={() => commitTurnEdit(turn.id)}
                              className="px-3 py-1 text-[11px] bg-[#1a1a1a] text-white rounded-lg"
                            >
                              保存
                            </button>
                          </div>
                        </div>
                      ) : (
                        // 1008e 第4条：用户卡正文「照搬旁白」——
                        //   左基准 = FRAME_BODY_INSET(30)，右基准 = FRAME_TEXT_INSET(30)，
                        //   字号/字色由 BodyText kind="act" 控制（SM=13 / 灰色 #8e8e93）。
                        //   与 AI 卡旁白完全同款视觉。左对齐不变。
                        <div
                          className="frame-user"
                          style={{
                            textAlign: "left",
                            paddingLeft: tpx(FRAME_BODY_INSET),
                            paddingRight: tpx(FRAME_TEXT_INSET),
                          }}
                        >
                          <BodyText raw={turn.content} kind="act" inset={0} />
                        </div>
                      )}
                    </>
                  ) : editingTurnId === turn.id ? (
                    <div className="space-y-2">
                      <textarea
                        autoFocus
                        value={editingTurnDraft}
                        onChange={(e) => setEditingTurnDraft(e.target.value)}
                        rows={6}
                        className="w-full bg-black/[0.03] border border-black/10 rounded-xl p-2.5 text-[13px] leading-[1.85] outline-none focus:border-black/25 resize-none"
                      />
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setEditingTurnId(null)}
                          className="px-3 py-1 text-[11px] text-black/50 hover:bg-black/5 rounded-lg"
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          onClick={() => commitTurnEdit(turn.id)}
                          className="px-3 py-1 text-[11px] bg-[#1a1a1a] text-white rounded-lg"
                        >
                          保存
                        </button>
                      </div>
                    </div>
                  ) : (
                    <EnsembleFrameStream
                      frames={framesOfTurn(
                        turn,
                        castWithPersona(currentScript.cast, activePersona)
                      )}
                      cast={castWithPersona(currentScript.cast, activePersona)}
                      // 启用状态面板且该幕有状态数据时，头像可点 → 弹角色卡
                      onAvatarClick={
                        currentScript.statusPanel?.enabled && turn.statusData
                          ? (speaker) => {
                              const m = currentScript.cast.find(
                                (c) => c.name === speaker
                              );
                              setStatusCardMemberId(m?.id ?? null);
                              setStatusCardTurnId(turn.id);
                            }
                          : undefined
                      }
                      turnId={turn.id}
                      onVoicePlay={playEnsembleVoice}
                      playingVoiceKey={playingVoiceKey}
                      fontFamily={currentScript?.fontFamily}
                    />
                  )}

                  {turn.storyboardUrl && (
                    <div className="mt-2">
                      <img
                        src={turn.storyboardUrl}
                        alt=""
                        className="w-full rounded-xl object-cover"
                        style={{ aspectRatio: "16 / 9" }}
                        loading="lazy"
                      />
                    </div>
                  )}

                  {/* 元信息 + 操作（1008 抄 chill 格式）
                      · 上方一道虚线分隔
                      · 每行 **左标签 + 右值**（两端对齐，labels 淡、值等宽右对齐）
                      · 下方再一道虚线 + 分页（‹ 1/1 ›）在左、操作图标在右
                      · 1008 用户批注：「**用户卡片不需要这三行**」（DATE/MODEL/TOKENS）
                        → 仅 AI 幕渲染元信息行，用户投稿幕只留分页 + 操作图标。 */}
                  <div className="px-[10px]" data-ens-ui="1">
                    {!isUser && (
                      <>
                        <div
                          className="h-px mb-2"
                          style={{
                            backgroundImage:
                              "repeating-linear-gradient(to right, rgba(0,0,0,0.10) 0 1px, transparent 1px 4px)",
                          }}
                        />
                        <div
                          className="flex flex-col gap-[8px] font-mono tracking-tight leading-none text-black/40"
                          // 1009：用户口径「DATE/MODEL/TOKENS 字号缩小 2px」→ 11→9px。
                          // token 体系禁止新增档位，此处行内直出。
                          style={{ fontSize: tpx(TYPE.MICRO - 2) }}
                        >
                          <div className="flex items-baseline justify-between gap-3">
                            <span className="shrink-0 text-black/28 tracking-[0.18em]">
                              DATE
                            </span>
                            <span className="tabular-nums truncate">
                              {formatMinute(turn.timestamp)}
                            </span>
                          </div>
                          {(turn.model || lastModel) && (
                            <div className="flex items-baseline justify-between gap-3">
                              <span className="shrink-0 text-black/28 tracking-[0.18em]">
                                MODEL
                              </span>
                              {/* 1008e 用户口径：「这里的 MODEL 必须显示完整！」
                                  → 去掉 truncate，改为整段换行完整显示（长模型名不省略）。
                                  靠右对齐用 text-right + break-all 兜底超长串。 */}
                              <span
                                className="text-right break-all"
                                title={turn.model || lastModel}
                              >
                                {turn.model || lastModel}
                              </span>
                            </div>
                          )}
                          {turn.tokens !== undefined && (
                            <div className="flex items-baseline justify-between gap-3">
                              <span className="shrink-0 text-black/28 tracking-[0.18em]">
                                字数
                              </span>
                              <span className="tabular-nums">
                                {turn.tokens}
                              </span>
                            </div>
                          )}
                        </div>
                        <div
                          className="h-px mt-2"
                          style={{
                            backgroundImage:
                              "repeating-linear-gradient(to right, rgba(0,0,0,0.10) 0 1px, transparent 1px 4px)",
                          }}
                        />
                      </>
                    )}
                    <div className="flex items-center justify-between pt-1.5">
                      <span
                        className="font-mono text-black/30 tabular-nums"
                        style={{ fontSize: TYPE.MICRO }}
                      >
                        ‹ {(rollIndexMap[turn.id] ?? 0) + 1}/
                        {(rollsMap[turn.id]?.length ?? 1)} ›
                      </span>
                      <TurnActionBar
                        turn={turn}
                        versions={rollsMap[turn.id]}
                        index={rollIndexMap[turn.id] ?? 0}
                        isRerolling={rerollingTurnId === turn.id}
                        canReroll={!!turn.senderId && !isUser}
                        inline
                        onReroll={() => handleRerollTurn(turn)}
                        onSwitch={(d) => switchRoll(turn.id, d)}
                        onEdit={() => {
                          setEditingTurnDraft(turn.content);
                          setEditingTurnId(turn.id);
                        }}
                        onDelete={() => requestDeleteTurn(turn)}
                        onDeliver={
                          !isUser && turn.senderName
                            ? () => {
                                const member = currentScript.cast.find(
                                  (c) => c.name === turn.senderName
                                );
                                if (!member) {
                                  setToast("找不到说话的角色");
                                  return;
                                }
                                // 单人 / 多人都要先选「哪一句」；多人在下一步才选单聊还是群聊
                                openDeliverPicker(turn, member);
                              }
                            : undefined
                        }
                      />
                    </div>
                  </div>
                </div>
                </div>
              );
            })}

            {isGenerating && (
              <div className="p-4 bg-white/60 rounded-2xl border border-black/5 flex items-center justify-center gap-2 text-xs text-black/40">
                <div className="w-1.5 h-1.5 rounded-full bg-black/30 animate-pulse" />
                <span>剧本正在演进中...</span>
              </div>
            )}
          </div>

          {/* ── 未杀青超限提醒（2026-10-10 C2）──
              未杀青幕数超过阈值时，在输入框上方提示「该杀青了」。
              点击直达归档面板；可关闭（本轮会被记住）。 */}
          {!archiveBannerDismissed &&
            archiveStats.pending > ARCHIVE_PENDING_ALERT && (
              <div
                className="px-3 shrink-0"
                style={{ paddingBottom: 6 }}
              >
                <button
                  type="button"
                  onClick={() => {
                    refreshArchivePanel();
                    setShowArchiveSheet(true);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-xl bg-amber-50 border border-amber-200/[0.7] text-left active:scale-[0.99] transition-transform"
                >
                  <span className="text-[13px] leading-none">⚠️</span>
                  <span className="flex-1 text-[11px] text-amber-800/90 leading-snug">
                    已有 <b>{archiveStats.pending}</b> 幕未杀青，剧情越堆越多会让记忆变模糊，建议提炼归档
                  </span>
                  <span className="shrink-0 text-[11px] font-semibold text-amber-700">
                    去杀青 ›
                  </span>
                </button>
              </div>
            )}

          {/* 底部输入栏 */}
          <div
            className="bg-white/80 backdrop-blur-xl border-t border-black/[0.04] px-3 py-2 shrink-0"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 12px)" }}
            data-ens-ui="1"
          >
            <div className="flex items-center gap-2">
              {/* 唯一的入口：+ 号 → 底部「功能」面板（旁白/配色/CSS/模型都收进去） */}
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setShowToolsSheet(true)}
                className="w-8 h-8 grid place-items-center rounded-full bg-black/[0.05] hover:bg-black/[0.09] text-black/55 shrink-0 active:scale-90 transition"
                title="功能"
                aria-label="功能"
              >
                <Plus size={17} strokeWidth={2} />
              </button>
              <textarea
                ref={composerRef}
                rows={1}
                value={inputText}
                onChange={(e) => {
                  setInputText(e.target.value);
                  autoGrowTextarea(e.currentTarget);
                }}
                onKeyDown={(e) => {
                  // Enter 行为跟随「设置 → 回车发送」开关（与聊天 App 同一项设置）。
                  // ⚠️ 旧实现无条件「Enter=发送」，手机上会要命：
                  //    手机输入法的「发送」键就是 Enter，用户没有 Shift 可逃，
                  //    于是想换行却直接把消息发了出去（用户反馈即此）。
                  //    开关关闭时 Enter 只换行，靠发送按钮提交。
                  // ⚠️ isComposing：中文/日文输入法用回车**确认候选词**时必须放行，
                  //    否则一选词就把半成品发出去了。
                  if (shouldSendChatInputOnEnter(e, enterToSendEnabled)) {
                    e.preventDefault();
                    handleSendTurn();
                  }
                }}
                enterKeyHint={enterToSendEnabled ? "send" : "enter"}
                placeholder={activePersona ? `以「${activePersona.name}」发言...` : "Write your line..."}
                className="flex-1 min-w-0 bg-black/[0.03] border-none outline-none rounded-xl px-3 py-2 text-xs text-[#1a1a1a] placeholder:text-black/25 resize-none leading-[1.6] overflow-y-auto"
                style={{ maxHeight: `${COMPOSER_MAX_PX}px` }}
              />
              {/* 两段式发送键：
                  有输入 → 发送我的台词；无输入 → 让 AI 演下一轮 */}
              {inputText.trim() ? (
                <button
                  type="button"
                  onClick={() => handleSendTurn()}
                  className="p-2 bg-[#1a1a1a] text-white rounded-xl transition-opacity shrink-0 active:scale-95"
                  title="发送我的台词"
                >
                  <Send size={15} />
                </button>
              ) : (
                <button
                  type="button"
                  disabled={isGenerating}
                  onClick={() => triggerAiTurn(currentScript)}
                  className="px-3 h-8 bg-[#1a1a1a] text-white rounded-xl text-[11px] font-semibold disabled:opacity-40 transition-opacity shrink-0 active:scale-95"
                  title="让 AI 演下一轮"
                >
                  {isGenerating ? "演绎中" : "下一轮"}
                </button>
              )}
            </div>
          </div>

          {/* 场景设定（1006 反馈④）：已删除本子弹窗，功能并入
              剧本设置页（顶栏右上角）的「开场白」。旧字段 background
              在 openSettingsPage 里做一次性迁移，内容不会丢。 */}

          {/* ═══════════ 功能面板（+ 号） ═══════════ */}
          <EnsembleToolsSheet
            open={showToolsSheet}
            onClose={() => setShowToolsSheet(false)}
            activeIds={
              [
                currentScript.customCss?.trim() ? "customCss" : null,
                currentScript.apiConfigIdOverride ? "model" : null,
                currentScript.timeAwareness?.enabled ? "timeAwareness" : null,
                currentScript.statusPanel?.enabled ? "statusPanel" : null,
                currentScript.worldBookIds?.length ? "worldBook" : null,
              ].filter(Boolean) as EnsembleToolId[]
            }
            onPick={(id) => {
              setShowToolsSheet(false);
              if (id === "customCss") {
                setCssDraft(currentScript.customCss || "");
                // 字体草稿：来源 / 链接 / 作用范围 / 正文字号
                setFontSourceDraft(currentScript.fontSource);
                setFontUrlDraft(currentScript.fontUrl ?? "");
                setFontScopeDraft(currentScript.fontScope ?? "story");
                setFontSizeDraft(currentScript.fontSize ?? 14);
                setShowCssSheet(true);
              } else if (id === "model") {
                openModelSheet();
              } else if (id === "timeAwareness") {
                const t = currentScript.timeAwareness;
                // W1：开关 ON = 感知现实时间；OFF = 架空时间。
                // 旧数据里可能存着 enabled=true + realtime=false（做反时期），
                // 这里按「开关即语义」归一化，避免读到旧态后界面自相矛盾。
                const on = Boolean(t?.enabled) && (t?.realtime ?? true);
                setTimeEnabledDraft(on);
                // 库里存的是 ISO（2015-03-29T15:54），输入框要显示成
                // 用户当初填的可读格式（2015-03-29 15:54），否则回填会带个 T。
                setTimeAnchorDraft(
                  t?.anchor ? t.anchor.replace("T", " ").slice(0, 16) : ""
                );
                setShowTimeSheet(true);
              } else if (id === "statusPanel") {
                const sp = currentScript.statusPanel;
                setStatusEnabledDraft(sp?.enabled ?? false);
                setStatusFieldsDraft(
                  sp?.fields?.length ? sp.fields : DEFAULT_STATUS_FIELDS
                );
                setStatusTemplateDraft(sp?.template || DEFAULT_STATUS_TEMPLATE);
                setShowStatusSheet(true);
              } else if (id === "worldBook") {
                // 世界书绑定（M2-b）：把剧本已绑定 id 灌进草稿，实时读全部可选世界书
                setWorldBookIdsDraft([...(currentScript.worldBookIds ?? [])]);
                setShowWorldBookSheet(true);
              } else if (id === "archive") {
                // 杀青归档（2026-10-10）：打开面板即刷新统计
                refreshArchivePanel();
                setShowArchiveSheet(true);
              } else if (id === "storyboard") {
                setShowStoryboardSheet(true);
              }
            }}
          />

          {/* 3.3：卡片配色弹窗已删除 */}

          {/* ═══════════ 子弹窗 1：自定义 CSS（命名空间以本项目 .ensemble-frames 为准） ═══════════ */}
          {showCssSheet && (
            <MiniSheet
              title="自定义 CSS"
              subtitle="CUSTOM STYLE · LIVE"
              onClose={() => {
                // 关闭时丢弃"未应用"的预览草稿，避免预览态残留；停在功能面板
                setCssDraft(currentScript.customCss || "");
                setShowCssSheet(false);
                setShowToolsSheet(true);
              }}
            >
              {/* CSS 编辑区 */}
              <div className="bg-white rounded-[16px] p-3.5 space-y-2">
                <div className="text-[11px] leading-relaxed text-black/45">
                  下方 CSS 只作用于本剧本，选择器请以{" "}
                  <span className="font-mono text-black/70 font-semibold">
                    .ensemble-frames
                  </span>{" "}
                  开头（正文容器）。改完点「应用」生效。
                </div>
                {/* 可用类名速查：点一下即插入，降低手写选择器的门槛 */}
                <div className="flex flex-wrap gap-1.5">
                  {[
                    [".ensemble-frames", "正文容器"],
                    [".frame-dialogue", "对白"],
                    [".frame-act", "叙述/动作/心理"],
                    [".frame-narration", "旁白"],
                    [".frame-name", "角色名"],
                  ].map(([sel, label]) => (
                    <button
                      key={sel}
                      type="button"
                      onClick={() =>
                        setCssDraft((v) =>
                          `${v ? v.replace(/\s*$/, "\n\n") : ""}${sel} {\n  \n}`
                        )
                      }
                      className="px-2 py-1 rounded-full bg-black/[0.05] active:scale-95 transition-transform"
                      style={{ fontSize: "11px" }}
                      title={`插入 ${label}`}
                    >
                      <span className="font-mono text-black/60">{sel}</span>
                      <span className="text-black/30 ml-1">{label}</span>
                    </button>
                  ))}
                </div>
                <textarea
                  value={cssDraft}
                  onChange={(e) => setCssDraft(e.target.value)}
                  rows={8}
                  spellCheck={false}
                  placeholder={`/* ========== 群像正文 · 自定义样式 ==========\n   选择器请以 .ensemble-frames 开头，改完点「应用」生效\n\n   .ensemble-frames .frame-dialogue { color: #111; }\n   .ensemble-frames .frame-narration { font-size: 13.5px; }\n*/`}
                  className="w-full bg-black/[0.03] border border-black/5 rounded-xl p-3 text-[11px] font-mono text-[#111111] placeholder:text-black/25 outline-none focus:border-black/20 resize-none leading-relaxed"
                />
              </div>

              {/* ── 自定义字体（原 06 TYPOGRAPHY，迁入此处）── */}
              <div className="bg-white rounded-[16px] p-4 space-y-3.5">
                <div className="flex items-baseline justify-between">
                  <div className="text-[14px] font-semibold text-[#111111]">自定义字体</div>
                  <div className="text-[11px] text-black/35">本剧本专属</div>
                </div>
                <div className="text-[11px] leading-relaxed text-black/45">
                  只作用于当前剧本的剧情正文；上传文件或填写直链二选一
                </div>

                {/* 上传文件（整行可点，右侧图标，参考剧情 App） */}
                <label className="block rounded-[12px] bg-black/[0.04] px-3.5 py-3 cursor-pointer hover:bg-black/[0.06] transition-colors">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium text-[#111111]">
                        {fontSourceDraft === "upload"
                          ? `已选择 · ${fontUploadName || "字体文件"}`
                          : "上传字体文件"}
                      </div>
                      <div className="text-[11px] text-black/40 mt-0.5">
                        TTF / OTF / WOFF / WOFF2 · 本地保存不上传
                      </div>
                    </div>
                    <Upload size={tpx(18)} strokeWidth={1.9} className="shrink-0 text-black/50" />
                  </div>
                  <input
                    type="file"
                    accept=".ttf,.otf,.woff,.woff2,font/*"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (file) void handleEnsembleFontUpload(file);
                    }}
                  />
                </label>

                {/* 字体 URL */}
                <div>
                  <div className="text-[12px] font-medium text-[#111111] mb-1.5">字体 URL</div>
                  <input
                    value={fontUrlDraft}
                    onChange={(e) => setFontUrlDraft(e.target.value)}
                    placeholder="https://example.com/font.ttf"
                    className="w-full rounded-[12px] bg-black/[0.04] px-3.5 py-2.5 text-[12px] text-[#111111] placeholder:text-black/25 outline-none"
                  />
                  <button
                    type="button"
                    disabled={!fontUrlDraft.trim()}
                    onClick={() => handleEnsembleFontUseUrl(fontUrlDraft.trim())}
                    className="mt-2 w-full py-2.5 rounded-[12px] text-[13px] font-medium bg-[#111111] text-white disabled:opacity-25 active:scale-[0.985] transition-transform"
                  >
                    应用字体 URL
                  </button>
                  <div className="text-[11px] leading-relaxed text-black/35 mt-1.5">
                    远程字体需可直接访问且允许跨域加载，否则浏览器会回退默认字体
                  </div>
                </div>

                {/* 已生效提示 + 移除 */}
                {fontSourceDraft && (
                  <div className="flex items-center justify-between rounded-[12px] border border-black/10 px-3.5 py-2.5">
                    <span className="text-[12px] text-[#2e7d32]">
                      ✓ 当前使用{fontSourceDraft === "upload" ? "上传字体" : "链接字体"}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleEnsembleFontClear()}
                      className="text-[12px] text-[#b42318] hover:underline"
                    >
                      移除
                    </button>
                  </div>
                )}

                {/* 作用范围 */}
                <div>
                  <div className="text-[12px] font-medium text-[#111111] mb-1.5">作用范围</div>
                  <div className="flex gap-2">
                    {(
                      [
                        ["story", "仅剧情正文"],
                        ["all", "全部文字"],
                      ] as const
                    ).map(([val, label]) => {
                      const on = fontScopeDraft === val;
                      return (
                        <button
                          key={val}
                          type="button"
                          onClick={() => setFontScopeDraft(val)}
                          className={`flex-1 py-2 rounded-[10px] text-[12px] border transition-colors ${
                            on
                              ? "border-[#111111] bg-black/[0.05] text-[#111111] font-medium"
                              : "border-black/10 text-black/45 hover:bg-black/[0.03]"
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* 字号（绝对 px，可预期） */}
                <div>
                  <div className="flex items-baseline justify-between mb-1.5">
                    <div className="text-[12px] font-medium text-[#111111]">正文字号</div>
                    <div className="text-[11px] text-black/45 tabular-nums">
                      {fontSizeDraft}px
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {(
                      [
                        [11, "11"],
                        [14, "14"],
                        [16, "16"],
                        [18, "18"],
                      ] as const
                    ).map(([val, label]) => {
                      const on = fontSizeDraft === val;
                      return (
                        <button
                          key={label}
                          type="button"
                          onClick={() => setFontSizeDraft(val)}
                          className={`flex-1 py-2 rounded-[10px] text-[12px] border transition-colors ${
                            on
                              ? "border-[#111111] bg-black/[0.05] text-[#111111] font-medium"
                              : "border-black/10 text-black/45 hover:bg-black/[0.03]"
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                  <input
                    type="range"
                    min={10}
                    max={20}
                    step={1}
                    value={fontSizeDraft}
                    onChange={(e) => setFontSizeDraft(Number(e.target.value))}
                    className="mt-2.5 w-full accent-[#111111]"
                  />
                  <div className="text-[11px] text-black/35 mt-1">
                    10 ~ 20 px，其余层级按比例自动缩放
                  </div>
                </div>
              </div>

              {/* 底部按钮 */}
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    setCssDraft(currentScript.customCss || "");
                    setShowCssSheet(false);
                    setShowToolsSheet(true);
                  }}
                  className="flex-1 py-3 rounded-[16px] bg-white text-[13px] font-medium text-black/55 active:scale-[0.985] transition-transform"
                >
                  关闭
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const updated = {
                      ...currentScript,
                      customCss: cssDraft,
                      // 一并保存字体的作用范围与正文字号（字体本体已在
                      // 选择文件 / 应用字体 URL 时单独存入）
                      fontScope: fontScopeDraft,
                      fontSize:
                        Number.isFinite(fontSizeDraft) && fontSizeDraft !== 14
                          ? Math.min(20, Math.max(10, fontSizeDraft))
                          : undefined,
                    };
                    setCurrentScript(updated);
                    saveOrUpdateEnsembleScript(updated);
                    setScripts(loadEnsembleScripts());
                    // 应用 = 功能键完成 → 关掉本层，停在功能面板
                    setShowCssSheet(false);
                    setShowToolsSheet(true);
                    setToast("自定义 CSS 已生效");
                  }}
                  className="flex-1 py-3 rounded-[16px] bg-[#111111] text-[13px] font-semibold text-white active:scale-[0.985] transition-transform"
                >
                  应用
                </button>
              </div>
            </MiniSheet>
          )}

          {/* ═══════════ 子弹窗 3：时间感知（图3 · 1006） ═══════════ */}
          {showTimeSheet && (
            <MiniSheet
              title="时间感知"
              subtitle="TIME AWARENESS"
              onClose={() => {
                setShowTimeSheet(false);
                setShowToolsSheet(true);
              }}
            >
              <div className="bg-white rounded-[16px] p-4 space-y-4">
                <StatusToggleRow
                  label="感知现实时间"
                  hint="让 AI 知道此刻的真实年月日与钟点"
                  checked={timeEnabledDraft}
                  onChange={setTimeEnabledDraft}
                />

                {/* 开关语义（1006 第四次反馈·W1 定稿）：
                      · ON  感知现实时间 → 只有开关，**不出现任何时间选择界面**
                      · OFF 架空时间     → 出现架空起点输入，保存即生效
                    此前实现做反了：ON 时仍显示锚点区、且需额外点「改用架空起点」
                    才切换模式。现直接由开关 ON/OFF 决定 realtime。 */}
                {!timeEnabledDraft && (
                  <div className="space-y-2">
                    <div className="text-[11px] text-black/45 leading-relaxed">
                      已关闭「感知现实时间」→ 剧情时间架空。填写一个起点，时间会从
                      这个点起随现实自然流逝。保存即生效。
                    </div>
                    {/* W1（第二版 · 用户实机复验后返工）：
                        原生 datetime-local 控件在移动端点起来很麻烦（用户："使用不方便，
                        改直接输入"）。改为**手动文本输入**，并明确格式，AI 好识别。
                        解析时容忍常见分隔符（- / . 年月日 空格 时:分）。 */}
                    <input
                      type="text"
                      inputMode="numeric"
                      value={timeAnchorDraft}
                      onChange={(e) => setTimeAnchorDraft(e.target.value)}
                      placeholder="2015-03-29 15:54"
                      spellCheck={false}
                      className="w-full bg-black/[0.03] border border-black/[0.07] rounded-[12px] px-3 py-3 font-mono text-[13px] text-[#111111] placeholder:text-black/25 outline-none focus:border-black/25"
                    />
                    <div className="text-[11px] text-black/35 leading-relaxed">
                      格式：<span className="font-mono">YYYY-MM-DD HH:mm</span>
                      （例 <span className="font-mono">2015-03-29 15:54</span>），24 小时制。
                    </div>
                    {timeAnchorDraft.trim() && !isValidTimeAnchor(timeAnchorDraft) && (
                      <div className="text-[11px] text-[#c0392b] leading-relaxed">
                        格式无法识别，请按 <span className="font-mono">YYYY-MM-DD HH:mm</span> 填写。
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    setShowTimeSheet(false);
                    setShowToolsSheet(true);
                  }}
                  className="flex-1 py-3 rounded-[16px] bg-white text-[13px] font-medium text-black/55 active:scale-[0.985] transition-transform"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => {
                    // W1：架空模式下起点必填且格式必须可识别（否则时间感知形同虚设）
                    const anchor =
                      timeEnabledDraft || !timeAnchorDraft.trim()
                        ? undefined
                        : normalizeTimeAnchor(timeAnchorDraft);
                    if (!timeEnabledDraft && timeAnchorDraft.trim() && !anchor) {
                      setToast(
                        "架空起点格式不对，请按 YYYY-MM-DD HH:mm 填写（例 2015-03-29 15:54）"
                      );
                      return;
                    }
                    const updated: EnsembleScript = {
                      ...currentScript,
                      timeAwareness: {
                        // W1 定稿：enabled = 是否启用时间感知；
                        // realtime 直接由开关决定 ——
                        //   ON  → 跟随现实时间（realtime=true，无时间界面）
                        //   OFF → 架空时间（realtime=false，用 anchor）
                        enabled: timeEnabledDraft,
                        realtime: timeEnabledDraft,
                        anchor: anchor ?? undefined,
                      },
                    };
                    setCurrentScript(updated);
                    saveOrUpdateEnsembleScript(updated);
                    setScripts(loadEnsembleScripts());
                    setShowTimeSheet(false);
                    setShowToolsSheet(true);
                    setToast("时间感知已保存 · 下一轮生效");
                  }}
                  className="flex-1 py-3 rounded-[16px] bg-[#111111] text-[13px] font-semibold text-white active:scale-[0.985] transition-transform"
                >
                  保存
                </button>
              </div>
            </MiniSheet>
          )}

          {/* ═══════════ 子弹窗 4：状态面板（图 · 1006） ═══════════ */}
          {showStatusSheet && (
            <MiniSheet
              title="状态面板"
              subtitle="STATUS · FULLY CUSTOM"
              onClose={() => {
                setShowStatusSheet(false);
                setShowToolsSheet(true);
              }}
            >
              {/* 启用开关 */}
              <div className="bg-white rounded-[16px] p-4">
                <StatusToggleRow
                  label="启用状态面板"
                  hint="开启后 AI 按字段表为每个角色生成数据，点头像查看"
                  checked={statusEnabledDraft}
                  onChange={setStatusEnabledDraft}
                />
              </div>

              {/* ① 字段 / DATA */}
              <div className="bg-white rounded-[16px] p-4">
                <StatusSectionHead
                  num="①"
                  label="字段 / DATA"
                  labelEn="FIELDS"
                  right={
                    <span className="text-[11px] text-black/30">
                      你定数据 · AI 照填
                    </span>
                  }
                />
                <div className="text-[11px] text-black/45 leading-relaxed mb-3">
                  key 给模板取值{"{​{key}}"} 用；说明是给 AI 看的话；字数是软上限（留空不限）。
                  0-100 的数字字段可在模板里用{" "}
                  <span className="font-mono text-black/60">{"{{key.bar}}"}</span>{" "}
                  渲染进度条。
                </div>
                <StatusFieldEditor
                  fields={statusFieldsDraft}
                  onChange={setStatusFieldsDraft}
                />
                <div className="mt-3">
                  <StatusFieldActions
                    onAdd={() =>
                      setStatusFieldsDraft((v) => [
                        ...v,
                        { key: "", desc: "", max: undefined },
                      ])
                    }
                    onReset={() => setStatusFieldsDraft(DEFAULT_STATUS_FIELDS)}
                  />
                </div>
              </div>

              {/* ② 模板 / TEMPLATE */}
              <div className="bg-white rounded-[16px] p-4">
                {/* 1007 用户口径：两个按键「从模板生成字段 / 默认模板」**从标题右侧
                    移到代码框下方**（原来挤在头部右侧，小屏会折行、还顶到标题）。
                    新顺序：标题 → 说明 → 代码框 → 两个按键。 */}
                <StatusSectionHead
                  num="②"
                  label="模板 / TEMPLATE"
                  labelEn="HTML · CSS · JS"
                />
                <div
                  className="text-black/45 mb-2.5"
                  style={{ fontSize: TYPE.MICRO, lineHeight: LEADING.SUB }}
                >
                  把搓好的状态栏模板整段贴进来，点「从模板生成字段」自动反解
                  <span className="font-mono text-black/60"> {"{{字段}}"} </span>
                  或
                  <span className="font-mono text-black/60"> $1 $2 </span>
                  。只需补一句「给 AI 的说明」。
                </div>
                <StatusTemplateEditor
                  fields={statusFieldsDraft}
                  template={statusTemplateDraft}
                  onChange={setStatusTemplateDraft}
                />
                {/* 代码框**下方**的操作行（1007 重排） */}
                <div className="flex items-center gap-2 mt-2.5">
                  <StatusGenerateFromTemplateBtn
                    onClick={() => {
                      const extracted = extractFieldsFromTemplate(statusTemplateDraft);
                      if (extracted.length === 0) {
                        setToast("模板里没有可识别的 {{字段}} / $1 $2");
                        return;
                      }
                      const byKey = new Map(statusFieldsDraft.map((f) => [f.key.trim(), f]));
                      setStatusFieldsDraft(
                        extracted.map((f) => {
                          const prev = byKey.get(f.key);
                          return prev
                            ? { ...prev, key: f.key }
                            : { key: f.key, desc: "", max: undefined };
                        })
                      );
                      setToast(`已从模板生成 ${extracted.length} 个字段 · 请补「给 AI 的说明」`);
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setStatusTemplateDraft(DEFAULT_STATUS_TEMPLATE)}
                    className="px-2.5 py-1 rounded-[7px] text-black/55 bg-black/[0.05] font-medium active:scale-95 transition-transform shrink-0"
                    style={{ fontSize: TYPE.MICRO }}
                  >
                    默认模板
                  </button>
                </div>
              </div>

              {/* ③ 预览 / LIVE —— 沙箱示例数据，按 float 口径实渲染 */}
              <div className="bg-white rounded-[16px] p-4">
                <StatusSectionHead
                  num="③"
                  label="预览 / LIVE"
                  labelEn="SANDBOX"
                  right={
                    <span className="text-[11px] text-black/30">沙箱 · 示例数据</span>
                  }
                />
                <StatusLivePreview
                  template={statusTemplateDraft}
                  fields={statusFieldsDraft}
                />
              </div>

              {/* 底部按钮 */}
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    setShowStatusSheet(false);
                    setShowToolsSheet(true);
                  }}
                  className="flex-1 py-3 rounded-[16px] bg-white text-[13px] font-medium text-black/55 active:scale-[0.985] transition-transform"
                >
                  关闭
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const updated: EnsembleScript = {
                      ...currentScript,
                      statusPanel: {
                        enabled: statusEnabledDraft,
                        fields: statusFieldsDraft.filter((f) => f.key.trim()),
                        template: statusTemplateDraft,
                        engine: "html",
                      },
                    };
                    setCurrentScript(updated);
                    saveOrUpdateEnsembleScript(updated);
                    setScripts(loadEnsembleScripts());
                    setShowStatusSheet(false);
                    setShowToolsSheet(true);
                    setToast("状态面板已保存 · 下一轮生效");
                  }}
                  className="flex-1 py-3 rounded-[16px] bg-[#111111] text-[13px] font-semibold text-white active:scale-[0.985] transition-transform"
                >
                  保存
                </button>
              </div>
            </MiniSheet>
          )}

          {/* ═══════════ 子弹窗 5：世界书绑定（2026-10-09 M2-b） ═══════════
              群像此前完全没接入世界书，本面板让它「选要绑哪几本」。
              · 只存 id 引用（worldBookIds），内容实时从「设置 → 世界书」读，避免快照过期。
              · 未勾选任何 = 不注入（等价于关闭）。
              · 条目级的 constant / 关键词 / sticky 逻辑由 lib/ensemble-worldbook.ts 处理，本面板不涉及。 */}
          {wrapConfirm && (
            <MiniSheet
              title="杀青前确认"
              subtitle="WRAP · 有未归入的聊天"
              onClose={() => setWrapConfirm(null)}
            >
              <div className="bg-white rounded-[16px] p-4 space-y-2">
                <div className="text-[12px] leading-relaxed text-black/70">
                  还有 {getPendingSessions(currentScript?.id).length} 段聊天没有点「返回剧情」。
                </div>
                <div className="text-[11px] leading-relaxed text-black/45">
                  一起注入 → 这些聊天会作为剧情的一部分被自然总结进档案。
                  <br />
                  不注入 → 直接杀青，并在档案末尾标注缺失的时间段。
                </div>
              </div>
              <div className="bg-white rounded-[16px] p-2">
                <button
                  type="button"
                  className="w-full flex items-center justify-between gap-3 px-3 py-3"
                  onClick={() => {
                    const c = wrapConfirm.count;
                    setWrapConfirm(null);
                    void handleWrap(c, true, false);
                  }}
                >
                  <span className="flex flex-col items-start">
                    <span className="text-[13px] text-black/80">一起注入并总结</span>
                    <span className="text-[11px] text-black/40">推荐 · 剧情更连贯</span>
                  </span>
                  <ChevronRight size={14} className="text-black/25" />
                </button>
                <div className="h-px bg-black/5 mx-3" />
                <button
                  type="button"
                  className="w-full flex items-center justify-between gap-3 px-3 py-3"
                  onClick={() => {
                    const c = wrapConfirm.count;
                    setWrapConfirm(null);
                    void handleWrap(c, false, true);
                  }}
                >
                  <span className="flex flex-col items-start">
                    <span className="text-[13px] text-black/70">跳过，直接杀青</span>
                    <span className="text-[11px] text-black/40">档案末尾会标注缺失时间段</span>
                  </span>
                  <ChevronRight size={14} className="text-black/25" />
                </button>
              </div>
            </MiniSheet>
          )}

          {deliverPicker && (
            <MiniSheet
              title={deliverTargetStage ? "投到哪里" : "选一句作为起点"}
              subtitle={deliverTargetStage ? "DELIVER · 选择落点" : "DELIVER · 只发这一句"}
              onClose={() => {
                if (deliverTargetStage) {
                  setDeliverTargetStage(false);
                  return;
                }
                setDeliverPicker(null);
                setDeliverLine(null);
                setDeliverTargetStage(false);
              }}
            >
              {!deliverTargetStage ? (
                <>
                  <div className="px-1 pb-1 text-[11px] leading-relaxed text-black/45">
                    下面是从这一幕里抽出的对白（旁白、动作、心理已经去掉）。选一句，投到聊天室当第一条微信消息。
                  </div>
                  <div className="bg-white rounded-[16px] overflow-hidden max-h-[46vh] overflow-y-auto">
                    {deliverPicker.lines.map((line, idx) => {
                      const active = deliverLine?.text === line.text && deliverLine?.speaker === line.speaker;
                      return (
                        <button
                          key={`${idx}-${line.text.slice(0, 12)}`}
                          type="button"
                          className="w-full text-left px-4 py-3 flex items-start gap-3"
                          style={active ? { background: "rgba(0,0,0,0.04)" } : undefined}
                          onClick={() => setDeliverLine(line)}
                        >
                          <span
                            className="shrink-0 mt-[3px] w-4 h-4 rounded-full flex items-center justify-center"
                            style={{
                              border: active ? "none" : "1px solid var(--c-card-border, rgba(0,0,0,0.18))",
                              background: active ? "var(--c-icon-active)" : "transparent",
                            }}
                          >
                            {active && <Check size={11} color="#fff" strokeWidth={3} />}
                          </span>
                          <span className="flex-1 min-w-0">
                            {line.speaker && (
                              <span className="block text-[10px] text-black/35 mb-[2px]">{line.speaker}</span>
                            )}
                            <span className="block text-[13px] leading-relaxed text-black/80 whitespace-pre-wrap break-words">
                              {line.text}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    className="mt-1 w-full rounded-[16px] py-3 text-[13px] font-medium"
                    style={{
                      background: deliverLine ? "var(--c-icon-active)" : "var(--c-card-border)",
                      color: deliverLine ? "#fff" : "var(--c-text-tertiary, rgba(0,0,0,0.35))",
                    }}
                    disabled={!deliverLine}
                    onClick={() => setDeliverTargetStage(true)}
                  >
                    下一步
                  </button>
                </>
              ) : (
                <>
                  <div className="bg-white rounded-[16px] p-4">
                    <div className="text-[10px] text-black/40 mb-1">
                      {resolveSpeaker(deliverPicker.member, deliverLine).name} · 将发送这一句
                    </div>
                    <div className="text-[13px] leading-relaxed text-black/80 max-h-[110px] overflow-y-auto whitespace-pre-wrap">
                      {deliverLine?.text}
                    </div>
                  </div>
                  <div className="bg-white rounded-[16px] p-2">
                    <button
                      type="button"
                      className="w-full flex items-center justify-between gap-3 px-3 py-3"
                      onClick={() => {
                        doDeliverToChat(
                          deliverPicker.turn,
                          deliverPicker.member,
                          {
                            kind: "direct",
                            characterId: resolveSpeaker(deliverPicker.member, deliverLine).id,
                          },
                          deliverLine?.text ?? undefined,
                          deliverLine,
                        );
                      }}
                    >
                      <span className="flex flex-col items-start">
                        <span className="text-[13px] text-black/80">投到单聊</span>
                        <span className="text-[11px] text-black/40">
                          只给 {resolveSpeaker(deliverPicker.member, deliverLine).name}
                        </span>
                      </span>
                      <ChevronRight size={14} className="text-black/25" />
                    </button>
                    {currentScript && currentScript.cast.length > 1 && (
                      <>
                        <div className="h-px bg-black/5 mx-3" />
                        <button
                          type="button"
                          className="w-full flex items-center justify-between gap-3 px-3 py-3"
                          onClick={() => {
                            doDeliverToChat(
                              deliverPicker.turn,
                              deliverPicker.member,
                              {
                                kind: "group",
                                participantIds: currentScript.cast.map(c => c.id),
                              },
                              deliverLine?.text ?? undefined,
                              deliverLine,
                            );
                          }}
                        >
                          <span className="flex flex-col items-start">
                            <span className="text-[13px] text-black/80">投到群聊</span>
                            <span className="text-[11px] text-black/40">剧本全员群（自动创建或复用）</span>
                          </span>
                          <ChevronRight size={14} className="text-black/25" />
                        </button>
                      </>
                    )}
                  </div>
                  <div className="px-1 text-[11px] leading-relaxed text-black/45">
                    投出去会自动跳到那个聊天室。聊完长按任意一句 →【返回剧情】，这段就归入本剧本。
                  </div>
                </>
              )}
            </MiniSheet>
          )}

          {showStoryboardSheet && currentScript && (
            <MiniSheet
              title="分镜配图"
              subtitle="STORYBOARD · 横版场景图"
              onClose={() => {
                setShowStoryboardSheet(false);
                setShowToolsSheet(true);
              }}
            >
              <div className="bg-white rounded-[16px] p-4">
                <div className="text-[11px] leading-relaxed text-black/45">
                  开启后，<span className="text-black/70 font-medium">下一轮</span>剧情开始，每轮自动生成一张横版场景图。
                  <br />· 已生成过的图不会被修改或删除；
                  <br />· 需要先在「设置 → 生图」总开关打开，并允许「群像」生图；
                  <br />· 生成失败不影响剧情，只是这一轮没有配图。
                </div>
              </div>

              <div className="bg-white rounded-[16px] p-2">
                <div className="flex items-center justify-between gap-3 px-3 py-3">
                  <div className="flex flex-col">
                    <span className="text-[13px] font-medium text-black/80">开启分镜配图</span>
                    <span className="text-[11px] text-black/40">从下一轮开始生效</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const nextScript = {
                        ...currentScript,
                        storyboardEnabled: !currentScript.storyboardEnabled,
                      };
                      saveOrUpdateEnsembleScript(nextScript);
                      setCurrentScript(nextScript);
                      setScripts(loadEnsembleScripts());
                    }}
                    className={`w-[46px] h-[27px] rounded-full shrink-0 transition-colors relative ${
                      currentScript.storyboardEnabled ? "bg-[#BDD4E3]" : "bg-black/15"
                    }`}
                    aria-pressed={!!currentScript.storyboardEnabled}
                  >
                    <span
                      className={`absolute top-[3px] w-[21px] h-[21px] rounded-full bg-white shadow transition-all ${
                        currentScript.storyboardEnabled ? "left-[22px]" : "left-[3px]"
                      }`}
                    />
                  </button>
                </div>

                <div className="px-3 pb-3">
                  <div className="text-[11px] font-medium text-black/45 mb-1.5">额外画风要求（可留空）</div>
                  <textarea
                    className="w-full min-h-[70px] rounded-[12px] bg-black/[0.04] px-3 py-2 text-[12px] outline-none resize-y"
                    placeholder="如 油画质感, 暖色调, 浅景深"
                    value={currentScript.storyboardPrompt ?? ""}
                    onChange={(event) => {
                      const nextScript = { ...currentScript, storyboardPrompt: event.target.value };
                      setCurrentScript(nextScript);
                      saveOrUpdateEnsembleScript(nextScript);
                    }}
                  />
                </div>
              </div>
            </MiniSheet>
          )}

          {showWorldBookSheet && (() => {
            const allBooks = loadWorldBooks();
            return (
              <MiniSheet
                title="世界书"
                subtitle="WORLD BOOK · MEMORY"
                onClose={() => {
                  setShowWorldBookSheet(false);
                  setShowToolsSheet(true);
                }}
              >
                {/* 说明 */}
                <div className="bg-white rounded-[16px] p-4">
                  <div className="text-[11px] leading-relaxed text-black/45">
                    勾选要在本剧本生效的世界书。规则：
                    <br />· <span className="text-black/70 font-medium">常驻条目</span>每轮都注入；
                    <br />· <span className="text-black/70 font-medium">关键词条目</span>正文提到才注入；
                    <br />· 带 <span className="text-black/70 font-medium">sticky</span> 的条目命中后会跟着走几轮（防漏）。
                    <br />不勾选 = 本剧本不读世界书。
                  </div>
                </div>

                {/* 世界书列表 */}
                <div className="bg-white rounded-[16px] p-2">
                  {allBooks.length === 0 ? (
                    <div className="px-3 py-6 text-center text-[12px] text-black/35">
                      还没有世界书 · 请到「设置 → 世界书」新建
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {allBooks.map((book) => {
                        const checked = worldBookIdsDraft.includes(book.id);
                        const entryCount = book.entries?.length ?? 0;
                        return (
                          <button
                            key={book.id}
                            type="button"
                            onClick={() =>
                              setWorldBookIdsDraft((prev) =>
                                prev.includes(book.id)
                                  ? prev.filter((x) => x !== book.id)
                                  : [...prev, book.id]
                              )
                            }
                            className="w-full flex items-center gap-3 px-3 py-3 rounded-[12px] text-left active:scale-[0.99] transition-transform hover:bg-black/[0.02]"
                          >
                            {/* 勾选框 */}
                            <span
                              className={`w-[20px] h-[20px] rounded-[6px] shrink-0 grid place-items-center border transition-colors ${
                                checked
                                  ? "bg-[#111111] border-[#111111]"
                                  : "bg-white border-black/15"
                              }`}
                            >
                              {checked && (
                                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                                  <path
                                    d="M2.5 6.2L4.8 8.5L9.5 3.8"
                                    stroke="white"
                                    strokeWidth="1.8"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  />
                                </svg>
                              )}
                            </span>
                            <span className="flex-1 min-w-0">
                              <span className="block text-[13px] font-medium text-[#111111] truncate">
                                {book.name}
                              </span>
                              <span className="block text-[10px] text-black/35 mt-0.5 truncate">
                                {entryCount} 条{book.description ? ` · ${book.description}` : ""}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* 底部按钮 */}
                <div className="flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => {
                      setShowWorldBookSheet(false);
                      setShowWorldBookLogSheet(true);
                    }}
                    className="py-3 px-4 rounded-[16px] bg-white text-[13px] font-medium text-black/55 active:scale-[0.985] transition-transform"
                  >
                    触发日志
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowWorldBookSheet(false);
                      setShowToolsSheet(true);
                    }}
                    className="flex-1 py-3 rounded-[16px] bg-white text-[13px] font-medium text-black/55 active:scale-[0.985] transition-transform"
                  >
                    关闭
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const updated: EnsembleScript = {
                        ...currentScript,
                        worldBookIds: worldBookIdsDraft,
                      };
                      setCurrentScript(updated);
                      saveOrUpdateEnsembleScript(updated);
                      setScripts(loadEnsembleScripts());
                      setShowWorldBookSheet(false);
                      setShowToolsSheet(true);
                      setToast(
                        worldBookIdsDraft.length
                          ? `已绑定 ${worldBookIdsDraft.length} 本世界书 · 下一轮生效`
                          : "已清空世界书绑定"
                      );
                    }}
                    className="flex-1 py-3 rounded-[16px] bg-[#111111] text-[13px] font-semibold text-white active:scale-[0.985] transition-transform"
                  >
                    保存
                  </button>
                </div>
              </MiniSheet>
            );
          })()}

          {/* ═══════════ 子弹窗 6：世界书触发日志（2026-10-09 M2-a） ═══════════
              方案第八节：每轮生成后显示「本轮命中：N 条 / 未命中：M 条」，
              逐条列出条目名 + 触发方式（常驻/关键词/粘性）+ 触发词。
              目的：治「怕漏」——不用猜 AI 到底翻出了哪条设定。
              ⚠️ 付费小手机的记忆库也没这个（用户反馈「不知道它提取了哪条」），此处做得更透明。 */}
          {showWorldBookLogSheet && (() => {
            const log = worldBookLog;
            const SOURCE_LABEL: Record<string, { text: string; cls: string }> = {
              constant: { text: "常驻", cls: "bg-[#111111] text-white" },
              keyword: { text: "关键词", cls: "bg-[#111111]/10 text-[#111111]" },
              sticky: { text: "粘性驻留", cls: "bg-amber-100 text-amber-700" },
            };
            return (
              <MiniSheet
                title="触发日志"
                subtitle="WORLD BOOK · TRIGGER LOG"
                onClose={() => {
                  setShowWorldBookLogSheet(false);
                  setShowToolsSheet(true);
                }}
              >
                {/* ── 护栏诊断（2026-10-11）──
                    放在最上面：用户最关心的「这一轮有没有被卡住」一眼可见。

                    ⚠️ 判定门槛（2026-10-11 二修）：初版把「字数 > 上界」直接判成
                    「超出上界 · 护栏未起作用」，实测会误报——两轮实测分别是
                    479/450（+6.4%）与 792/750（+5.6%），结束原因都是 stop，
                    属于模型对字数的正常软性波动，不是护栏失效。

                    正确的判据顺序（先看硬证据，再看软指标）：
                      1. finishReason=length → 被闸门截断，护栏**真生效** ✅
                      2. 实际 token 远超发出值 → 中转忽略了参数 ⚠️
                      3. 没带 max_tokens        → 本地就没发 🔴
                      4. stop + 轻微超标        → 正常波动（软提示，不报警）
                      5. stop + 超标 ≥50%       → 才是护栏真没起作用 ⚠️
                    上界 = 目标 + 150 字，那 150 是「收尾余量」不是「容错空间」，
                    所以轻微超出属预期内，不该占一个警告位。 */}
                {guardrailLog && (() => {
                  const g = guardrailLog;
                  const overshoot = g.maxChars > 0 ? (g.contentChars - g.maxChars) / g.maxChars : 0;
                  const sentNull = g.sentMaxTokens === null;
                  const truncated = g.finishReason === "length"
                    || g.finishReason === "max_tokens"
                    || g.finishReason === "max_output_tokens"
                    || g.finishReason === "max_completion_tokens"
                    || g.finishReason === "max_tokens_reached";
                  const exceededSent = g.sentMaxTokens !== null
                    && g.completionTokens !== null
                    && g.completionTokens > g.sentMaxTokens * 1.05;
                  // 只在「停止原因正常、却大幅超出」时才算护栏失效；±20% 内视为波动。
                  const reallyOver = !truncated && overshoot > 0.5;
                  const slightlyOver = !truncated && overshoot > 0.2 && !reallyOver;
                  const state = sentNull
                    ? { label: "未发出", cls: "bg-red-50 text-red-600", hint: "本地没有把 max_tokens 写进请求体，护栏完全没生效。" }
                    : exceededSent
                    ? { label: "被忽略", cls: "bg-amber-50 text-amber-700", hint: "实际用量超过发出值，中转或供应商忽略了 max_tokens。" }
                    : truncated
                    ? { label: "已卡住", cls: "bg-emerald-50 text-emerald-700", hint: "被长度上限截断，护栏按预期生效。" }
                    : reallyOver
                    ? { label: "护栏失效", cls: "bg-red-50 text-red-600", hint: `模型自行收尾却仍超出上界 ${Math.round(overshoot * 100)}%，护栏基本没起作用，建议收紧提示词里的字数要求。` }
                    : slightlyOver
                    ? { label: "略超", cls: "bg-black/[0.05] text-black/45", hint: `超出上界 ${Math.round(overshoot * 100)}%，模型自行收尾（stop），属正常波动。` }
                    : { label: "正常", cls: "bg-emerald-50 text-emerald-700", hint: "字数在上界内，模型自行收尾，未触顶。" };
                  return (
                    <div className="bg-white rounded-[16px] p-4">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-black/35 tracking-wide">护栏</span>
                        <span className={`px-2 py-[3px] rounded-[6px] text-[10px] font-semibold ${state.cls}`}>
                          {state.label}
                        </span>
                      </div>
                      <div className="mt-2.5 grid grid-cols-2 gap-y-1.5 text-[11px]">
                        <span className="text-black/35">本轮字数</span>
                        <span className="font-mono tabular-nums text-right text-[#111111]">
                          {g.contentChars}
                          <span className="text-black/30">
                            {" "}/ 目标 {g.targetChars} · 上界 {g.maxChars}
                          </span>
                        </span>
                        <span className="text-black/35">发出上限</span>
                        <span className="font-mono tabular-nums text-right text-[#111111]">
                          {g.sentMaxTokens === null ? "未传" : `${g.sentMaxTokens} token`}
                        </span>
                        <span className="text-black/35">实际用量</span>
                        <span className="font-mono tabular-nums text-right text-[#111111]">
                          {g.completionTokens === null ? "未回报" : `${g.completionTokens} token`}
                        </span>
                        <span className="text-black/35">结束原因</span>
                        <span className="font-mono text-right text-[#111111]">
                          {g.finishReason ?? "未返回"}
                        </span>
                        <span className="text-black/35">轮次</span>
                        <span className="font-mono tabular-nums text-right text-black/40">
                          第 {g.turnIndex} 轮
                        </span>
                      </div>
                      <div className="mt-2.5 text-[10px] text-black/30 leading-relaxed">
                        {state.hint}
                      </div>
                    </div>
                  );
                })()}

                {/* 概览 */}
                <div className="bg-white rounded-[16px] p-4">
                  {!log ? (
                    <div className="text-[12px] text-black/40 leading-relaxed py-2 text-center">
                      还没有生成过 · 跑一幕后再来看这里
                      <br />
                      <span className="text-black/28 text-[11px]">本面板记录「这一轮翻出了哪几条设定」</span>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-baseline justify-between">
                        <span className="text-[11px] text-black/35 tracking-wide">本轮命中</span>
                        <span className="font-mono tabular-nums text-[13px] text-[#111111] font-semibold">
                          {log.hits.length} / {log.scannedCount}
                        </span>
                      </div>
                      <div className="mt-2 h-[3px] rounded-full bg-black/[0.06] overflow-hidden">
                        <div
                          className="h-full bg-[#111111] transition-all"
                          style={{
                            width: log.scannedCount
                              ? `${Math.round((log.hits.length / log.scannedCount) * 100)}%`
                              : "0%",
                          }}
                        />
                      </div>
                      <div className="mt-2 text-[10px] text-black/30 font-mono">
                        第 {log.turnIndex} 轮 · 扫描 {log.scannedCount} 条 · 未命中 {log.misses.length} 条
                      </div>
                    </>
                  )}
                </div>

                {/* 命中列表 */}
                {log && log.hits.length > 0 && (
                  <div className="bg-white rounded-[16px] p-2">
                    <div className="px-3 pt-2 pb-1 text-[10px] text-black/30 tracking-[0.15em]">HIT · 已注入</div>
                    <div className="space-y-1">
                      {log.hits.map((h, i) => {
                        const sl = SOURCE_LABEL[h.source] ?? SOURCE_LABEL.keyword;
                        return (
                          <div
                            key={`${h.uid}-${h.source}-${i}`}
                            className="flex items-start gap-2.5 px-3 py-2.5 rounded-[12px] hover:bg-black/[0.02]"
                          >
                            <span
                              className={`shrink-0 mt-[2px] px-1.5 py-[2px] rounded-[5px] text-[9px] font-medium ${sl.cls}`}
                            >
                              {sl.text}
                            </span>
                            <span className="flex-1 min-w-0">
                              <span className="block text-[12px] text-[#111111] truncate">{h.comment}</span>
                              <span className="block text-[10px] text-black/30 mt-0.5 truncate">
                                {h.bookName}
                                {h.matchedKey ? ` · 命中「${h.matchedKey}」` : ""}
                              </span>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* 未命中列表 */}
                {log && log.misses.length > 0 && (
                  <div className="bg-white rounded-[16px] p-2">
                    <div className="px-3 pt-2 pb-1 text-[10px] text-black/30 tracking-[0.15em]">MISS · 未触发</div>
                    <div className="space-y-1">
                      {log.misses.map((m, i) => (
                        <div
                          key={`${m.uid}-${i}`}
                          className="flex items-start gap-2.5 px-3 py-2.5 rounded-[12px] hover:bg-black/[0.02]"
                        >
                          <span className="shrink-0 mt-[2px] px-1.5 py-[2px] rounded-[5px] text-[9px] font-medium bg-black/[0.05] text-black/35">
                            未中
                          </span>
                          <span className="flex-1 min-w-0">
                            <span className="block text-[12px] text-black/50 truncate">{m.comment}</span>
                            <span className="block text-[10px] text-black/25 mt-0.5 truncate">{m.bookName}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ── 记忆库 · 线上互通（2026-10-09 M1）──
                    与触发日志同面板：世界书看「翻了哪条设定」，这里看「用了谁的记忆」。
                    直击用户痛点：付费小手机的记忆库不显示提取了哪条 → 此处逐条列出。 */}
                <div className="bg-white rounded-[16px] p-2">
                  <div className="px-3 pt-2 pb-1 text-[10px] text-black/30 tracking-[0.15em]">
                    MEMORY · 线上互通记忆
                  </div>
                  {!memoryLog || !memoryLog.enabled ? (
                    <div className="px-3 py-4 text-center text-[11px] text-black/30 leading-relaxed">
                      {memoryLog && !memoryLog.enabled
                        ? "线上互通已关闭 · 本幕未读取记忆库"
                        : "还没有生成过 · 开启「线上互通」后跑一幕再看"}
                    </div>
                  ) : memoryLog.totalCount === 0 ? (
                    <div className="px-3 py-4 text-center text-[11px] text-black/30 leading-relaxed">
                      本幕未命中任何记忆
                      <br />
                      <span className="text-black/22 text-[10px]">（该角色在单聊里还没有相关记忆）</span>
                    </div>
                  ) : (
                    <>
                      <div className="px-3 pb-2 flex items-baseline justify-between">
                        <span className="text-[11px] text-black/35 tracking-wide">命中角色</span>
                        <span className="font-mono tabular-nums text-[13px] text-[#111111] font-semibold">
                          {memoryLog.roleCount} 人 · {memoryLog.totalCount} 条
                        </span>
                      </div>
                      <div className="space-y-1">
                        {memoryLog.blocks.map((b) => (
                          <div
                            key={b.characterId}
                            className="px-3 py-2.5 rounded-[12px] hover:bg-black/[0.02]"
                          >
                            <div className="flex items-center gap-2">
                              <span className="shrink-0 px-1.5 py-[2px] rounded-[5px] text-[9px] font-medium bg-[#111111] text-white">
                                归属
                              </span>
                              <span className="flex-1 min-w-0 text-[12px] text-[#111111] font-medium truncate">
                                {b.name}
                              </span>
                              <span className="shrink-0 text-[10px] text-black/30 font-mono tabular-nums">
                                核心 {b.core.length} · 长期 {b.longTerm.length}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>

                {/* 底部 */}
                <button
                  type="button"
                  onClick={() => {
                    setShowWorldBookLogSheet(false);
                    setShowToolsSheet(true);
                  }}
                  className="w-full py-3 rounded-[16px] bg-white text-[13px] font-medium text-black/55 active:scale-[0.985] transition-transform"
                >
                  关闭
                </button>
              </MiniSheet>
            );
          })()}

          {/* ═══════════ 子弹窗 7：杀青归档（2026-10-10） ═══════════
              把「已发生的剧情」用 AI 总结成档案，之后老剧情对 AI 隐藏（真删），靠归档回忆。
              布局照 chill 截图：三栏统计 → 杀青操作区 → 档案预览/编辑 → 底部两按钮。
              · 统计/待杀青/已杀青全部来自 lib/ensemble-archive.ts（纯增量，不碰现有常驻逻辑）。
              · 字号写死 px，不随全局缩放。 */}
          {showArchiveSheet && (
            <MiniSheet
              title="杀青归档"
              subtitle="WRAP · INCREMENTAL ARCHIVE"
              onClose={() => {
                // 关闭回功能面板，与本文件其他子弹窗保持一致
                setShowArchiveSheet(false);
                setShowToolsSheet(true);
              }}
            >
              {/* ── 三栏统计卡片 ── */}
              <div className="flex items-stretch gap-2.5">
                {/* 总条数 */}
                <div className="flex-1 bg-white rounded-[16px] px-3 py-3.5 text-center">
                  <div className="font-mono tabular-nums text-[16px] font-semibold text-[#111111] leading-none">
                    {archiveStats.total}
                  </div>
                  <div className="text-[10px] text-black/35 mt-2 tracking-wide">
                    总条数
                  </div>
                </div>
                {/* 已杀青 */}
                <div className="flex-1 bg-white rounded-[16px] px-3 py-3.5 text-center">
                  <div className="font-mono tabular-nums text-[16px] font-semibold text-[#111111] leading-none">
                    {archiveStats.wrapped}
                  </div>
                  <div className="text-[10px] text-black/35 mt-2 tracking-wide">
                    已杀青
                  </div>
                </div>
                {/* 未杀青（深色底黑字高亮，对比另外两个） */}
                <div className="flex-1 bg-[#111111] rounded-[16px] px-3 py-3.5 text-center">
                  <div className="font-mono tabular-nums text-[16px] font-semibold text-white leading-none">
                    {archiveStats.pending}
                  </div>
                  <div className="text-[10px] text-white/60 mt-2 tracking-wide">
                    未杀青
                  </div>
                </div>
              </div>

              {/* ── 杀青操作区 ── */}
              <div className="bg-white rounded-[16px] p-3.5 space-y-2.5">
                <div className="text-[12px] font-medium text-[#111111]">
                  杀青最近未归档的前 N 条
                </div>
                {/* N 输入 + 全部 */}
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    value={archiveCountDraft}
                    onChange={(e) => setArchiveCountDraft(Number(e.target.value) || 1)}
                    className="w-[92px] bg-black/[0.03] border border-black/5 rounded-xl px-3 py-2 text-[13px] font-mono text-[#111111] outline-none focus:border-black/20"
                  />
                  <button
                    type="button"
                    onClick={() => setArchiveCountDraft(archiveStats.pending)}
                    className="px-3 py-2 rounded-full bg-black/[0.05] text-[11px] font-medium text-black/60 active:scale-95 transition-transform"
                  >
                    全部
                  </button>
                </div>
                {/* 主按钮：提炼并杀青 */}
                <button
                  type="button"
                  disabled={archiveBusy}
                  onClick={() => handleWrap(archiveCountDraft)}
                  className="w-full py-3 rounded-[16px] bg-[#111111] text-[13px] font-semibold text-white active:scale-[0.985] transition-transform disabled:opacity-45 disabled:active:scale-100"
                >
                  {archiveBusy ? "总结中…" : "提炼并杀青"}
                </button>
                {/* 次按钮：撤销上次杀青 */}
                <button
                  type="button"
                  disabled={archiveBusy}
                  onClick={() => handleUndoWrap()}
                  className="w-full py-2.5 rounded-[16px] bg-black/[0.04] text-[12px] font-medium text-black/55 active:scale-[0.985] transition-transform disabled:opacity-45 disabled:active:scale-100"
                >
                  ↩ 撤销上次杀青（换个模型重来）
                </button>
                {/* 错误提示 */}
                {archiveError ? (
                  <div className="text-[11px] leading-relaxed text-red-500 break-words">
                    {archiveError}
                  </div>
                ) : null}
              </div>

              {/* ── 档案预览 / 编辑区 ── */}
              <div className="bg-white rounded-[16px] p-3.5 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-medium text-[#111111]">
                    剧情档案
                  </span>
                  <span className="px-1.5 py-[2px] rounded-[5px] text-[9px] font-medium bg-black/[0.05] text-black/40">
                    可编辑
                  </span>
                </div>
                <textarea
                  value={archiveContentDraft}
                  onChange={(e) => setArchiveContentDraft(e.target.value)}
                  spellCheck={false}
                  placeholder={`/* 杀青后生成/回填的剧情档案 · 可手动改写 */\n\n   ## 剧情档案\n   · ……`}
                  className="w-full min-h-[220px] bg-black/[0.03] border border-black/5 rounded-xl p-3 text-[11px] font-mono text-[#111111] placeholder:text-black/25 outline-none focus:border-black/20 resize-y leading-relaxed"
                />
              </div>

              {(() => {
                // 常驻显示：即使 0 段也露出来，方便一眼确认「都归入了」
                const pending = getPendingSessions(currentScript.id);
                const transcripts = loadSessionTranscript();
                return (
                  <div className="bg-white rounded-[16px] p-3.5 space-y-2">
                    <div className="flex items-center gap-2">
                      <span
                        className="text-[12px] font-medium"
                        style={{ color: pending.length > 0 ? "#c2410c" : "var(--c-text, #111111)" }}
                      >
                        未归入的聊天
                      </span>
                      <span
                        className="px-1.5 py-[2px] rounded-[5px] text-[9px] font-medium"
                        style={
                          pending.length > 0
                            ? { background: "rgba(194,65,12,0.10)", color: "#c2410c" }
                            : { background: "rgba(0,0,0,0.05)", color: "rgba(0,0,0,0.4)" }
                        }
                      >
                        {pending.length} 段
                      </span>
                      {pending.length === 0 && (
                        <span className="text-[10px] text-black/35">全部已归入</span>
                      )}
                    </div>
                    {pending.length > 0 && (
                      <div className="text-[10px] leading-relaxed text-black/40">
                        这些聊天已投递但还没点「返回剧情」。点开可以查看内容，聊完回聊天室长按任意一句返回剧情，或在这里放弃。
                      </div>
                    )}
                    <div className="space-y-1.5">
                      {pending.map((p) => {
                        const messages = transcripts.find(t => t.session.id === p.id)?.messages ?? [];
                        return (
                          <div key={p.id} className="bg-black/[0.03] rounded-xl px-3 py-2">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0 flex-1">
                                <div className="text-[11px] text-black/70">
                                  {p.characterName}
                                  <span className="ml-1.5 text-[10px] text-black/35">
                                    {messages.length > 0 ? `${messages.length} 句` : "尚无消息"}
                                  </span>
                                </div>
                                <div className="text-[10px] text-black/40 truncate">
                                  {new Date(p.startedAt).toLocaleString("zh-CN")} · {p.originContent.slice(0, 24)}…
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => {
                                  discardDeliverySession(p.id);
                                  setCurrentScript({ ...currentScript });
                                  setToast("已放弃这段聊天");
                                }}
                                className="shrink-0 text-[10px] text-black/35 px-2 py-1 rounded-lg bg-black/[0.04]"
                              >
                                放弃
                              </button>
                            </div>
                            {messages.length > 0 ? (
                              <details className="mt-1.5">
                                <summary className="text-[10px] cursor-pointer list-none text-[#c2410c]/80">
                                  点开查看这 {messages.length} 句
                                </summary>
                                <div className="mt-1.5 space-y-1 max-h-[220px] overflow-y-auto pr-1">
                                  {messages.map((m) => (
                                    <div key={m.id} className="text-[11px] leading-relaxed text-black/65">
                                      <span className="text-black/35">
                                        {m.role === "user" ? "我" : m.senderName || p.characterName}：
                                      </span>
                                      <span className="whitespace-pre-wrap break-words">{m.content}</span>
                                    </div>
                                  ))}
                                </div>
                              </details>
                            ) : (
                              <div className="mt-1.5 text-[10px] text-black/35">
                                还没在聊天室里说过话。
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              {/* ── 来自聊天：和剧情档案分开记，避免归档时混淆 ── */}
              {(() => {
                const fromChat = currentScript.turns.filter(
                  (t) => t.senderName === "来自聊天" && t.content?.trim()
                );
                if (fromChat.length === 0) return null;
                return (
                  <div className="bg-white rounded-[16px] p-3.5 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] font-medium text-[#111111]">来自聊天</span>
                      <span className="px-1.5 py-[2px] rounded-[5px] text-[9px] font-medium bg-black/[0.05] text-black/40">
                        {fromChat.length} 段
                      </span>
                    </div>
                    <div className="text-[10px] leading-relaxed text-black/40">
                      这些是你在聊天室里聊出来、再返回剧情的对话。归档时请一并参考，它们和剧情是同一段时间线。
                    </div>
                    <div className="space-y-1.5">
                      {fromChat.map((t) => (
                        <details key={t.id} className="bg-black/[0.03] rounded-xl px-3 py-2">
                          <summary className="text-[11px] text-black/60 cursor-pointer list-none">
                            {t.timestamp ? new Date(t.timestamp).toLocaleString("zh-CN") : "未记录时间"}
                            {" · "}
                            {t.content.split("\n").length - 1} 句
                          </summary>
                          <div className="mt-2 text-[11px] leading-relaxed text-black/70 whitespace-pre-wrap break-words">
                            {t.content}
                          </div>
                        </details>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {/* ── 底部按钮（照 CSS 面板布局） ── */}
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    setShowArchiveSheet(false);
                    setShowToolsSheet(true);
                  }}
                  className="flex-1 py-3 rounded-[16px] bg-white text-[13px] font-medium text-black/55 active:scale-[0.985] transition-transform"
                >
                  关闭
                </button>
                <button
                  type="button"
                  onClick={() => handleSaveArchiveContent()}
                  className="flex-1 py-3 rounded-[16px] bg-[#111111] text-[13px] font-semibold text-white active:scale-[0.985] transition-transform"
                >
                  保存档案
                </button>
              </div>
            </MiniSheet>
          )}

          {/* ═══════════ 状态卡展示层（点头像 → 单角色卡片） ═══════════ */}
          {(() => {
            if (!statusCardTurnId) return null;
            const turn = currentScript.turns.find((t) => t.id === statusCardTurnId);
            if (!turn) return null;
            const entries: EnsembleStatusEntry[] = (() => {
              try {
                return turn.statusData ? JSON.parse(turn.statusData) : [];
              } catch {
                return [];
              }
            })();
            if (!entries.length) return null;
            // 出场角色 = 状态数据里能对上演员表的人（保序）
            const members = entries
              .map((e) =>
                currentScript.cast.find(
                  (c) => c.id === e.memberId || c.name === e.name
                )
              )
              .filter((c): c is EnsembleCastMember => Boolean(c));
            if (!members.length) return null;
            // 状态卡时间：严格取本轮剧情时间
            const storyTime = resolveStoryTime(currentScript.timeAwareness);
            // 若用户点头像指定了某个角色，把它排到最前
            const ordered = statusCardMemberId
              ? [
                  ...members.filter((m) => m.id === statusCardMemberId),
                  ...members.filter((m) => m.id !== statusCardMemberId),
                ]
              : members;
            return (
              <EnsembleStatusCardLayer
                members={ordered}
                entries={entries}
                storyTime={storyTime}
                template={currentScript.statusPanel?.template}
                onClose={() => setStatusCardTurnId(null)}
              />
            );
          })()}


          {showSettingsSheet && (() => {
            // 与 triggerAiTurn 共用同一套换算（charsToMaxTokens），
            // 保证面板上写的就是真实发出去的护栏值。
            const effectiveTokens = charsToMaxTokens(charsDraft);
            // 用户公式 M = N + 150（1010 收紧）：给用户看的「实际最多多少字」
            const maxChars = targetCharsToMaxChars(charsDraft);
            const numBadge = (n: string) => (
              <span className="font-mono text-[11px] text-black/20 tracking-widest">
                {n}
              </span>
            );
            const sectionHead = (
              icon: React.ReactNode,
              label: string,
              num: string
            ) => (
              <div className="flex items-center gap-2 mb-2.5">
                <span className="w-6 h-6 rounded-[4px] bg-[#111111] grid place-items-center text-white shrink-0">
                  {icon}
                </span>
                <span
                  className="tracking-[0.22em] font-semibold text-black/45 flex-1"
                  style={{ fontSize: "11px" }}
                >
                  {label}
                </span>
                {numBadge(num)}
              </div>
            );
            // 1007b「设置页弹窗化（居中浮窗）」：
            //   用户口径 —— 与功能面板/各子弹窗**同一套居中浮窗**观感，
            //   不再是「从底部升起」的 sheet，也不保留 sheet 的整屏页残留。
            //   内容与排版原样保留，只换外壳。
            return (
              <div
                className="absolute inset-0 z-[56] flex items-center justify-center p-4"
                onClick={() => {
                  setShowSettingsSheet(false);
                  setShowToolsSheet(false);
                }}
              >
                <div className="absolute inset-0 bg-black/45 backdrop-blur-[3px]" />
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="relative bg-[#f2f2f4] rounded-[22px] w-full max-w-[440px] max-h-[82%] flex flex-col overflow-hidden shadow-[0_18px_50px_rgba(0,0,0,0.28)] animate-[softRise_300ms_cubic-bezier(0.16,1,0.3,1)]"
                  data-ens-ui="1"
                >
                {/* 顶栏：毛玻璃磨砂条 + ‹ Settings / ENSEMBLE · CONFIGURATION
                    1006 反馈③：原先顶部贴边太紧、与工作区衔接突兀。
                    修法：补一条与工作区同款的毛玻璃顶栏（sticky），
                    下移到与工作区顶栏一致的视觉基线，做出「从工作区平推入」的观感。 */}
                <div className="sticky top-0 z-10 shrink-0 bg-[#f2f2f4]/85 backdrop-blur-xl border-b border-black/[0.06] rounded-t-[22px]">
                  <div className="flex items-center gap-2.5 px-4 pt-3 pb-3">
                    <button
                      type="button"
                      onClick={() => {
                        setShowSettingsSheet(false);
                        setShowToolsSheet(false);
                      }}
                      className="w-9 h-9 -ml-1 grid place-items-center rounded-full hover:bg-black/5 text-black/60 active:scale-90 transition"
                    aria-label="返回"
                  >
                    <ChevronLeft size={22} strokeWidth={1.8} />
                  </button>
                  <div className="min-w-0">
                    <div className="text-[18px] font-bold tracking-tight text-[#111111] leading-none">
                      Settings
                    </div>
                    <div
                      className="tracking-[0.22em] font-medium text-black/25 mt-1.5"
                      style={{ fontSize: "11px" }}
                    >
                      ENSEMBLE · CONFIGURATION
                    </div>
                  </div>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto px-4 pt-4 pb-6 space-y-4">
                  {/* 01 OPENING */}
                  <div>
                    {sectionHead(<MessageSquare size={13} strokeWidth={2} />, "OPENING", "01")}
                    <div className="bg-white rounded-[16px] p-4">
                      <div className="flex items-baseline gap-2">
                        <span className="text-[13px] font-semibold text-[#111111]">
                          Opening Message / 开场白
                        </span>
                        <span
                          className="tracking-[0.18em] font-medium text-black/25 px-1.5 py-0.5 rounded bg-black/[0.04]"
                          style={{ fontSize: "11px" }}
                        >
                          EDITABLE
                        </span>
                      </div>
                      <div className="text-[11px] text-black/35 mt-1 mb-2.5">
                        铺垫群像的第一幕场景
                      </div>
                      <textarea
                        value={openingDraft}
                        onChange={(e) => setOpeningDraft(e.target.value)}
                        rows={5}
                        placeholder="开场白写在这里，AI 会基于它展开第一幕…"
                        className="w-full bg-black/[0.03] border border-black/8 rounded-xl p-3 text-[13px] leading-[1.85] text-[#1f1f1f] placeholder:text-black/25 outline-none focus:border-black/25 resize-none"
                      />
                    </div>
                  </div>

                  {/* 02 GENERATION */}
                  <div>
                    {sectionHead(<Wrench size={13} strokeWidth={2} />, "GENERATION", "02")}
                    <div className="bg-white rounded-[16px] p-4 space-y-3">
                      <div>
                        <div className="text-[13px] font-semibold text-[#111111]">
                          每轮字数 / Reply Length
                        </div>
                        <div className="text-[11px] text-black/35 mt-1">
                          AI 每次回复的目标字数
                        </div>
                      </div>
                      <div className="flex items-center gap-2.5">
                        <div className="flex-1 flex items-center justify-center gap-1.5 bg-black/[0.03] border border-black/10 rounded-[12px] h-12 px-3">
                          <input
                            type="text"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            value={charsInput}
                            onChange={(e) => {
                              // 1006 反馈：直接输入，不要 ＋/－ 按钮；
                              // 输入时必须能删干净（不留首位数字）。
                              // 因此草稿存**字符串**而非 number —— 若存 number，
                              // 清空会立刻被 React 回填成 0，再次输入就变成 "0250"。
                              const raw = e.target.value.replace(/[^\d]/g, "");
                              if (raw === "") {
                                setCharsInput("");
                                return;
                              }
                              // 去掉前导 0（"0250" → "250"，但 "0" 本身保留以便继续输入）
                              const normalized = raw.replace(/^0+(?=\d)/, "");
                              setCharsInput(normalized);
                            }}
                            onBlur={() => {
                              // 失焦时才把草稿收敛成合法数字并回写
                              const n = Number(charsInput);
                              const safe = Number.isFinite(n) && n > 0
                                ? Math.min(CHARS_MAX, Math.max(CHARS_MIN, Math.round(n)))
                                : 600;
                              setCharsDraft(safe);
                              setCharsInput(String(safe));
                            }}
                            className="w-full bg-transparent text-center text-[15px] font-bold text-[#111111] tabular-nums outline-none [-moz-appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          />
                          <span className="text-[11px] text-black/40 shrink-0">字</span>
                        </div>
                      </div>
                      <div className="text-[11px] leading-relaxed text-black/40">
                        想让 AI 每轮写多长。它会尽量写够 {charsDraft} 字，并在
                        <span className="text-black/60">本句完整处收尾</span>，
                        不会写到一半被切断。
                      </div>
                    </div>
                  </div>

                  {/* 03 CONTEXT */}
                  <div>
                    {sectionHead(<Clock size={13} strokeWidth={2} />, "CONTEXT", "03")}
                    <div className="bg-white rounded-[16px] p-4">
                      <div className="text-[13px] font-semibold text-[#111111]">
                        Context Limit / 未杀青上限
                      </div>
                      <div className="text-[11px] text-black/35 mt-1 mb-2.5">
                        杀青后 AI 只看「杀青点之后」的剧情；这里限制最多给它多少轮（防 token 爆）。已杀青的幕不受影响。
                      </div>
                      <div className="flex items-center gap-3">
                        <input
                          type="range"
                          min={5}
                          max={60}
                          step={1}
                          value={contextDraft}
                          onChange={(e) => setContextDraft(Number(e.target.value))}
                          className="flex-1 accent-[#111111]"
                        />
                        <span className="text-[15px] font-bold text-[#111111] tabular-nums shrink-0">
                          {contextDraft}
                          <span className="text-[11px] font-medium text-black/40 ml-0.5">轮</span>
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* 04 NARRATIVE */}
                  <div>
                    {sectionHead(<Eye size={13} strokeWidth={2} />, "NARRATIVE", "04")}
                    <div className="bg-white rounded-[16px] p-4 space-y-2">
                      <div>
                        <div className="text-[13px] font-semibold text-[#111111]">
                          Narrative POV / 叙事人称
                        </div>
                      </div>
                      {(
                        [
                          ["first", "第一人称沉浸", "角色动作用「我」描写，对白照常"],
                          ["second", "第二人称代入", "镜头跟着你，称呼你为「你」"],
                          ["third", "第三人称旁观", "所有人用名字，像小说"],
                        ] as const
                      ).map(([val, label, desc]) => {
                        const on = povDraft === val;
                        return (
                          <button
                            key={val}
                            type="button"
                            onClick={() => setPovDraft(val)}
                            className={`w-full flex items-start gap-2.5 text-left rounded-[12px] px-3 py-2.5 transition-colors ${
                              on ? "bg-black/[0.05]" : "hover:bg-black/[0.03]"
                            }`}
                          >
                            <span
                              className={`w-4 h-4 rounded-full border-[1.5px] grid place-items-center shrink-0 mt-0.5 ${
                                on ? "border-[#111111]" : "border-black/25"
                              }`}
                            >
                              {on && <span className="w-2 h-2 rounded-full bg-[#111111]" />}
                            </span>
                            <span className="min-w-0">
                              <span className="block text-[13px] font-medium text-[#111111]">
                                {label}
                                {val === "third" && (
                                  <span className="text-black/35 font-normal"> · 群像推荐</span>
                                )}
                              </span>
                              <span className="block text-[11px] text-black/35 mt-0.5">{desc}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* 05 MEMORY LINK */}
                  <div>
                    {sectionHead(<Layers size={13} strokeWidth={2} />, "MEMORY LINK", "05")}
                    <div className="bg-white rounded-[16px] p-4 space-y-2">
                      <div>
                        <div className="text-[13px] font-semibold text-[#111111]">
                          Online Sync / 线上互通
                        </div>
                        <div className="text-[11px] text-black/35 mt-1">
                          开启后记忆双向流通：角色在剧里「想起」你与线上聊天的记忆，剧里发生的事他们回到单聊也记得（需启用记忆库）
                        </div>
                      </div>
                      {(
                        [
                          [true, "开启", "线上线下记忆互通"],
                          [false, "关闭 · 默认", "完全架空，与线上世界隔离"],
                        ] as const
                      ).map(([val, label, desc]) => {
                        const on = onlineSyncDraft === val;
                        return (
                          <button
                            key={String(val)}
                            type="button"
                            onClick={() => setOnlineSyncDraft(val)}
                            className={`w-full flex items-start gap-2.5 text-left rounded-[12px] px-3 py-2.5 transition-colors ${
                              on ? "bg-black/[0.05]" : "hover:bg-black/[0.03]"
                            }`}
                          >
                            <span
                              className={`w-4 h-4 rounded-full border-[1.5px] grid place-items-center shrink-0 mt-0.5 ${
                                on ? "border-[#111111]" : "border-black/25"
                              }`}
                            >
                              {on && <span className="w-2 h-2 rounded-full bg-[#111111]" />}
                            </span>
                            <span className="min-w-0">
                              <span className="block text-[13px] font-medium text-[#111111]">
                                {label}
                              </span>
                              <span className="block text-[11px] text-black/35 mt-0.5">{desc}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* 06 TYPOGRAPHY（字体）已迁入「自定义 CSS」面板，见 showCssSheet。 */}

                  {/* 底部：SAVE DATA + 清空记录 */}
                  <button
                    type="button"
                    onClick={() => {
                      const updated: EnsembleScript = {
                        ...currentScript,
                        openingMessage: openingDraft,
                        charsPerTurn: charsDraft,
                        maxTokensPerTurn: undefined,
                        contextLimit: contextDraft,
                        narrativePov: povDraft,
                        onlineSync: onlineSyncDraft,
                        fontSource: fontSourceDraft,
                        fontUrl:
                          fontSourceDraft === "url" && fontUrlDraft.trim()
                            ? fontUrlDraft.trim()
                            : undefined,
                        fontFamily: fontSourceDraft ? ENSEMBLE_CUSTOM_FONT_FAMILY : undefined,
                        fontSize:
                          Number.isFinite(fontSizeDraft) && fontSizeDraft !== 14
                            ? Math.min(20, Math.max(10, fontSizeDraft))
                            : undefined,
                      };
                      setCurrentScript(updated);
                      saveOrUpdateEnsembleScript(updated);
                      // 字体源切换时同步 IndexedDB 里的字体数据：
                      //  · 链接模式 / 清除 → 删掉本剧本曾上传的文件，避免残留
                      //  · 上传模式 → 文件在 handleEnsembleFontUpload 里已存
                      if (fontSourceDraft !== "upload") {
                        saveEnsembleFontData(updated.id, null);
                      }
                      setScripts(loadEnsembleScripts());
                      setToast("已保存");
                    }}
                    className="w-full py-3.5 rounded-[14px] bg-[#111111] text-white text-[13px] font-semibold tracking-[0.16em] inline-flex items-center justify-center gap-2 active:scale-[0.985] transition-transform"
                  >
                    <Check size={15} strokeWidth={2.4} />
                    SAVE DATA
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (
                        !window.confirm(
                          "清空本剧本的全部记录？此操作不可撤销（剧本与演员表保留）。"
                        )
                      )
                        return;
                      const updated: EnsembleScript = { ...currentScript, turns: [] };
                      setCurrentScript(updated);
                      saveOrUpdateEnsembleScript(updated);
                      setScripts(loadEnsembleScripts());
                      setToast("记录已清空");
                    }}
                    className="w-full py-3.5 rounded-[14px] bg-white text-[#d9534f] text-[13px] font-medium inline-flex items-center justify-center gap-2 active:scale-[0.985] transition-transform"
                  >
                    <Eraser size={14} strokeWidth={2} />
                    清空记录 · CLEAR LOG
                  </button>
                </div>
                </div>
              </div>
            );
          })()}

          {/* ═══════════ 子弹窗 3：模型切换（两级：API → 该 API 下的具体模型） ═══════════ */}
          {showModelSheet && (() => {
// ── 一级：可选 API 列表 ──
            // 硅基流动属于「工具调用」范畴（记忆向量等），默认折叠。
            // 开关放在「返回」键旁边，尽量小 —— 不占列表位置、也不抢视觉。
            const hiddenApiCount = apiConfigList.filter(
              (cfg) => cfg.provider === "SiliconFlow"
            ).length;
            return (
              <MiniSheet
                title="模型切换"
                subtitle="API · SESSION ONLY"
                onClose={() => {
                  setShowModelSheet(false);
                  setModelPickerApiId(null);
                  setModelListError(null);
                  setShowToolsSheet(true);
                }}
                headerAction={
                  hiddenApiCount > 0 ? (
                    <button
                      type="button"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => setShowHiddenApis((v) => !v)}
                      className={`shrink-0 flex items-center gap-1 px-2 py-1 rounded-full active:scale-95 transition-transform ${
                        showHiddenApis
                          ? "bg-[#111111] text-white"
                          : "bg-black/[0.06] text-black/40"
                      }`}
                      style={{ fontSize: TYPE.MICRO }}
                      title="工具调用（硅基流动）"
                    >
                      <Wrench size={10} strokeWidth={2} />
                      工具调用
                      <span className="tabular-nums opacity-60">{hiddenApiCount}</span>
                    </button>
                  ) : null
                }
              >
                <div className="bg-white rounded-[14px] px-4 py-3 mb-2">
                  <div
                    className="text-black/50"
                    style={{ fontSize: TYPE.SM, lineHeight: LEADING.SUB }}
                  >
                    仅在群像内临时生效，<span className="text-black/70 font-medium">不会改动设置页</span>。可让聊天与总结用不同模型。
                  </div>
                </div>

                {(() => {
                  // 硅基流动只服务于「全局设置 → 记忆向量」等系统级工具，默认不作为群像对话模型，
                  // 所以不作为普通项平铺，而是收拢到一行小按键里；点一下才展开。
                  const visibleApis = apiConfigList.filter(
                    (cfg) => cfg.provider !== "SiliconFlow"
                  );
                  const hiddenApis = apiConfigList.filter(
                    (cfg) => cfg.provider === "SiliconFlow"
                  );

                  // 1007 图1 优化：API 卡片化 —— 去掉左侧深黑方块图标，
                  // 改为「细边框卡片 + 名称 + MODEL▾」，当前项加黑边 + 「当前」小徽章；
                  // 点 MODEL▾ 在**卡片内联展开**该 API 的模型列表（不再单开二级弹窗）。
                  const renderApiRow = (cfg: ApiConfig) => {
                    const apiSelected = currentScript.apiConfigIdOverride === cfg.id;
                    const expanded = modelPickerApiId === cfg.id;
                    const currentModel =
                      apiSelected && currentScript.modelOverride
                        ? currentScript.modelOverride
                        : cfg.defaultModel || cfg.provider || "UNKNOWN";
                    return (
                      <div
                        key={cfg.id}
                        className={`rounded-[14px] bg-white overflow-hidden border transition-colors ${
                          apiSelected ? "border-[#111111]" : "border-black/[0.12]"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2.5 px-3.5 pt-3 pb-3">
                          {/* 主体：点这里 = 直达选择该 API 的当前模型（2026-10-09 M-模型块直达） */}
                          <button
                            type="button"
                            onClick={() => selectApiDefaultModel(cfg)}
                            className="min-w-0 flex-1 text-left active:opacity-70 transition-opacity"
                          >
                            <div className="flex items-center gap-1.5">
                              {/* 1007 二次：API 站名 14 → 13px（用户「再小一些」）。
                                  行高收到 leading-tight，卡片随之变矮。 */}
                              <span className="text-[13px] font-semibold tracking-tight text-[#111111] truncate leading-tight">
                                {cfg.name || "未命名配置"}
                              </span>
                              {apiSelected && (
                                <span className="shrink-0 px-1.5 py-[2px] rounded-[5px] bg-[#111111] text-white text-[11px] font-semibold leading-none">
                                  当前
                                </span>
                              )}
                            </div>
                            <div className="mt-0.5 font-mono text-[11px] text-black/45 truncate leading-tight">
                              {currentModel}
                            </div>
                          </button>
                          {/* 右侧：点这里 = 展开该 API 的模型列表（保留原能力，阻止冒泡不触发直达选择） */}
                          <button
                            type="button"
                            onClick={() => toggleModelExpand(cfg)}
                            className="shrink-0 flex items-center gap-1 px-1.5 py-[3px] rounded-[6px] border border-black/[0.15] active:scale-95 transition-transform"
                          >
                            <span className="text-[11px] font-semibold tracking-[0.1em] text-black/60">
                              MODEL
                            </span>
                            <ChevronDown
                              size={10}
                              strokeWidth={2.5}
                              className={`text-black/40 transition-transform ${
                                expanded ? "rotate-180" : ""
                              }`}
                            />
                          </button>
                        </div>

                        {/* 内联模型列表：加载中 / 出错 / 空 / 列表
                            1007 用户口径：列表「6 行内滑动，现在太多行了不好找」。
                            1007b 复验：14px「还是很大」→ 收到 13px，行高 38px。
                            1008d 用户口径：限高 **放宽到 5–6 行** → 取 6 行
                            （行高约 26px，6 × 26 ≈ 156px），超出后容器内滚动。 */}
                        {expanded && (
                          <div className="border-t border-dashed border-black/[0.12] max-h-[156px] overflow-y-auto overscroll-contain">
                            {isLoadingModels && (
                              <div className="px-4 py-3.5 text-[11px] text-black/40">
                                正在拉取该接口的模型列表…
                              </div>
                            )}
                            {!isLoadingModels && modelListError && (
                              <div className="px-4 py-3.5 space-y-2.5">
                                <div className="text-[11px] text-[#b42318] leading-relaxed">
                                  {modelListError}
                                </div>
                                <button
                                  type="button"
                                  onClick={() => openModelPickerForApi(cfg)}
                                  className="px-3 py-1.5 rounded-[8px] bg-black/[0.05] text-[11px] font-medium text-black/60 active:scale-95 transition-transform"
                                >
                                  重试
                                </button>
                              </div>
                            )}
                            {!isLoadingModels &&
                              !modelListError &&
                              modelNameList.length === 0 && (
                                <div className="px-4 py-3.5 text-[11px] text-black/40">
                                  该接口未返回模型
                                </div>
                              )}
                            {!isLoadingModels &&
                              !modelListError &&
                              modelNameList.map((name) => {
                                const selected =
                                  currentScript.apiConfigIdOverride === cfg.id &&
                                  currentScript.modelOverride === name;
                                return (
                                  <button
                                    key={name}
                                    type="button"
                                    onClick={() => pickModelForApi(cfg.id, name)}
                                    className="w-full flex items-center gap-2 px-3.5 py-[7px] text-left border-t border-dashed border-black/[0.12] first:border-t-0 active:bg-black/[0.03] transition-colors"
                                  >
                                    {/* 1008 抄 chill 图4：展开列表的模型名 **单行完整显示**
                                        （whitespace-nowrap，不折行、不省略）；
                                        1008d：限高放宽到 6 行（用户口径「5行-6行」）。 */}
                                    <span
                                      className={`flex-1 min-w-0 block font-mono text-[10px] leading-tight whitespace-nowrap overflow-hidden text-ellipsis ${
                                        selected
                                          ? "font-semibold text-[#111111]"
                                          : "text-black/55"
                                      }`}
                                      title={name}
                                    >
                                      {name}
                                    </span>
                                    {selected && (
                                      <Check
                                        size={13}
                                        strokeWidth={2.4}
                                        className="text-[#111111] shrink-0"
                                      />
                                    )}
                                  </button>
                                );
                              })}
                          </div>
                        )}
                      </div>
                    );
                  };

                  if (apiConfigList.length === 0) {
                    return (
                      <div className="bg-white rounded-[16px] p-5 text-center text-[11px] text-black/40">
                        尚未配置 API，请到「设置 → API 配置」添加
                      </div>
                    );
                  }

                  return (
                    <>
                      {visibleApis.map(renderApiRow)}

                      {/* 工具调用（硅基流动）：开关在顶栏返回键旁边，这里只负责按开关状态显示 */}
                      {showHiddenApis && hiddenApis.map(renderApiRow)}
                    </>
                  );
                })()}

                {(currentScript.apiConfigIdOverride ||
                  currentScript.modelOverride) && (
                  <button
                    type="button"
                    onClick={() => {
                      const updated = {
                        ...currentScript,
                        apiConfigIdOverride: undefined,
                        modelOverride: undefined,
                      };
                      setCurrentScript(updated);
                      saveOrUpdateEnsembleScript(updated);
                      setScripts(loadEnsembleScripts());
                      setLastModel(ensembleModelLabel(currentScript.cast[0]?.id));
                      setToast("已恢复跟随全局默认");
                    }}
                    className="w-full py-3 rounded-[16px] bg-white text-[13px] font-medium text-black/55 active:scale-[0.985] transition-transform"
                  >
                    跟随全局默认
                  </button>
                )}

                {/* 底部「完成」按钮 */}
                <button
                  type="button"
                  onClick={() => {
                    setShowModelSheet(false);
                    setModelPickerApiId(null);
                    setModelListError(null);
                    setShowToolsSheet(true);
                  }}
                  className="w-full py-3 rounded-[16px] bg-[#111111] text-[13px] font-semibold text-white active:scale-[0.985] transition-transform"
                >
                  完成
                </button>
              </MiniSheet>
            );
          })()}

          {/* ═══════════ 轻提示 ═══════════ */}
          {toast && (
            <div className="absolute left-1/2 -translate-x-1/2 bottom-24 z-[70] px-4 py-2 rounded-full bg-[#111111] text-white text-[11px] font-medium shadow-lg pointer-events-none">
              {toast}
            </div>
          )}

          {/* 统一删除确认弹窗 */}
          {confirmState && (
            <ConfirmDialog
              title={confirmState.title}
              message={confirmState.message}
              confirmLabel={confirmState.confirmLabel}
              onCancel={() => setConfirmState(null)}
              onConfirm={confirmState.onConfirm}
            />
          )}
        </>
      )}
    </div>
  );
}
