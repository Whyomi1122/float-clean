"use client";

import { useEffect, useState } from "react";
import { Activity, RotateCw, Trash2 } from "lucide-react";

import {
  clearStartupReport,
  readLastStartupReport,
  resetStartupProbeState,
  type StartupProbeReport,
} from "@/lib/startup-probe";

/**
 * 启动耗时（本机实测）
 * 手机上没法开 F12，所以把探针结果直接显示在设置里。
 * 探针每次打开都会静默记录一次，所以这里永远显示「最近一次打开」的数字；
 * 「重新测量」= 刷新一次，回来就是刚才那次的数字。
 */
export function StartupProbeCard() {
  const [report, setReport] = useState<StartupProbeReport | null>(null);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    setReport(readLastStartupReport());
  }, []);

  const startMeasure = () => {
    if (reloading) return;
    setReloading(true);
    resetStartupProbeState();
    try {
      window.location.reload();
    } catch {
      window.location.href = window.location.href;
    }
    // 兜底：万一 reload 被拦（PWA / 手势后退缓存），1.2 秒后强制重导航一次
    window.setTimeout(() => {
      try {
        window.location.replace(window.location.pathname + window.location.search);
      } catch {
        // 放弃
      }
    }, 1200);
  };

  const clear = () => {
    clearStartupReport();
    setReport(null);
  };

  const measuredAt = report?.at
    ? new Date(report.at).toLocaleString("zh-CN", { hour12: false })
    : "";

  // 找出最慢的一段，直接给结论，省得自己看表
  const slowest = report?.rows?.reduce(
    (worst, row) => (row.gapMs > (worst?.gapMs ?? -1) ? row : worst),
    undefined as (typeof report.rows)[number] | undefined,
  );

  const navHeavy = Boolean(report?.nav && report.nav.domContentLoadedMs > 3000);

  return (
    <div className="g-card flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Activity size={18} className="shrink-0 text-[var(--c-icon-active)]" />
        <span className="menu-label flex-1">启动耗时（本机实测）</span>
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
          {report.nav && (
            <span className="menu-desc !mt-0 ts-13">
              文档请求：等到开工 {report.nav.requestDelayMs ?? 0} ms ／
              开始请求到拿到响应头（TTFB） {report.nav.ttfbMs ?? 0} ms ／
              缓存接管 {report.nav.controlled ? "是" : "否"}
            </span>
          )}
          {report.nav && report.nav.assetCount ? (
            <span className="menu-desc !mt-0 ts-13">
              首屏脚本/样式：{report.nav.assetCount} 个文件 ／
              {Math.round((report.nav.assetBytes ?? 0) / 1024)} KB ／
              下载跨度 {report.nav.assetSpanMs ?? 0} ms
            </span>
          ) : null}
          {navHeavy && (
            <span className="menu-desc !mt-0 ts-13">
              {report.nav && (report.nav.ttfbMs ?? 0) > 1500
                ? "注意：浏览器开始请求文档后，好几秒才拿到服务器响应头 —— 时间卡在服务器/网络这一段，不是我们自己的代码。（已有缓存兜底：400 毫秒不响应就直接用本地缓存先渲染。）"
                : (report.nav?.assetSpanMs ?? 0) > 1500
                  ? "注意：时间主要花在下载首屏 JS/CSS 上 —— 这是网络带宽，不是计算慢。"
                  : "注意：DOMContentLoaded 超过 3 秒，说明时间花在**等页面和资源加载**上，不是数据库或 JS 计算慢。"}
            </span>
          )}
          {slowest && (
            <span className="menu-desc !mt-0 ts-13">
              最慢的一段：{slowest.label}（{slowest.gapMs} ms）
            </span>
          )}
          <span className="menu-desc !mt-0 ts-13">
            说明：`累计` 从最早那一段算起，`+X` 是这一段自己花掉的。冷启动（浏览器把页面回收后再打开）的数字更接近真实手感。
          </span>
        </>
      ) : (
        <span className="menu-desc !mt-0 ts-13">
          还没有记录。点「重新测量」会自动刷新一次，回来这里就能看到每一段花了多少毫秒。
        </span>
      )}

      <div className="flex items-center gap-2 mt-1">
        <button
          type="button"
          onClick={startMeasure}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-[10px] bg-black/[0.05] py-2 text-[13px] active:bg-black/[0.09]"
        >
          <RotateCw size={14} className={reloading ? "animate-spin" : ""} />
          {reloading ? "正在刷新…" : "重新测量"}
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
