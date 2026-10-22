"use client";

import React from "react";
import {
  Code2,
  Layers,
  ChevronRight,
  Clock,
  Activity,
  BookOpen,
  Scissors,
  Image as ImageIcon,
  type LucideIcon,
} from "lucide-react";
import { TYPE } from "@/components/ensemble/ensemble-tokens";

// ══════════════════════════════════════════════════════════
// 群像「功能」面板（TOOLS）
// 视觉对齐目标截图：浅灰底 → 大标题「功能」+ TOOLS 小字 →
// 白底圆角卡列表（深黑方角图标 + 中文主标题 + 英文副标题 + ›）。
//
// 字号策略（2026-10 修正）：群像字号**写死**，不跟随全局 --app-text-scale。
// 此前 fs() 走 calc(Npx * var(--app-text-scale))，导致「设置 → 主题 → 文字缩放」
// 会连带放大群像内部排版，破坏设计稿节奏。现已全部改为固定 px。
// ══════════════════════════════════════════════════════════

/** 字号基准值 → 固定 px 字符串（群像内部不随全局缩放变化） */
/** 字号基准值 → 固定 px 字符串（群像内部不随全局缩放变化）
 *  1007：全部收口到 ensemble-tokens 的 TYPE 档位（12/14/16/20/24/32），
 *        禁止再出现 9 / 9.5 / 10 / 18 这类散值。 */
function fs(px: number): string {
  return `${px}px`;
}

/** token 直通（语义 → px），供面板内引用，避免手写裸值 */
const T_MICRO = TYPE.MICRO; // 12
const T_SM = TYPE.SM; // 14
const T_BASE = TYPE.BASE; // 16
const T_H3 = TYPE.H3; // 20

export type EnsembleToolId =
  | "customCss"
  | "model"
  | "timeAwareness"
  | "statusPanel"
  | "archive"
  | "worldBook"
  | "storyboard";

export interface EnsembleToolItem {
  id: EnsembleToolId;
  /** 中文主标题 */
  label: string;
  /** 英文副标题（全大写、字距拉开，纯装饰用） */
  labelEn: string;
  Icon: LucideIcon;
  /** 是否可用；未接入的功能显示为不可点击态 */
  enabled?: boolean;
  /** 已生效时的提示（例如配色已自定义、CSS 已启用） */
  active?: boolean;
}

/** 面板条目定义。顺序与目标截图一致。
 *  1006 反馈 R3：「剧本设置」已从本面板移除，改挂到工作区顶栏右上角。
 *  1006 反馈④：「场景设定」已删除，功能并入剧本设置页的开场白。 */
export const ENSEMBLE_TOOLS: EnsembleToolItem[] = [
  { id: "timeAwareness", label: "时间感知", labelEn: "TIME AWARENESS", Icon: Clock, enabled: true },
  { id: "statusPanel", label: "状态面板", labelEn: "STATUS PANEL", Icon: Activity, enabled: true },
  { id: "worldBook", label: "世界书", labelEn: "WORLD BOOK", Icon: BookOpen, enabled: true },
  { id: "storyboard", label: "分镜配图", labelEn: "STORYBOARD", Icon: ImageIcon, enabled: true },
  { id: "archive", label: "杀青归档", labelEn: "WRAP · ARCHIVE", Icon: Scissors, enabled: true },
  { id: "customCss", label: "自定义 CSS", labelEn: "CUSTOM STYLE", Icon: Code2, enabled: true },
  { id: "model", label: "模型切换", labelEn: "API · SESSION", Icon: Layers, enabled: true },
];

function ToolRow({
  item,
  onClick,
}: {
  item: EnsembleToolItem;
  onClick: (id: EnsembleToolId) => void;
}) {
  const { Icon, label, labelEn, enabled, active } = item;
  return (
    <button
      type="button"
      disabled={!enabled}
      onClick={() => enabled && onClick(item.id)}
      className={`w-full flex items-center gap-3.5 px-3.5 py-3 rounded-[16px] text-left transition-all duration-200 ${
        enabled
          ? "bg-white active:scale-[0.985] shadow-[0_1px_2px_rgba(0,0,0,0.03)] hover:shadow-[0_2px_10px_rgba(0,0,0,0.06)]"
          : "bg-white/55"
      }`}
    >
      {/* 深黑方角图标：1007b 由 44px 收到 40px（字大撑高大按键），
          图标与其容器同步收一档，避免「图标空、文字小」的失衡。 */}
      <span
        className={`w-10 h-10 rounded-[12px] shrink-0 grid place-items-center ${
          enabled ? "bg-[#111111]" : "bg-black/20"
        }`}
      >
        <Icon size={18} strokeWidth={1.9} className="text-white" />
      </span>

      <span className="flex-1 min-w-0">
        <span
          className={`block font-semibold tracking-tight leading-tight ${
            enabled ? "text-[#111111]" : "text-black/30"
          }`}
          style={{ fontSize: fs(T_SM) }}
        >
          {label}
        </span>
        <span
          className={`block tracking-[0.16em] font-medium mt-1 ${
            enabled ? "text-black/30" : "text-black/15"
          }`}
          style={{ fontSize: fs(T_MICRO) }}
        >
          {labelEn}
        </span>
      </span>

      {active && (
        <span className="w-1.5 h-1.5 rounded-full bg-[#111111] shrink-0 mr-1" />
      )}
      <ChevronRight
        size={17}
        strokeWidth={1.9}
        className={enabled ? "text-black/25 shrink-0" : "text-black/10 shrink-0"}
      />
    </button>
  );
}

/**
 * 底部升起的「功能」面板。
 * 纯展示 + 回调，不做任何数据读写，保持组件可复用。
 */
export function EnsembleToolsSheet({
  open,
  onClose,
  onPick,
  activeIds,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (id: EnsembleToolId) => void;
  /** 已生效的功能，用来点亮行末小圆点 */
  activeIds?: EnsembleToolId[];
}) {
  if (!open) return null;
  return (
    // 1007 弹窗化：与 MiniSheet 统一 —— 居中浮窗（四边留边、圆角四角），
    // 不再是「从底部升起」的 sheet。
    <div
      className="absolute inset-0 z-[54] flex items-center justify-center p-4"
      onClick={onClose}
    >
      {/* 遮罩（模糊背景常驻：子弹窗关闭后本层保留，背景持续模糊，不再重播弹出动画） */}
      <div className="absolute inset-0 bg-black/45 backdrop-blur-[3px]" />

      {/* 面板本体：居中浮窗 */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative bg-[#f2f2f4] rounded-[22px] px-4 pt-6 pb-4 w-full max-w-[440px] max-h-[80%] overflow-y-auto shadow-[0_18px_50px_rgba(0,0,0,0.28)] animate-[softRise_300ms_cubic-bezier(0.16,1,0.3,1)]"
        data-ens-ui="1"
      >
        {/* 标题区 */}
        <div className="px-1.5 mb-4">
          <div
            className="font-bold tracking-tight text-[#111111] leading-none"
            style={{ fontSize: fs(T_H3) }}
          >
            功能
          </div>
          <div
            className="tracking-[0.28em] font-medium text-black/30 mt-2"
            style={{ fontSize: fs(T_MICRO) }}
          >
            TOOLS
          </div>
        </div>

        {/* 条目列表：1007b 收紧条目间距（2.5 → 2），让面板更紧凑。
            字号问题（字大撑按键）在各 ToolRow 内部处理。 */}
        <div className="space-y-2">
          {ENSEMBLE_TOOLS.map((item) => (
            <ToolRow
              key={item.id}
              item={{ ...item, active: activeIds?.includes(item.id) }}
              onClick={onPick}
            />
          ))}
        </div>

        {/* 底部不再放「取消」/「返回」——返回统一交给顶栏与左上角浮层键，
            避免同一个动作出现两个按钮（用户明确要求：返回择一即可）。 */}
        <div
          className="mt-4 mb-1 text-center text-black/25"
          style={{ fontSize: fs(T_MICRO) }}
        >
          点空白处或按返回键收起
        </div>

        {/* 动画关键帧（就近声明，避免污染全局样式表）
            1007b：用户「不要从底部弹起的感觉，要舒适一些」。
            把 sheetUp（translateY(100%) 上滑，sheet 语汇）换成 softRise ——
            居中浮窗的自然语言：从 96% 缩放 + 上浮 8px + 轻微模糊收敛，
            指数缓出，一次克制的入场。 */}
        <style jsx>{`
          @keyframes fadeIn {
            from {
              opacity: 0;
            }
            to {
              opacity: 1;
            }
          }
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
      </div>
    </div>
  );
}

export default EnsembleToolsSheet;
