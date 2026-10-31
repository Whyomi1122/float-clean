// 临时手机诊断：仅内存保存，不记录密钥、提示词或回复正文。
export type DiagnosticEntry = { time: string; detail: string };
let enabled = false;
let entries: DiagnosticEntry[] = [];
const listeners = new Set<() => void>();
export function enableCallDiagnostics() { enabled = true; }
export function disableCallDiagnostics() { enabled = false; entries = []; }
export function recordCallDiagnostic(detail: string) {
    if (!enabled) return;
    entries = [...entries.slice(-29), { time: new Date().toLocaleTimeString(), detail }];
    listeners.forEach(listener => listener());
}
export function getCallDiagnostics() { return entries; }
export function subscribeCallDiagnostics(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
export function diagnosticEndpoint(raw: string) {
    try {
        const url = new URL(raw, window.location.origin);
        // 查询参数可能含 key；路径只保留接口结构，模型单独显示。
        return `${url.origin}${url.pathname.replace(/\/models\/[^/]+/, "/models/[model]")}`;
    } catch { return "无法解析地址"; }
}
