"use client";

// components/ensemble/ensemble-status-card.tsx
// 群像「状态卡」渲染层
//
// 用户定稿（2026-10-06）：
//   · 点头像 → 弹出该角色的一张状态卡（图2 样式）。
//   · 一幕多角色 → 顶部**头像并列**，点谁看谁（图：金成帝 / 皮）。
//   · 卡上时间（LOG. TIME）严格取「本轮剧情时间」，来自 handleTime，
//     **不由 AI 写**；地点 loc_cn / loc_en 与其余字段取自 AI 的状态数据。
//   · 命名空间一律走本项目口径（.ensemble-* / .escard-*），
//     组件的样式就近声明，不污染全局。
//
// ⚠️ 模板变量替换（{{key}}）与进度条（{{key.bar}}）在本文件实现：
//     · {{key}}      → 纯文本插值（含 loc_cn / loc_en / time / char_* 等内置量）
//     · {{key.bar}}  → 针对 0–100 数值字段，渲染一段进度条 HTML
//   HTML/CSS/JS 全放开（engine="html"）：用户模板里的 <style> 原样保留。

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { EnsembleStatusEntry } from "@/lib/ensemble-parser";
import type { EnsembleCastMember } from "@/lib/ensemble-storage";
import type { ResolvedStoryTime } from "@/lib/ensemble-time";

/** 状态卡可以取到的全部内置量（AI 不写、由前端从角色/时间推得） */
export type StatusCardBuiltin = {
  loc_cn: string;
  loc_en: string;
  time: string;
  char_name_cn: string;
  char_name_en: string;
  char_initial: string;
  char_role: string;
  char_status: string;
};

/** HTML 转义：防止模型写出的字段值把模板结构撑破（仅用于纯文本插值） */
function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 取名字首字（中文取第一个字，英文取首字母大写） */
function initialOf(name: string): string {
  const n = (name || "").trim();
  if (!n) return "";
  const ch = n[0];
  return /[a-zA-Z]/.test(ch) ? ch.toUpperCase() : ch;
}

/** 把 0–100 的数值字段渲染成条形 HTML（{{key.bar}}） */
function barHtml(value: string): string {
  const num = Math.max(0, Math.min(100, Number(value) || 0));
  return `<span class="escard-bar" style="display:inline-block;vertical-align:middle;width:72px;height:4px;border-radius:2px;background:rgba(0,0,0,.09);overflow:hidden">
    <span style="display:block;height:100%;width:${num}%;background:#9A8C7A"></span>
  </span>`;
}

/**
 * 模板变量替换。
 *
 * @param template 用户模板（HTML 字符串）
 * @param builtin  内置量（loc_cn / time / char_* 等）
 * @param values   AI 生成字段（key → 值）
 */
export function renderStatusTemplate(
  template: string,
  builtin: Record<string, string>,
  values: Record<string, string>
): string {
  // 进度条先处理（{{key.bar}}），避免被普通 {{key}} 抢先吃掉
  let out = template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\.bar\s*\}\}/g, (_m, key: string) => {
    const raw = values[key] ?? builtin[key] ?? "";
    return barHtml(raw);
  });
  // 剩余普通变量：先查 AI 字段，再查内置量
  out = out.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_m, key: string) => {
    const v = values[key] ?? builtin[key] ?? "";
    return esc(v);
  });
  return out;
}

/**
 * 从模板反解字段表（W5）。
 * 同时认 {{key}} / {{key.bar}} 与 $1 $2 两类写法。
 * - 内置量（loc_cn / time / char_* 等）不当作用户字段，避免把系统槽位塞进字段表
 * - 同一 key 多次出现只保留一次；{{key.bar}} 与 {{key}} 合并为同一条
 * - $1 $2 落成 field_1 / field_2，方便用户补「给 AI 的说明」
 */
const STATUS_BUILTIN_KEYS = new Set([
  "loc_cn",
  "loc_en",
  "time",
  "char_name_cn",
  "char_name_en",
  "char_initial",
  "char_role",
  "char_status",
]);

export function extractFieldsFromTemplate(template: string): { key: string; desc: string }[] {
  const seen = new Set<string>();
  const out: { key: string; desc: string }[] = [];

  const push = (key: string) => {
    const k = key.trim();
    if (!k || seen.has(k) || STATUS_BUILTIN_KEYS.has(k)) return;
    seen.add(k);
    out.push({ key: k, desc: "" });
  };

  const mustache = template.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s*\.bar)?\s*\}\}/g);
  for (const m of mustache) push(m[1]);

  const dollars = template.matchAll(/\$(\d+)/g);
  for (const m of dollars) push(`field_${m[1]}`);

  return out;
}

/** 预览区示例数据（W4）：固定沙箱，不读本幕真实状态 */
export const STATUS_PREVIEW_SAMPLE_VALUES: Record<string, string> = {
  loc_cn: "走廊尽头",
  loc_en: "End of the hall",
  loc: "走廊尽头",
  thought: "这盒薄荷糖她居然还扣着。",
  god_note: "雨声比人声更响。",
  char_role: "观察者",
  char_status: "湿着肩膀，没点那半截烟",
};

export const STATUS_PREVIEW_SAMPLE_MEMBER: EnsembleCastMember = {
  id: "preview-sample",
  name: "示例角色",
};

/** 内置量 → 从角色 + 本轮剧情时间 + 条目数据推导 */
export function buildStatusBuiltin(
  member: EnsembleCastMember,
  st: ResolvedStoryTime | null,
  values: Record<string, string>,
  personaRole?: string
): StatusCardBuiltin {
  // 地点：优先取 AI 写的 loc_cn / loc_en
  const locCn = values.loc_cn || values.location || "";
  const locEn = values.loc_en || values.location_en || "";
  return {
    loc_cn: locCn,
    loc_en: locEn,
    time: st ? st.time12 : "",
    char_name_cn: member.name,
    char_name_en: member.name,
    char_initial: initialOf(member.name),
    char_role: values.char_role || values.role || personaRole || "",
    char_status: values.char_status || values.status || "",
  };
}

/**
 * 默认模板（对齐图2 的「观察者日志」卡片，命名空间简化为 escard-*）。
 * 用户在设置页可整体替换；此常量同时作为「默认字段」按钮的模板回填。
 */
export const DEFAULT_STATUS_TEMPLATE = `<div class="escard-wrap">
  <div class="escard-card">
    <div class="escard-clip"></div>
    <div class="escard-inner">
      <div class="escard-top">
        <div class="escard-top-l">
          <p class="escard-label">Current Location</p>
          <p class="escard-loc">{{loc_cn}} <span class="escard-slash">/</span> <span class="escard-loc-en">{{loc_en}}</span></p>
        </div>
        <div class="escard-top-r">
          <p class="escard-label">Log. Time</p>
          <p class="escard-time">{{time}}</p>
        </div>
      </div>
      <div class="escard-namerow">
        <h1 class="escard-name">{{char_name_cn}}</h1>
        <span class="escard-name-cn">{{char_name_cn}}</span>
      </div>
      <div class="escard-rolerow">
        <span class="escard-roletag">Role</span>
        <span class="escard-role">{{char_role}}</span>
      </div>
      <div class="escard-statusblock">
        <p class="escard-label escard-status-label">Status <span class="escard-pulse"></span></p>
        <p class="escard-status">{{char_status}}</p>
      </div>
      <div class="escard-tracing">
        <div class="escard-tape"></div>
        <div class="escard-note-head">
          <span class="escard-note-title">Observer's Log</span>
          <span class="escard-note-tag">#KP_NOTE</span>
        </div>
        <p class="escard-note-body">{{god_note}}</p>
      </div>
      <div class="escard-mono">
        <div class="escard-mono-head">
          <span class="escard-mono-title">Inner Monologue</span>
        </div>
        <div class="escard-mono-box"><p>{{thought}}</p></div>
      </div>
    </div>
  </div>
</div>
<style>
  .escard-wrap{width:100%;display:flex;justify-content:center;padding:8px 4px 16px;}
  .escard-card{width:100%;max-width:400px;background:#F9F8F6;border-radius:12px;position:relative;box-shadow:0 20px 50px rgba(0,0,0,.1);border:1px solid rgba(229,229,229,.6);}
  .escard-clip{position:absolute;top:-15px;left:30px;width:14px;height:40px;border:2px solid #a3a3a3;border-bottom:0;border-radius:10px 10px 0 0;z-index:20;transform:rotate(5deg);}
  .escard-clip::after{content:'';position:absolute;bottom:-5px;left:2px;width:6px;height:30px;border:2px solid #a3a3a3;border-top:0;border-radius:0 0 10px 10px;}
  .escard-inner{padding:24px 24px 32px;display:flex;flex-direction:column;gap:22px;}
  .escard-top{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:1px solid rgba(209,213,219,.5);padding-bottom:12px;}
  .escard-top-r{text-align:right;}
  .escard-label{font-size:9px;text-transform:uppercase;letter-spacing:.25em;color:#7A7671;margin:0 0 4px;}
  .escard-loc{font-size:13px;font-weight:500;letter-spacing:.06em;color:#1A1A1A;margin:0;font-family:serif;}
  .escard-slash{color:#A69F95;margin:0 4px;}
  .escard-loc-en{font-size:10px;color:#7A7671;letter-spacing:.1em;text-transform:uppercase;}
  .escard-time{font-style:italic;font-size:14px;color:#1A1A1A;margin:0;font-family:serif;}
  .escard-namerow{display:flex;align-items:baseline;gap:12px;}
  .escard-name{font-size:42px;color:#1A1A1A;margin:0;line-height:1.1;font-family:serif;}
  .escard-name-cn{font-size:14px;letter-spacing:.1em;color:#7A7671;font-weight:300;font-family:serif;}
  .escard-rolerow{display:flex;align-items:center;gap:8px;}
  .escard-roletag{font-size:9px;text-transform:uppercase;letter-spacing:.2em;background:#1A1A1A;color:#fff;padding:2px 8px;border-radius:3px;}
  .escard-role{font-size:12px;letter-spacing:.1em;color:#1A1A1A;font-family:serif;}
  .escard-statusblock{border-left:2px solid #9A8C7A;padding-left:12px;display:flex;flex-direction:column;gap:8px;}
  .escard-status-label{display:flex;align-items:center;gap:8px;margin:0;}
  .escard-pulse{width:6px;height:6px;border-radius:50%;background:#9A8C7A;display:inline-block;}
  .escard-status{font-size:13px;letter-spacing:.05em;color:#1A1A1A;font-weight:500;margin:0;font-family:serif;}
  .escard-tracing{background:rgba(255,255,255,.65);border:1px solid rgba(0,0,0,.05);box-shadow:0 10px 30px -10px rgba(0,0,0,.08);border-radius:8px;padding:16px;position:relative;transform:rotate(1deg);}
  .escard-tape{position:absolute;background:rgba(240,238,235,.85);border:1px solid rgba(255,255,255,.5);width:40px;height:12px;top:-6px;left:50%;transform:translateX(-50%) rotate(-2deg);z-index:10;}
  .escard-note-head{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(156,163,175,.3);padding-bottom:6px;margin-bottom:8px;}
  .escard-note-title{font-style:italic;font-size:13px;color:#9A8C7A;font-family:serif;}
  .escard-note-tag{font-size:8px;color:#9ca3af;letter-spacing:.15em;}
  .escard-note-body{font-size:11px;line-height:1.7;letter-spacing:.05em;color:#1A1A1A;margin:0;font-family:serif;}
  .escard-mono{padding-top:18px;border-top:1px dashed #d1d5db;}
  .escard-mono-head{display:flex;align-items:center;gap:8px;margin-bottom:10px;}
  .escard-mono-title{font-size:9px;letter-spacing:.2em;text-transform:uppercase;color:#7A7671;}
  .escard-mono-box{background:#F0EEEB;border-radius:6px;padding:16px;box-shadow:inset 0 2px 4px rgba(0,0,0,.06);min-height:80px;}
  .escard-mono-box p{font-weight:300;font-size:13px;line-height:1.8;letter-spacing:.08em;color:#2A2826;margin:0;text-align:justify;font-family:serif;}
</style>`;

/** 默认字段表（「默认字段」按钮回填用） */
export const DEFAULT_STATUS_FIELDS = [
  { key: "thought", desc: "该角色此刻的内心独白", max: 50 },
  { key: "god_note", desc: "上帝视角吐槽（第三人称旁观）", max: 30 },
];

/**
 * 状态卡承载层：管理「当前看哪个角色」的切换。
 * 多角色时顶部渲染头像列，点击即切换。
 */
export function EnsembleStatusCardLayer({
  members,
  entries,
  storyTime,
  template,
  onClose,
}: {
  /** 本幕出场的角色（有状态数据的那些） */
  members: EnsembleCastMember[];
  /** AI 生成的状态数据（与 members 对齐取 values） */
  entries: EnsembleStatusEntry[];
  storyTime: ResolvedStoryTime | null;
  template?: string;
  onClose: () => void;
}) {
  const [idx, setIdx] = useState(0);
  const active = members[Math.min(idx, members.length - 1)];

  const html = useMemo(() => {
    if (!active) return "";
    const values =
      entries.find((e) => e.memberId === active.id)?.values ??
      entries.find((e) => e.name === active.name)?.values ??
      {};
    const builtin = buildStatusBuiltin(active, storyTime, values);
    return renderStatusTemplate(
      template?.trim() ? template : DEFAULT_STATUS_TEMPLATE,
      builtin as unknown as Record<string, string>,
      values
    );
  }, [active, entries, storyTime, template]);

  return (
    <div className="absolute inset-0 z-[56] flex flex-col" onClick={onClose} data-ens-ui="1">
      <div className="absolute inset-0 bg-black/55 backdrop-blur-[6px]" />

      <div className="relative flex-1 overflow-y-auto pt-14 pb-6 px-4">
        {/* 多角色「姓」块（≥2 人才显示）
            1007 实机：用户「35px 头像还是太大，不要头像了，直接做成姓的块」。
            → 不再渲染角色头像图（member.avatar），一律用**姓氏首字**做紧凑圆块；
              尺寸收到 30px，选中态实心黑、未选中态半透明。 */}
        {members.length > 1 && (
          <div className="flex items-center justify-center gap-2.5 mb-5">
            {members.map((m, i) => (
              <button
                key={m.id}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIdx(i);
                }}
                className={`w-[30px] h-[30px] rounded-full grid place-items-center text-[12px] font-semibold transition-all ${
                  i === idx
                    ? "bg-[#111111] text-white scale-105"
                    : "bg-white/25 text-white/70"
                }`}
                title={m.name}
              >
                {initialOf(m.name)}
              </button>
            ))}
          </div>
        )}

        {/* 卡片本体：用户模板渲染结果（含其自带 <style>） */}
        <div
          onClick={(e) => e.stopPropagation()}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>

      {/* 底部关闭键 */}
      <div className="relative pb-8 flex justify-center">
        <button
          type="button"
          onClick={onClose}
          className="px-10 py-3 rounded-full bg-white/12 text-white/80 text-[14px] backdrop-blur-md active:scale-95 transition-transform"
        >
          关闭
        </button>
      </div>
    </div>
  );
}

/**
 * W4 · ③ 预览 / LIVE
 * 用当前模板 + 沙箱示例字段实渲染一张卡（本项目 .escard-* 口径，不用 iframe / rp-*）。
 * 模板里的 <script> 会被剥掉：预览只看版式，不执行用户 JS。
 */
export function StatusLivePreview({
  template,
  fields,
}: {
  template: string;
  fields: { key: string; desc?: string; max?: number }[];
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const html = useMemo(() => {
    const values: Record<string, string> = { ...STATUS_PREVIEW_SAMPLE_VALUES };
    for (const f of fields) {
      const k = f.key.trim();
      if (!k || values[k] !== undefined) continue;
      values[k] = k.endsWith("en") ? "SAMPLE" : `示例 · ${k}`;
    }
    const raw = renderStatusTemplate(
      template?.trim() ? template : DEFAULT_STATUS_TEMPLATE,
      buildStatusBuiltin(
        STATUS_PREVIEW_SAMPLE_MEMBER,
        {
          date: new Date(2026, 9, 7, 23, 14),
          dateCn: "2026年10月7日 星期三",
          dateEn: "Oct 7, 2026",
          time24: "23:14",
          time12: "11:14 PM",
          virtual: true,
          anchorLabel: "",
        },
        values
      ) as unknown as Record<string, string>,
      values
    );
    return raw.replace(/<script\b[\s\S]*?<\/script>/gi, "");
  }, [template, fields]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    el.innerHTML = html;
    return () => {
      el.innerHTML = "";
    };
  }, [html]);

  return (
    <div
      ref={hostRef}
      className="escard-preview-host pointer-events-none select-none"
    />
  );
}

export default EnsembleStatusCardLayer;
