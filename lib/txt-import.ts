/**
 * chill / 通用 txt 资料 → float 结构 的解析器（2026-10-10）
 *
 * 背景：用户长期在 chill 写剧情，chill 的「世界书 / 文风规则 / 归档」都是**一整篇 txt**：
 *
 *   【反80世界书·职业线】
 *
 *   ══ 〇、文件职责与优先级 ══
 *   正文……
 *
 *   ══ 一、当前阶段与历史完成状态 ══
 *   正文……
 *
 * 而 float 的世界书要的是 `{ entries: [{ key, content, constant, ... }] }`。
 * 本文件负责把这层「格式」抹平：粘贴 / 选一个 txt，自动切成条目。
 *
 * 设计原则：
 *   · 纯函数、零依赖，便于单测与复用。
 *   · 宽容解析：认不出分隔符时，整篇当成 1 条（绝不丢内容）。
 *   · 常驻判定：kill 世界书/文风这类「长期事实」默认常驻（constant=true），
 *     因为它们本来就是每轮都要在的。
 */

import type { WorldBookConfig, WorldBookEntry } from "./settings-types";

/** 本地 id 生成（与 settings-storage 同规则，避免跨模块导出依赖） */
function generateId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/** 识别到的资料类型 */
export type TxtMaterialKind = "worldbook" | "archive" | "unknown";

/** 解析出的一条（纯中间结构，转世界书条目 / 归档用） */
export type TxtSection = {
    /** 小节标题（══ 〇、xxx ══ 去掉装饰后的文本）；无标题时为空串 */
    title: string;
    /** 小节正文 */
    body: string;
};

/** 顶层标题：形如【反80世界书·职业线】 */
const RE_TOP_TITLE = /^\s*【(.+?)】\s*$/;
/** 小节分隔：形如 ══ 〇、文件职责与优先级 ══ （等号数量 ≥2） */
const RE_SECTION = /^\s*[=＝]{2,}\s*(.+?)\s*[=＝]{2,}\s*$/;
/** 另一种常见写法：── 一、xxx ── 或 #### 一、xxx */
const RE_SECTION_ALT = /^\s*(?:[-—─═=]{2,}|#{2,4})\s*(.+?)\s*(?:[-—─═=]{2,})?\s*$/;

/**
 * 把一整篇 txt 切成若干小节。
 * 支持两种分隔：
 *   ① ══ 标题 ══   （用户实际使用的写法）
 *   ② ── 标题 ── / #### 标题（兼容其他导出）
 * 若一个都没有命中，则整篇作为**单个无标题小节**返回（保底不丢内容）。
 */
export function splitTxtIntoSections(text: string): TxtSection[] {
    const normalized = String(text ?? "").replace(/\r\n?/g, "\n");
    const lines = normalized.split("\n");

    const sections: TxtSection[] = [];
    let curTitle: string | null = null;
    let buffer: string[] = [];

    const flush = () => {
        const body = buffer.join("\n").trim();
        if (curTitle !== null || body) {
            sections.push({ title: curTitle ?? "", body });
        }
        buffer = [];
    };

    for (const raw of lines) {
        const line = raw.trim();
        // 顶层标题【xxx】作为文档名，不作为小节：直接跳过（不进正文）
        if (RE_TOP_TITLE.test(line)) {
            // 但要先结算上一节
            if (curTitle !== null || buffer.some((l) => l.trim())) flush();
            continue;
        }
        const m = line.match(RE_SECTION) ?? line.match(RE_SECTION_ALT);
        if (m) {
            flush();
            curTitle = m[1].trim();
            continue;
        }
        buffer.push(raw);
    }
    flush();

    // 去掉纯空小节
    const kept = sections.filter((s) => s.title || s.body);
    if (kept.length === 0) return [{ title: "", body: normalized.trim() }];
    return kept;
}

/**
 * 猜测这份 txt 属于哪种资料。
 *
 * 判据（按可靠性排序）：
 *   · 明确提到「归档 / 剧情档案 / 当前锚点」→ archive
 *   · 明确提到「世界书 / 文风 / 规则 / 设定」→ worldbook
 *   · 顶层标题含「归档」→ archive
 *   · 其余 → unknown（由用户自己选）
 */
export function guessTxtMaterialKind(text: string): TxtMaterialKind {
    const head = String(text ?? "").slice(0, 600);
    const top = head.match(RE_TOP_TITLE)?.[1] ?? "";
    if (/归档|剧情档案|前情|已发生|当前锚点/.test(top)) return "archive";
    if (/世界书|文风|规则|设定|人物志/.test(top)) return "worldbook";
    if (/当前锚点|已发生且不重播|杀青/.test(head)) return "archive";
    if (/世界书|文风规则|文件职责与优先级|禁词表/.test(head)) return "worldbook";
    return "unknown";
}

/**
 * 从整篇 txt 里提取文档名（【xxx】）；没有则返回兜底名。
 */
export function extractDocTitle(text: string, fallback: string): string {
    const first = String(text ?? "").split("\n").find((l) => l.trim());
    const m = first?.trim().match(RE_TOP_TITLE);
    return m?.[1]?.trim() || fallback;
}

/**
 * txt → WorldBookConfig（float 世界书）。
 *
 * 每个 `══ 标题 ══` 小节 = 1 条条目：
 *   key       = 标题（同时作为主关键词，便于后期改用关键词触发）
 *   comment   = 标题
 *   content   = `【标题】\n正文`（保留标题，和原 txt 观感一致）
 *   constant  = 常驻（世界书/文风默认整篇常在）
 */
export function parseTxtToWorldBook(text: string, nameHint?: string): WorldBookConfig {
    const sections = splitTxtIntoSections(text);
    const name = nameHint?.trim() || extractDocTitle(text, "导入的世界书");
    const now = Date.now();

    let order = 10;
    const entries: WorldBookEntry[] = sections.map((sec) => {
        const key = sec.title || name;
        const content = sec.title ? `【${sec.title}】\n${sec.body}` : sec.body;
        return {
            uid: generateId("wb-entry"),
            key,
            content,
            comment: sec.title || name,
            use_regex: false,
            disable: false,
            constant: true,
            position: "before_char" as const,
            depth: 0,
            probability: 100,
            useProbability: false,
            role: 0,
            insertion_order: order++,
        };
    });

    return {
        id: generateId("wb"),
        name,
        description: "由 txt 一键导入生成",
        createdAt: now,
        updatedAt: now,
        entries,
    };
}

/**
 * txt → 归档正文。
 *
 * 归档不做切分——整篇原样保留（用户要的就是「把这篇前情塞进去」）。
 * 只做 trim 与首尾空行清理。
 */
export function parseTxtToArchive(text: string): string {
    return String(text ?? "").replace(/\r\n?/g, "\n").trim();
}
