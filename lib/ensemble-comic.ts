import type { EnsembleScript } from "./ensemble-storage";
import { parseEnsembleReply } from "./ensemble-parser";
import { simpleLLMCall } from "./api-helpers";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { generateImageFromConfiguredApi } from "./image-generation-service";
import { loadImageGenerationSettings } from "./settings-storage";
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
const key = (id: string) => `ensemble-comic:${id}`;
export function loadComicBooks(id: string): ComicBook[] {
  try { const value = JSON.parse(kvGet(key(id)) || "[]"); return Array.isArray(value) ? value : []; } catch { return []; }
}
export function saveComicBook(scriptId: string, book: ComicBook) {
  const books = loadComicBooks(scriptId);
  const index = books.findIndex(b => b.id === book.id);
  if (index >= 0) books[index] = book; else books.unshift(book);
  kvSet(key(scriptId), JSON.stringify(books));
}
export async function planComic(script: EnsembleScript, count: number, request: string, quotes: ComicQuote[]): Promise<ComicBook> {
  const config = resolveAuxiliaryApiConfig("storyDirectionApiConfigId");
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
  if (used.size !== allowed.size) throw new Error("脚本漏掉了选中的对白，请减少对白或重新生成");
  return { id: crypto.randomUUID(), title: String(data.title || "漫画分镜"), quotes, panels, createdAt: new Date().toISOString() };
}
export async function drawComicPanel(script: EnsembleScript, book: ComicBook, index: number): Promise<string> {
  const settings = loadImageGenerationSettings();
  // 漫画独立画风：不继承真人分镜附加词或全局摄影提示词。
  const comicSettings = { ...settings, extraPrompt: "", extraPromptNegative: "", openaiPresets: settings.openaiPresets?.map(p => ({ ...p, extraPrompt: "", extraPromptNegative: "" })) };
  const panel = book.panels[index];
  const result = await generateImageFromConfiguredApi({
    settings: comicSettings,
    description: `Premium full-color Korean webtoon illustration, refined line art, expressive drawn faces, sophisticated cel shading, detailed environments, consistent character design. NOT a photograph, NOT live action, no photorealistic skin. Single portrait comic panel, no text, no letters, no speech bubbles, no collage.\n连续性设定：${book.panels.map(p => p.description).join("\n")}\n只画第${index + 1}格：${panel.description}\n参考照片仅用于识别人物五官、发型和特征，必须转绘为精细韩漫人物，不继承摄影风格。`,
    app: "ensemble-comic", characterId: panel.subjectId,
    useReferenceImage: Boolean(panel.subjectId && settings.characterReferences?.[panel.subjectId]?.assetId),
  });
  if (!result) throw new Error("未返回图片，请检查生图配置");
  return result.dataUrl;
}
