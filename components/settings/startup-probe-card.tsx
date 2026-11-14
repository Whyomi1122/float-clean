"use client";

import { useEffect, useState } from "react";
import { Activity, RotateCw, Trash2 } from "lucide-react";

import {
  clearStartupReport,
  isStartupProbeEnabled,
  readLastStartupReport,
  setStartupProbeEnabled,
  type StartupProbeReport,
} from "@/lib/startup-probe";

/**
 * 启动耗时（本机实测）
 * 手机上没法开 F12，所以把探针结果直接显示在设置里：
 * 点「开始测量」→ 自动刷新 → 下次进来这里就有数字。
 */
export function StartupProbeCard() {
  const [report, setReport] = useState<StartupProbeReport | null>(null);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    setReport(readLastStartupReport());
    setArmed(isStartupProbeEnabled());
  }, []);

  const startMeasure = () => {
    setStartupProbeEnabled(true);
    if (typeof window !== "undefined") window.location.reload();
  };

  const clear = () => {
    clearStartupReport();
    setStartupProbeEnabled(false);
    setReport(null);
    setArmed(false);
  };

  const measuredAt = report?.at
    ? new Date(report.at).toLocaleString("zh-CN", { hour12: false })
    : "";

  // 找出最慢的一段，直接给结论，省得自己看表
  const slowest = report?.rows?.reduce(
    (worst, row) => (row.gapMs > (worst?.gapMs ?? -1) ? row : worst),
    undefined as (typeof report.rows)[number] | undefined,
  );

  return (
    <div className="g-card flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Activity size={18} className="shrink-0 text-[var(--c-icon-active)]" />
        <span className="menu-label flex-1">启动耗时（本机实测）</span>
        {armed && !report && <span className="menu-desc !mt-0">已开启，刷新后出结果</span>}
      </div>

      {report ? (
        <>
          <span className="menu-desc !mt-0 ts-13">测量时间：{measuredAt}</span>
          <div className="flex flex-col gap-1 mt-1">
            {report.rows.map((row, index) => (
              <div key={`${row.label}-${index}`} className="flex items-center justify-between gap-2">
                <span className="menu-desc !mt-0 flex-1 truncate">{row.label}</span>
                <span className="menu-desc !mt-0 tabular-nums">{row.totalMs} ms</span>
                <span className="menu-desc !mt-0 tabular-nums w-[64px] text-right">
                  {index === 0 ? "—" : `+${row.gapMs}`}
                </span>
              </div>
            ))}
          </div>
          {report.nav && (
            <span className="menu-desc !mt-0 ts-13">
              页面导航：DOMContentLoaded {report.nav.domContentLoadedMs} ms ／ load {report.nav.loadMs} ms ／
              其中 JS 求值+首屏 {report.nav.scriptMs} ms
            </span>
          )}
          {slowest && (
            <span className="menu-desc !mt-0 ts-13">
              最慢的一段：{slowest.label}（{slowest.gapMs} ms）
            </span>
          )}
          <span className="menu-desc !mt-0 ts-13">
            说明：`累计` 是从最早那一段算起；`+X` 是这一段自己花掉的。冷启动（浏览器刚被系统回收后）的数字更接近真实手感。
          </span>
        </>
      ) : (
        <span className="menu-desc !mt-0 ts-13">
          还没测过。点「开始测量」会自动刷新一次，回来这里就能看到每一段花了多少毫秒。
        </span>
      )}

      <div className="flex items-center gap-2 mt-1">
        <button
          type="button"
          onClick={startMeasure}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-[10px] bg-black/[0.05] py-2 text-[13px] active:bg-black/[0.09]"
        >
          <RotateCw size={14} />
          {report ? "重新测量" : "开始测量"}
        </button>
        {report && (
          <button
            type="button"
            onClick={clear}
            className="flex items-center justify-center gap-1.5 rounded-[10px] bg-black/[0.05] px-3 py-2 text-[13px] active:bg-black/[0.09]"
          >
            <Trash2 size={14} />
            清除
          </button>
        )}
      </div>
    </div>
  );
}
