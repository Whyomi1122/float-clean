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

type Mark = { label: string; at: number };

const marks: Mark[] = [];
let reported = false;

function probeEnabled(): boolean {
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

/** 打一个时间点；未开启探针时立即返回。 */
export function startupMark(label: string): void {
  if (!probeEnabled()) return;
  marks.push({ label, at: now() });
}

/** 打印耗时表（重复调用只打印一次）。 */
export function startupReport(): void {
  if (!probeEnabled() || reported || marks.length === 0) return;
  reported = true;
  const base = marks[0].at;
  const rows = marks.map((mark, index) => ({
    阶段: mark.label,
    累计ms: Math.round(mark.at - base),
    距上一段ms: index === 0 ? 0 : Math.round(mark.at - marks[index - 1].at),
  }));
  // eslint-disable-next-line no-console
  console.table(rows);
  const nav = typeof performance !== "undefined" ? (performance.getEntriesByType?.("navigation")?.[0] as PerformanceNavigationTiming | undefined) : undefined;
  if (nav) {
    // eslint-disable-next-line no-console
    console.info("[startup] 页面导航", {
      "DOMContentLoaded(ms)": Math.round(nav.domContentLoadedEventEnd),
      "load(ms)": Math.round(nav.loadEventEnd || nav.duration),
      "JS 求值+首屏(ms)": Math.round(nav.domContentLoadedEventEnd - nav.responseEnd),
    });
  }
}

/** 在界面可用后调用：等一帧再打表，避免把表格本身算进启动耗时。 */
export function startupReportWhenIdle(): void {
  if (!probeEnabled()) return;
  const run = () => window.setTimeout(() => startupReport(), 0);
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else run();
}
