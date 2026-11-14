// lib/startup-probe.ts
// 启动耗时探针。
//
// 设计（2026-11-14 改）：**每次都静默记录**，不依赖任何开关——开关只管要不要往控制台打印。
// 原因：手机上没有 F12，靠开关极易出现「清除之后就不记录了」这种坑。
// 记录本身只是往数组里 push 几个数字 + 最后写一次 localStorage，开销可以忽略。
//
// 记录点（main-app 里打的）：
//   模块加载 → 挂载 → kv 水合完成 → 主题首屏资产就绪 → 界面可用
// 另外附页面导航三项（DOMContentLoaded / load / JS 求值+首屏），用来区分
// 「慢在等资源」还是「慢在自己算」。

const FLAG_KEY = "float:startup-probe";
const RESULT_KEY = "float:startup-probe:last";

type Mark = { label: string; at: number };

export interface StartupProbeRow {
  label: string;
  totalMs: number;
  gapMs: number;
}

export interface StartupProbeReport {
  at: number;
  rows: StartupProbeRow[];
  nav?: {
    domContentLoadedMs: number;
    loadMs: number;
    scriptMs: number;
  };
}

const marks: Mark[] = [];
let reported = false;

function consoleVerbose(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/** 打一个时间点（总是记录，开销可忽略）。 */
export function startupMark(label: string): void {
  if (typeof window === "undefined") return;
  marks.push({ label, at: now() });
}

/** 生成报告并落盘；控制台打印只在打开开关时做。重复调用只落一次。 */
export function startupReport(): void {
  if (typeof window === "undefined" || reported || marks.length === 0) return;
  reported = true;
  const base = marks[0].at;
  const rows: StartupProbeRow[] = marks.map((mark, index) => ({
    label: mark.label,
    totalMs: Math.round(mark.at - base),
    gapMs: index === 0 ? 0 : Math.round(mark.at - marks[index - 1].at),
  }));

  let navInfo: StartupProbeReport["nav"];
  const nav = typeof performance !== "undefined"
    ? (performance.getEntriesByType?.("navigation")?.[0] as PerformanceNavigationTiming | undefined)
    : undefined;
  if (nav) {
    navInfo = {
      domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd),
      loadMs: Math.round(nav.loadEventEnd || nav.duration),
      scriptMs: Math.round(nav.domContentLoadedEventEnd - nav.responseEnd),
    };
  }

  try {
    const report: StartupProbeReport = { at: Date.now(), rows, nav: navInfo };
    window.localStorage.setItem(RESULT_KEY, JSON.stringify(report));
  } catch {
    // 存不下就算了
  }

  if (consoleVerbose()) {
    // eslint-disable-next-line no-console
    console.table(rows.map(row => ({ 阶段: row.label, 累计ms: row.totalMs, 距上一段ms: row.gapMs })));
    if (navInfo) {
      // eslint-disable-next-line no-console
      console.info("[startup] 页面导航", navInfo);
    }
  }
}

/** 界面可用后调用：等一帧再记录，避免把表格/渲染本身算进去。 */
export function startupReportWhenIdle(): void {
  if (typeof window === "undefined") return;
  const run = () => window.setTimeout(() => startupReport(), 0);
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else run();
}

/** 清掉内存里的时间点，准备下一次测量。 */
export function resetStartupProbeState(): void {
  marks.length = 0;
  reported = false;
}

/** 读出上一次测得的报告（设置页展示用）；没测过返回 null。 */
export function readLastStartupReport(): StartupProbeReport | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(RESULT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StartupProbeReport;
    if (!parsed || !Array.isArray(parsed.rows)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearStartupReport(): void {
  try {
    window.localStorage.removeItem(RESULT_KEY);
  } catch {
    // 忽略
  }
}

/** 控制台是否额外打印（只影响控制台，不影响记录）。 */
export function isStartupProbeEnabled(): boolean {
  return consoleVerbose();
}

export function setStartupProbeEnabled(next: boolean): void {
  try {
    if (typeof window === "undefined") return;
    if (next) window.localStorage.setItem(FLAG_KEY, "1");
    else window.localStorage.removeItem(FLAG_KEY);
  } catch {
    // 隐私模式下写不进去就算了
  }
}
