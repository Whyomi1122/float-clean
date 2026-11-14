// lib/startup-probe.ts
// 启动耗时探针：默认完全不生效（零日志、零开销），只有打开开关才记录。
//
// 用法：
//   1. 打开小手机 → 浏览器控制台执行：
//        localStorage.setItem("float:startup-probe", "1")
//   2. 刷新页面，等界面出来后会打印一张「启动耗时」表；
//      表里「累计」是相对第一段的毫秒数，「距上一段」是哪一步之间花掉的。
//   3. 测完关掉：localStorage.removeItem("float:startup-probe")
//
// 记录点（目前）：
//   main-app 模块加载 → main-app 挂载 → 首屏主题资产请求 → kv 水合完成 → 界面可用
// 这些数字能分出「慢在 JS 求值」还是「慢在 IndexedDB」。

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

function probeEnabled(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

/** 探针是否开启（界面上用来提示「已开启/已关闭」）。 */
export function isStartupProbeEnabled(): boolean {
  return probeEnabled();
}

/** 开启/关闭探针（开启后下一次刷新才会记录）。 */
export function setStartupProbeEnabled(next: boolean): void {
  try {
    if (typeof window === "undefined") return;
    if (next) window.localStorage.setItem(FLAG_KEY, "1");
    else window.localStorage.removeItem(FLAG_KEY);
  } catch {
    // 隐私模式下写不进去就算了
  }
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

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/** 打一个时间点；未开启探针时立即返回。 */
export function startupMark(label: string): void {
  if (!probeEnabled()) return;
  marks.push({ label, at: now() });
}

/** 打印耗时表（重复调用只打印一次），并把结果存下来给设置页看。 */
export function startupReport(): void {
  if (!probeEnabled() || reported || marks.length === 0) return;
  reported = true;
  const base = marks[0].at;
  const rows: StartupProbeRow[] = marks.map((mark, index) => ({
    label: mark.label,
    totalMs: Math.round(mark.at - base),
    gapMs: index === 0 ? 0 : Math.round(mark.at - marks[index - 1].at),
  }));
  // eslint-disable-next-line no-console
  console.table(rows.map(row => ({ 阶段: row.label, 累计ms: row.totalMs, 距上一段ms: row.gapMs })));

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
    // eslint-disable-next-line no-console
    console.info("[startup] 页面导航", navInfo);
  }

  try {
    const report: StartupProbeReport = { at: Date.now(), rows, nav: navInfo };
    window.localStorage.setItem(RESULT_KEY, JSON.stringify(report));
  } catch {
    // 存不下就算了，控制台那一眼也够用
  }
}

/** 在界面可用后调用：等一帧再打表，避免把表格本身算进启动耗时。 */
export function startupReportWhenIdle(): void {
  if (!probeEnabled()) return;
  const run = () => window.setTimeout(() => startupReport(), 0);
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else run();
}
