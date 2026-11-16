"use client";

import React from "react";
import type { StoryboardDebug } from "@/lib/ensemble-storyboard";

interface StoryboardDebugSheetProps {
  open: boolean;
  debug: StoryboardDebug | null;
  onClose: () => void;
}

/** 长按分镜图 → 看这一次生图到底把什么发给了模型（排查串脸用）。 */
export function StoryboardDebugSheet({ open, debug, onClose }: StoryboardDebugSheetProps) {
  if (!open) return null;

  const rows: Array<[string, string]> = debug
    ? [
        ["画面主体", `${debug.subject}${debug.subjectIsPersona ? "（用户本人）" : ""}`],
        ["锁脸参考图", debug.referenceOwner ? `用 ${debug.referenceOwner} 的参考图` : "未使用参考图"],
        ["多角色拼图", debug.stitched ? `开（${debug.stitchedNames.join(" → ")}）` : "关"],
        ["用户面具外观词", debug.personaMaskApplied ? "已注入" : "未注入"],
        ["附带外观词", debug.extraFeatures.length ? `${debug.extraFeatures.length} 条` : "无"],
        ["记录时间", new Date(debug.at).toLocaleString()],
      ]
    : [];

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/40 px-3 pb-3"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white p-4 shadow-xl"
        style={{ animation: "modalSoftRise 0.22s ease" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[15px] font-medium text-[#2F3437]">本次生图提示词</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-[13px] text-[#5B8FB9] active:opacity-70"
          >
            关闭
          </button>
        </div>

        {!debug ? (
          <p className="m-0 text-[13px] leading-relaxed text-[#8A9099]">
            这一幕没有记录（刷新过页面，或这张图是旧版本生成的）。重新生成一次分镜图后再长按就能看到。
          </p>
        ) : (
          <>
            <div className="mb-3 rounded-xl bg-[#F5F6F7] p-3">
              {rows.map(([label, value]) => (
                <div key={label} className="flex justify-between gap-3 py-[3px] text-[13px]">
                  <span className="shrink-0 text-[#8A9099]">{label}</span>
                  <span className="text-right text-[#2F3437]">{value}</span>
                </div>
              ))}
            </div>
            <div className="mb-1 text-[12px] text-[#8A9099]">实际发送的提示词</div>
            <pre className="m-0 max-h-[38vh] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-[#F5F6F7] p-3 text-[12px] leading-relaxed text-[#2F3437]">
              {debug.prompt}
            </pre>
          </>
        )}
      </div>
    </div>
  );
}
