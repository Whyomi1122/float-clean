import type { EnsembleScript } from "./ensemble-storage";
import { parseEnsembleReply } from "./ensemble-parser";
import { simpleLLMCall } from "./api-helpers";
import type { ApiConfig, ImageGenerationSettings } from "./settings-types";
import { loadBindingConfig, loadImageGenerationSettings, resolveAuxiliaryApiConfig } from "./settings-storage";
import { generateImageFromConfiguredApi } from "./image-generation-service";
import { kvGet, kvSet } from "./kv-db";

export type ComicQuote = { id: string; speaker: string; text: string };
export type ComicPanel = { description: string; subjectId?: string; quoteIds: string[]; url?: string; error?: string };
export type ComicBook = { id: string; title: string; quotes: ComicQuote[]; panels: ComicPanel[]; createdAt: string };
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
/** 对白气泡在画面内的落点：数量少时散开，左右交替，避开正中人物脸。 */
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
export async function drawComicPanel(script: EnsembleScript, book: ComicBook, index: number): Promise<string> {
  const settings = loadImageGenerationSettings();
  // 漫画独立画风：不继承真人分镜附加词或全局摄影提示词。
  const options = loadComicImageOptions();
  const comicSettings = { ...settings, provider: options.primary ? "openai" as const : settings.provider, extraPrompt: "", extraPromptNegative: "", activeOpenAiPresetId: options.primary || settings.activeOpenAiPresetId, openaiPresets: settings.openaiPresets?.map(p => ({ ...p, extraPrompt: "", extraPromptNegative: "", size: portraitSize(p.size) })) };
  const fallback = comicSettings.openaiPresets?.find(p => p.id === options.fallback);
  const attempts = [comicSettings, comicSettings, ...(fallback ? [{ ...comicSettings, provider: "openai" as const, activeOpenAiPresetId: fallback.id }] : [])];
  const panel = book.panels[index];
  const style = "韩国网络漫画 style，semi-realistic Korean manhwa / webtoon art style，半写实画风（不是萌系二次元、不是3D、不是真人照片），成熟成年人脸型与体态 mature adult proportions，细线勾勒 clean thin ink lineart，厚涂与柔和渐变着色 painterly soft shading with subtle gradients，低饱和灰调配色 muted desaturated colors，韩漫标志性的冷白皮肤与深色头发 pale skin dark hair，电影感侧逆光 cinematic rim lighting，轻微胶片颗粒 subtle film grain，竖版满版构图 full-bleed vertical panel，主体占画面大部分，画面铺满不留白边，不要画任何对话框、文字、字幕、水印 no text no speech bubble no watermark";
  const continuity = book.panels.map((p, i) => `第${i + 1}格：${p.description}`).join("\n");
  const reference = options.useReference
    ? "可参考所给照片中人物的五官、发型、年龄感与体态，但要转绘成半写实韩漫人物（保留像本人的感觉，同时换成韩漫的线条、肤色与光影），禁止照搬真实皮肤质感、毛孔与照片光影。"
    : "不要参考任何真实照片，人物一律按半写实韩漫风格绘制。";
  const description = `${style}。\n整体四格连续性设定：\n${continuity}\n本次只画第${index + 1}格：${panel.description}\n${reference}`;
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
