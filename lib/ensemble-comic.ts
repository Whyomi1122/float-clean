import type { EnsembleScript } from "./ensemble-storage";
import { parseEnsembleReply } from "./ensemble-parser";
import { simpleLLMCall } from "./api-helpers";
import type { ApiConfig, ImageGenerationSettings } from "./settings-types";
import { loadBindingConfig, loadImageGenerationSettings, resolveAuxiliaryApiConfig } from "./settings-storage";
import { generateImageFromConfiguredApi } from "./image-generation-service";
import { kvGet, kvSet } from "./kv-db";

export type ComicQuote = { id: string; speaker: string; text: string };
/** 气泡手工位置：x/y 是相对画面的中心比例，tail 是尾巴方向（0=上，顺时针，-1=无尾巴）。 */
export type ComicBubble = { quoteId: string; x: number; y: number; tail: number };
export type ComicPanel = { description: string; subjectId?: string; quoteIds: string[]; url?: string; error?: string; bubbles?: ComicBubble[] };
export type ComicBook = { id: string; title: string; quotes: ComicQuote[]; panels: ComicPanel[]; createdAt: string; paperMode?: boolean };
export function comicSource(script: EnsembleScript, count: number) {
  const turns = script.turns.slice(-Math.max(1, Math.floor(count)));
  const quotes: ComicQuote[] = [];
  for (const turn of turns) {
    if (turn.senderType === "user") continue;
    const parsed = parseEnsembleReply(turn.content, script.cast);
    for (const [index, segment] of parsed.frames.entries()) {
      if (segment.kind !== "dialogue") continue;
      quotes.push({ id: `${turn.id}:${index}`, speaker: segment.speaker || turn.senderName, text: segment.text });
    }
  }
  return { text: turns.map(t => `${t.senderName}：${t.content}`).join("\n\n"), quotes };
}
/** 没有手工位置时的自动落点：数量少时散开，左右交替。 */
export function bubbleSlot(index: number, total: number): { top: number; side: "left" | "right" } {
  const count = Math.max(1, total);
  const top = count === 1 ? 8 : 4 + (index * 68) / (count - 1);
  return { top, side: index % 2 === 0 ? "right" : "left" };
}
const key = (id: string) => `ensemble-comic:${id}`;

/** 例图那种竖版长图：把横图/方图尺寸换成 2:3 竖图，已是竖图的保持原样。 */
function portraitSize(size?: string): string {
  const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec((size ?? "").trim());
  if (!m) return size ?? "";
  return Number(m[1]) >= Number(m[2]) ? "1024x1536" : size!;
}
export function loadComicBooks(id: string): ComicBook[] {
  try { const value = JSON.parse(kvGet(key(id)) || "[]"); return Array.isArray(value) ? value : []; } catch { return []; }
}
export function saveComicBook(scriptId: string, book: ComicBook) {
  const books = loadComicBooks(scriptId);
  const index = books.findIndex(b => b.id === book.id);
  if (index >= 0) books[index] = book; else books.unshift(book);
  kvSet(key(scriptId), JSON.stringify(books));
}

// ══════════════════════════════════════════════════════════
// 气泡排版：预览（DOM/SVG）与导出（canvas）共用同一份几何计算，
// 保证「拖到哪儿，长图里就在哪儿」。
// ══════════════════════════════════════════════════════════
export type ComicBubbleBox = {
  quoteId: string;
  /** 每个气泡自己的唯一键（一句台词拆成多泡时，key 不能共用 quoteId） */
  id: string;
  speaker: string;
  lines: string[];
  fontSize: number;
  lineHeight: number;
  /** 中心点（px，相对格子左上角） */
  cx: number;
  cy: number;
  w: number;
  h: number;
  tail: number;
  /** 形状：短句用接近正圆的椭圆，长句/旁白用圆角框 */
  shape: "ellipse" | "rect";
  /** 同一句台词拆出来的几泡共用这个锚点，拖动时按它写回 */
  anchorCx: number;
  anchorCy: number;
};

/** 双语句式「「韩语」（中文）」只留中文译文进气泡。 */
export function bubbleText(raw: string): string {
  let text = (raw || "").trim();
  const tail = /[（(]([^（()）]+)[）)]\s*$/.exec(text);
  if (tail && /[「『]/.test(text)) text = tail[1];
  text = text.replace(/^[「『]+|[」』]+$/g, "").replace(/（[^）]*）/g, "").trim();
  return text || raw.trim();
}

const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uff00-\uffef]/;
function charWidth(char: string, fontSize: number): number {
  if (CJK.test(char)) return fontSize;
  if (char === " ") return fontSize * 0.3;
  return fontSize * 0.56;
}
function measure(text: string, fontSize: number): number {
  let width = 0;
  for (const char of text) width += charWidth(char, fontSize);
  return width;
}
function wrapLines(text: string, maxWidth: number, fontSize: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const char of text) {
    if (char === "\n") { lines.push(line); line = ""; continue; }
    if (measure(line + char, fontSize) > maxWidth && line) { lines.push(line); line = char; } else line += char;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

/** 尾巴三角的顶点（相对气泡中心）。返回 [底边1, 尖端, 底边2]。 */
export function bubbleTailPoints(w: number, h: number, tail: number): [number, number][] | null {
  if (tail < 0) return null;
  const deg = tail * 45;
  const rx = w / 2; const ry = h / 2;
  const at = (angle: number): [number, number] => {
    const rad = (angle * Math.PI) / 180;
    return [rx * Math.sin(rad), -ry * Math.cos(rad)];
  };
  const p1 = at(deg - 22); const p2 = at(deg + 22); const edge = at(deg);
  const len = Math.max(rx, ry) * 0.5;
  const norm = Math.hypot(edge[0], edge[1]) || 1;
  const tip: [number, number] = [edge[0] + (edge[0] / norm) * len, edge[1] + (edge[1] / norm) * len];
  return [p1, tip, p2];
}

/** 单泡字数上限：真实漫画一个气泡放不下太多字，超了要拆。 */
export const MAX_BUBBLE_CHARS = 18;

/**
 * 一句台词太长就按标点拆成 2~3 个气泡（真实漫画的连环气泡），
 * 而不是把字硬塞进一个大圈里。
 */
export function splitBubbleText(raw: string): string[] {
  const chars = [...(raw || "").trim()];
  if (chars.length <= MAX_BUBBLE_CHARS) return [chars.join("")];
  const parts = Math.min(3, Math.ceil(chars.length / MAX_BUBBLE_CHARS));
  const target = Math.ceil(chars.length / parts);
  const pieces: string[] = [];
  let buffer = "";
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    buffer += char;
    if (pieces.length >= parts - 1) continue;
    const size = [...buffer].length;
    const rest = chars.length - i - 1;
    const soft = size >= target - 2 && /[。！？!?，、；：…~～—]/.test(char);
    const hard = size >= target + 5 || (size >= target && rest <= MAX_BUBBLE_CHARS);
    if (soft || hard) { pieces.push(buffer); buffer = ""; }
  }
  if (buffer) pieces.push(buffer);
  // 尾巴太短就并回上一泡，别出现「。」单独一个泡
  for (let i = pieces.length - 1; i > 0; i -= 1) {
    if ([...pieces[i]].length < 4) { pieces[i - 1] += pieces[i]; pieces.splice(i, 1); }
  }
  return pieces.length ? pieces : [chars.join("")];
}

/** 单泡尺寸：短句走椭圆，长句走圆角框。 */
function sizeBubble(text: string, width: number) {
  const length = [...text].length;
  const ratio = length <= 10 ? 0.048 : length <= 20 ? 0.04 : 0.034;
  let fontSize = Math.max(9, Math.min(width * 0.1, width * ratio));
  let lineHeight = fontSize * 1.5;
  const padX = fontSize * 0.95;
  const padY = fontSize * 0.75;
  // 太长（或本来就是旁白式长句）用圆角框，短句才用接近正圆的椭圆。
  const shape: "ellipse" | "rect" = length > 26 ? "rect" : "ellipse";
  const maxTextWidth = (shape === "rect" ? width * 0.44 : width * 0.34) - padX * 2;
  const lines = wrapLines(text, maxTextWidth, fontSize);
  const textWidth = Math.max(...lines.map(line => measure(line, fontSize)), fontSize * 1.2);
  let w: number;
  let h: number;
  if (shape === "rect") {
    w = Math.min(width * 0.5, textWidth + padX * 2);
    h = lines.length * lineHeight + padY * 2;
  } else {
    // 椭圆按「内接矩形」算：文字块半宽 W、半高 H 满足 (W/a)² + (H/b)² = 1，
    // 目标宽高比 R=1.12（接近正圆、略宽），解出 a、b，文字就不会顶出弧线。
    const R = 1.12;
    const W = (textWidth / 2) * 1.12 + padX * 0.3;
    const H = (((lines.length - 1) * lineHeight + fontSize) / 2) * 1.12 + padY * 0.3;
    const b = Math.sqrt((W * W) / (R * R) + H * H);
    w = 2 * R * b;
    h = 2 * b;
    const limit = width * 0.46;
    if (w > limit) {
      const k = limit / w;
      w *= k; h *= k; fontSize *= k; lineHeight *= k;
    }
  }
  return { lines, fontSize, lineHeight, w, h, shape };
}

/** 按格子实际像素尺寸排版：preview 传渲染尺寸，导出传 1080 宽。 */
export function layoutComicBubbles(panel: ComicPanel, quotes: ComicQuote[], width: number, height: number): ComicBubbleBox[] {
  const boxes: ComicBubbleBox[] = [];
  if (width <= 0 || height <= 0) return boxes;
  const autos = autoBubbleRatios(panel);
  panel.quoteIds.forEach((id, index) => {
    const quote = quotes.find(q => q.id === id);
    const parts = splitBubbleText(bubbleText(quote?.text ?? ""));
    const manual = panel.bubbles?.find(b => b.quoteId === id);
    const auto = autos[index] ?? { quoteId: id, x: 0.76, y: 0.5, tail: -1 };
    const anchorX = (manual ? manual.x : auto.x) * width;
    const anchorY = (manual ? manual.y : auto.y) * height;
    const sized = parts.map(part => sizeBubble(part, width));
    const gap = (sized[0]?.fontSize ?? width * 0.04) * 0.55;
    let totalH = sized.reduce((sum, s) => sum + s.h, 0) + gap * (sized.length - 1);
    // 一格里堆太多行时整体等比缩小，别顶出格子
    if (totalH > height * 0.94) {
      const k = (height * 0.94) / totalH;
      sized.forEach(s => { s.w *= k; s.h *= k; s.fontSize *= k; s.lineHeight *= k; });
      totalH *= k;
    }
    // 整组（拆出来的几泡）作为一体夹在格子内，避免上下一推就互相叠住
    const marginY = height * 0.015;
    let top = anchorY - totalH / 2;
    const maxTop = height - totalH - marginY;
    if (maxTop <= marginY) top = marginY;
    else top = Math.min(maxTop, Math.max(marginY, top));
    sized.forEach((s, partIndex) => {
      // 几泡之间左右错开一点，像手摆的连环气泡
      const stagger = sized.length > 1 ? (partIndex % 2 === 0 ? -1 : 1) * width * 0.025 : 0;
      const halfX = s.w / 2 / width;
      const cx = Math.min(1 - halfX - 0.01, Math.max(halfX + 0.01, (anchorX + stagger) / width)) * width;
      const cy = top + s.h / 2;
      boxes.push({
        quoteId: id, id: `${id}#${partIndex}`, speaker: quote?.speaker ?? "",
        lines: s.lines, fontSize: s.fontSize, lineHeight: s.lineHeight,
        cx, cy, w: s.w, h: s.h, tail: -1, shape: s.shape,
        anchorCx: anchorX, anchorCy: anchorY,
      });
      top += s.h + gap;
    });
  });
  return boxes;
}

/** 自动落点的比例值（没手工拖过时用它）。气泡不带尾巴，例图那种干净的椭圆。 */
export function autoBubbleRatios(panel: ComicPanel): ComicBubble[] {
  return panel.quoteIds.map((quoteId, index) => {
    const slot = bubbleSlot(index, panel.quoteIds.length);
    const x = slot.side === "right" ? 0.76 : 0.24;
    return { quoteId, x, y: 0.1 + (slot.top / 100) * 0.8, tail: -1 };
  });
}

/** 拖动结束后写回画面坐标（比例值）；同一格其它气泡补上自动位置。 */
export function moveComicBubble(panel: ComicPanel, quoteId: string, x: number, y: number): ComicBubble[] {
  const auto = autoBubbleRatios(panel);
  const base = panel.bubbles?.length ? panel.bubbles : auto;
  const merged = base.some(b => b.quoteId === quoteId) ? base : [...base, ...auto.filter(b => b.quoteId === quoteId)];
  return merged.map(b => (b.quoteId === quoteId ? { ...b, x, y, tail: -1 } : b));
}

/**
 * 漫画分镜脚本用哪个模型：绑定页「漫画分镜 API」配了就优先用它，
 * 没配沿用「下一步走向 API」，再没有就回落全局 —— 与心情音乐同口径。
 */
function resolvePlanConfig(): ApiConfig | undefined {
    try {
        if (loadBindingConfig().comicApiConfigId) {
            const comic = resolveAuxiliaryApiConfig("comicApiConfigId");
            if (comic) return comic;
        }
        if (loadBindingConfig().storyDirectionApiConfigId) {
            const story = resolveAuxiliaryApiConfig("storyDirectionApiConfigId");
            if (story) return story;
        }
    } catch { /* fallthrough */ }
    return resolveAuxiliaryApiConfig("comicApiConfigId") ?? undefined;
}
export type ComicImageOptions = { primary: string; fallback: string; useReference: boolean };
export function loadComicImageOptions(): ComicImageOptions {
  try { return { primary: "", fallback: "", useReference: false, ...JSON.parse(kvGet("ensemble-comic-image-options") || "{}") }; } catch { return { primary: "", fallback: "", useReference: false }; }
}
export function saveComicImageOptions(value: ComicImageOptions) { kvSet("ensemble-comic-image-options", JSON.stringify(value)); }
export function comicImagePresets() { return loadImageGenerationSettings().openaiPresets ?? []; }
export async function planComic(script: EnsembleScript, count: number, request: string, quotes: ComicQuote[]): Promise<ComicBook> {
  const config = resolvePlanConfig();
  if (!config) throw new Error("请先配置可用的文字 API");
  const result = await simpleLLMCall(config, [
    { role: "system", content: `你是精细彩色韩漫分镜导演。只改编用户提供的已发生剧情，不续写、不新增事件，不替用户作决定。输出严格 JSON：{"title":"标题","panels":[{"description":"单格画面描述","subjectId":"画面主角ID或空","quoteIds":["选中对白ID"]}]}。恰好4格，组成适合手机竖向阅读的连贯短篇。远景交代→动作互动→表情特写→余韵，景别有变化，服饰、场景、人物外貌保持连续。每格只画一个瞬间，描述必须含人物名字、动作、表情、景别和光线，不要排版文字，不要将4格拼成一张。用户勾选的每句对白必须分配且只用一次，只能引用提供的ID，不改台词；没有台词的格子quoteIds为空。不要把韩国背景一律改成首尔或校园，以原剧情为准。` },
    { role: "user", content: JSON.stringify({ cast: script.cast.map(c => ({ id: c.id, name: c.name, persona: c.persona })), background: script.background, story: comicSource(script, count).text, request: request.trim() || "自选最有画面感的连续片段", quotes }) },
  ], { max_tokens: 4000, temperature: 0.6 });
  if (!result.content) throw new Error(result.error || "分镜脚本为空");
  const raw = result.content.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const start = raw.indexOf("{"); const end = raw.lastIndexOf("}");
  const data = JSON.parse(raw.slice(start, end + 1));
  if (!Array.isArray(data.panels) || data.panels.length !== 4) throw new Error("脚本必须包含四格，请重新生成");
  const allowed = new Set(quotes.map(q => q.id)); const used = new Set<string>();
  const panels: ComicPanel[] = data.panels.map((p: Record<string, unknown>) => {
    if (typeof p.description !== "string" || !p.description.trim()) throw new Error("分镜画面描述不完整");
    const ids = Array.isArray(p.quoteIds) ? p.quoteIds.filter((id): id is string => typeof id === "string" && allowed.has(id) && !used.has(id)) : [];
    ids.forEach(id => used.add(id));
    return { description: p.description, subjectId: typeof p.subjectId === "string" && script.cast.some(c => c.id === p.subjectId) ? p.subjectId : undefined, quoteIds: ids };
  });
  // 模型偶尔会漏分配台词：不报错，按顺序补进已有台词最少的格子里。
  const leftover = quotes.filter(q => !used.has(q.id)).map(q => q.id);
  leftover.forEach(id => {
    let target = 0;
    panels.forEach((panel, i) => { if (panel.quoteIds.length < panels[target].quoteIds.length) target = i; });
    panels[target].quoteIds.push(id); used.add(id);
  });
  return { id: crypto.randomUUID(), title: String(data.title || "漫画分镜"), quotes, panels, createdAt: new Date().toISOString() };
}

/**
 * 画风：按用户提供的小红书资料组装（10.3 韩漫软赛璐璐配方 + 表 7 韩漫本体特征），
 * 再加一句题材方言（表 8），避免每次都画成同一个调子。
 */
function manhwaStyle(description: string): string {
  const dialect = /学校|教室|校服|操场|图书馆|走廊/.test(description)
    ? "school romance webtoon, classroom, uniform, blush"
    : /豪宅|宴会|晚宴|别墅|豪车|会议室|西装|会长/.test(description)
      ? "chaebol drama, luxury interior, tailored suit, cold gaze"
      : /家|厨房|客厅|卧室|餐桌|沙发|母亲|父亲|冰箱/.test(description)
        ? "family drama webtoon, muted palette, natural light"
        : "modern romance webtoon, city life, muted palette, natural light";
  return [
    "Style: Korean manhwa, Korean webtoon illustration, full color, vertical tall panel, full-bleed composition, character fills most of the frame",
    `Genre: ${dialect}`,
    "Character: semi-realistic proportions, 8-head figure, elongated slim limbs, mature adult faces",
    "Skin: smooth skin gradient, soft shadow plane, luminous skin, peach-blush skin tone",
    "Eyes: multi-layer iris, two-point eye catchlight, heavy lash detail",
    "Hair: detailed hair strands, glossy hair highlight, glass-shine overlay",
    "Lineart: clean thin ink outline in warm dark tone, not pure black",
    "Shading: soft cel with airbrushed gradients, no hard shadow edges, subtle inner glow",
    "Palette: low-saturation muted palette, cinematic warm light, rose-gold highlight, deep navy shadow",
    "Light: cinematic side light, rim light, halo light, subtle film grain, slight paper texture",
    "Negative: no text, no letters, no speech bubble, no caption, no watermark, no 3D render, no photorealistic skin, no chibi",
    "中文要求：半写实韩式条漫、成年人体型、低饱和冷灰调、细腻皮肤渐变、发丝分组、细墨线勾边、竖版满版构图；不要萌系大眼、不要 3D 渲染、不要真人照片感；画面里不要出现任何文字、字母或对话框。",
  ].join("\n");
}

export async function drawComicPanel(script: EnsembleScript, book: ComicBook, index: number): Promise<string> {
  const settings = loadImageGenerationSettings();
  // 漫画独立画风：不继承真人分镜附加词或全局摄影提示词。
  const options = loadComicImageOptions();
  const comicSettings = { ...settings, provider: options.primary ? "openai" as const : settings.provider, extraPrompt: "", extraPromptNegative: "", activeOpenAiPresetId: options.primary || settings.activeOpenAiPresetId, openaiPresets: settings.openaiPresets?.map(p => ({ ...p, extraPrompt: "", extraPromptNegative: "", size: portraitSize(p.size) })) };
  const fallback = comicSettings.openaiPresets?.find(p => p.id === options.fallback);
  const attempts = [comicSettings, comicSettings, ...(fallback ? [{ ...comicSettings, provider: "openai" as const, activeOpenAiPresetId: fallback.id }] : [])];
  const panel = book.panels[index];
  const style = manhwaStyle(panel.description);
  const continuity = book.panels.map((p, i) => `第${i + 1}格：${p.description}`).join("\n");
  const reference = options.useReference
    ? "可参考所给照片中人物的五官、发型、年龄感与体态，但要转绘成半写实韩漫人物（保留像本人的感觉，线条、肤色与光影全部换成韩漫的），禁止照搬真实皮肤质感、毛孔与照片光影。"
    : "不要参考任何真实照片，人物一律按半写实韩漫风格绘制。";
  const description = `${style}\n整体四格连续性设定：\n${continuity}\n本次只画第${index + 1}格：${panel.description}\n${reference}`;
  let lastError = "";
  // 自动重试一次：中转偶发超时/限流时不让整组漫画废掉。
  for (let attempt = 0; attempt < attempts.length; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1500));
    try {
      const result = await generateImageFromConfiguredApi({
        settings: attempts[attempt],
        description,
        app: "ensemble-comic", characterId: panel.subjectId,
        useReferenceImage: Boolean(options.useReference && panel.subjectId && settings.characterReferences?.[panel.subjectId]?.assetId),
      });
      if (!result) throw new Error("未返回图片，请检查生图配置");
      return result.dataUrl;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "生图失败";
    }
  }
  throw new Error(lastError);
}
