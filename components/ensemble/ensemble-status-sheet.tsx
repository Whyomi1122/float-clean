"use client";

// components/ensemble/ensemble-status-sheet.tsx
// 群像「状态面板」设置页（对齐用户提供的图：① 字段 / DATA ② 模板 / TEMPLATE）
//
// 交互定稿（2026-10-06）：
//   · 顶部开关「启用状态面板」：开启后 AI 按字段表为每个角色生成数据，点头像查看。
//   · ① 字段 / DATA：每行 = key 输入 + 说明输入 + 数字（软上限）+ 删除。
//     规则：key 供模板 {{key}} 取值；说明是给 AI 看的话；数字是软上限（留空不限）；
//     0–100 的数字字段可在模板里用 {{key.bar}} 渲染进度条。
//     底部两个按钮：「+ 加字段」「默认字段」。
//   · ② 模板 / TEMPLATE：HTML/CSS/JS 全放开；上方是可点击插入的变量 chips，
//     下方是代码框。chips 点击即在光标处插入 {{key}}。
//
// ⚠️ 命名空间一律走本项目口径（.ensemble-* / .escard-*），
//    不引入任何外部 App 的类名。

import React, { useRef } from "react";
import { Plus, X } from "lucide-react";

export type StatusField = { key: string; desc: string; max?: number };

/** 变量 chips：内置量 + 用户字段 + 进度条变体 */
export function StatusVariableChips({
  fields,
  onInsert,
}: {
  fields: StatusField[];
  onInsert: (token: string) => void;
}) {
  const builtin = ["loc_cn", "loc_en", "time", "char_name_cn", "char_initial", "char_role", "char_status"];
  const dynamic = fields
    .filter((f) => f.key.trim())
    .flatMap((f) => [f.key.trim(), `${f.key.trim()}.bar`]);
  const all = [...builtin, ...dynamic];

  return (
    <div className="flex flex-wrap gap-1.5">
      {all.map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onInsert(`{{${v}}}`)}
          className="px-2 py-1 rounded-[7px] bg-black/[0.05] active:scale-95 transition-transform"
          style={{ fontSize: "10px" }}
        >
          <span className="font-mono text-black/55">{`{{${v}}}`}</span>
        </button>
      ))}
    </div>
  );
}

/** ① 字段表编辑区 */
export function StatusFieldEditor({
  fields,
  onChange,
}: {
  fields: StatusField[];
  onChange: (next: StatusField[]) => void;
}) {
  const patch = (i: number, part: Partial<StatusField>) => {
    const next = fields.map((f, idx) => (idx === i ? { ...f, ...part } : f));
    onChange(next);
  };

  return (
    <div className="space-y-2">
      {fields.map((f, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            value={f.key}
            onChange={(e) => patch(i, { key: e.target.value })}
            placeholder="key"
            spellCheck={false}
            className="w-[26%] shrink-0 bg-white border border-black/[0.07] rounded-[10px] px-2.5 py-2.5 font-mono text-[11px] text-[#111111] placeholder:text-black/25 outline-none focus:border-black/25"
          />
          <input
            value={f.desc}
            onChange={(e) => patch(i, { desc: e.target.value })}
            placeholder="说明（给 AI 看的话）"
            className="flex-1 min-w-0 bg-white border border-black/[0.07] rounded-[10px] px-2.5 py-2.5 text-[11px] text-[#111111] placeholder:text-black/25 outline-none focus:border-black/25"
          />
          <input
            value={f.max ?? ""}
            onChange={(e) => {
              const raw = e.target.value.replace(/[^\d]/g, "");
              patch(i, { max: raw ? Number(raw) : undefined });
            }}
            placeholder="字数"
            inputMode="numeric"
            className="w-[52px] shrink-0 bg-white border border-black/[0.07] rounded-[10px] px-2 py-2.5 text-center text-[11px] text-[#111111] placeholder:text-black/25 outline-none focus:border-black/25"
          />
          <button
            type="button"
            onClick={() => onChange(fields.filter((_, idx) => idx !== i))}
            className="w-7 h-7 shrink-0 grid place-items-center rounded-full text-black/25 active:scale-90 transition-transform"
            title="删除该字段"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>
      ))}
      {fields.length === 0 && (
        <div className="text-[11px] text-black/30 py-2">
          还没有字段。点「默认字段」一键回填，或「+ 加字段」自定义。
        </div>
      )}
    </div>
  );
}

/** ② 模板编辑区（HTML / CSS / JS 全放开） */
export function StatusTemplateEditor({
  fields,
  template,
  onChange,
}: {
  fields: StatusField[];
  template: string;
  onChange: (v: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // 在光标处插入变量 token，插完把光标停到 token 后面
  const insert = (token: string) => {
    const el = ref.current;
    if (!el) {
      onChange(template + token);
      return;
    }
    const start = el.selectionStart ?? template.length;
    const end = el.selectionEnd ?? template.length;
    const next = template.slice(0, start) + token + template.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  return (
    <div className="space-y-2.5">
      <StatusVariableChips fields={fields} onInsert={insert} />
      <textarea
        ref={ref}
        value={template}
        onChange={(e) => onChange(e.target.value)}
        rows={12}
        spellCheck={false}
        placeholder={`HTML / CSS / JS 全放开。用 {{key}} 取字段值，用 {{key.bar}} 渲染进度条。\n\n<div class="escard-name">{{char_name_cn}}</div>`}
        className="w-full bg-white border border-black/[0.07] rounded-[12px] p-3 font-mono text-[10px] leading-relaxed text-[#111111] placeholder:text-black/25 outline-none focus:border-black/25 resize-none"
      />
    </div>
  );
}

/** 开关行（与 Settings 全页同款视觉） */
export function StatusToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-[#111111]">{label}</div>
        {hint && (
          <div className="text-[10px] text-black/40 mt-1 leading-relaxed">{hint}</div>
        )}
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`shrink-0 w-[46px] h-[27px] rounded-full transition-colors duration-200 relative ${
          checked ? "bg-[#111111]" : "bg-black/15"
        }`}
        role="switch"
        aria-checked={checked}
      >
        <span
          className={`absolute top-[3px] w-[21px] h-[21px] rounded-full bg-white shadow-sm transition-all duration-200 ${
            checked ? "left-[22px]" : "left-[3px]"
          }`}
        />
      </button>
    </div>
  );
}

/** 编号小标题（① 字段 / DATA） */
export function StatusSectionHead({
  num,
  label,
  labelEn,
  right,
}: {
  num: string;
  label: string;
  labelEn: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-end justify-between gap-3 mb-3">
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] font-bold text-[#111111]">{num}</span>
        <span className="text-[13px] font-bold text-[#111111]">{label}</span>
        <span className="text-[10px] tracking-[0.18em] font-medium text-black/30">
          {labelEn}
        </span>
      </div>
      {right}
    </div>
  );
}

/** 「+ 加字段」/「默认字段」按钮组 */
export function StatusFieldActions({
  onAdd,
  onReset,
}: {
  onAdd: () => void;
  onReset: () => void;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <button
        type="button"
        onClick={onAdd}
        className="flex-1 py-2.5 rounded-[14px] bg-white text-[11px] font-medium text-black/60 active:scale-[0.985] transition-transform flex items-center justify-center gap-1.5 whitespace-nowrap"
      >
        <Plus size={12} strokeWidth={2.2} />
        加字段
      </button>
      <button
        type="button"
        onClick={onReset}
        className="flex-1 py-2.5 rounded-[14px] bg-white text-[11px] font-medium text-black/60 active:scale-[0.985] transition-transform whitespace-nowrap"
      >
        默认字段
      </button>
    </div>
  );
}

/** 「从模板生成字段」—— 把用户刚贴的模板反解成字段表 */
export function StatusGenerateFromTemplateBtn({
  onClick,
}: {
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-2.5 py-1 rounded-[7px] text-[11px] font-semibold text-[#c0392b] bg-[#c0392b]/[0.08] active:scale-95 transition-transform whitespace-nowrap shrink-0"
    >
      从模板生成字段
    </button>
  );
}

export default StatusFieldEditor;
