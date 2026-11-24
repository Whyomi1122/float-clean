"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import localFont from "next/font/local";
import { Check, Loader2, RotateCcw } from "lucide-react";
import { Toggle } from "@/components/ui/form";
import type { EnsembleScript } from "@/lib/ensemble-storage";
import {
  comicImagePresets,
  comicSource,
  drawComicPanel,
  layoutComicBubbles,
  loadComicBooks,
  loadComicImageOptions,
  moveComicBubble,
  planComic,
  saveComicBook,
  saveComicImageOptions,
  type ComicBook,
  type ComicPanel,
  type ComicQuote,
} from "@/lib/ensemble-comic";
import { exportComic } from "@/lib/ensemble-comic-export";

/** 得意黑（Smiley Sans）—— 气泡专用字体。走 next/font 官方管线，避免手写 @font-face 加载失败。 */
const comicFont = localFont({ src: "../../public/fonts/comic-deyi.otf", display: "swap", fallback: ["sans-serif"] });

// ══════════════════════════════════════════════════════════
// 漫画分镜（内容组件）
// 只负责内容，外壳（标题 / 遮罩 / 关闭）交给 ensemble-app 的 MiniSheet，
// 所以样式统一用工具页那一套：白卡 rounded-[16px]、12px 正文、主色按钮。
// ══════════════════════════════════════════════════════════

/** 量出格子实际渲染尺寸，气泡排版按真实像素算（导出按 1080 宽算，比例一致）。 */
function useFrameSize() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sync = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, size };
}

function Bubbles({
  panel,
  quotes,
  url,
  onMove,
  onOpen,
}: {
  panel: ComicPanel;
  quotes: ComicQuote[];
  url: string;
  onMove: (quoteId: string, x: number, y: number) => void;
  onOpen: () => void;
}) {
  const { ref, size } = useFrameSize();
  const drag = useRef<{ quoteId: string; startX: number; startY: number; cx: number; cy: number; moved: boolean } | null>(null);
  const [offset, setOffset] = useState<{ quoteId: string; dx: number; dy: number } | null>(null);
  const boxes = size.w > 0 && size.h > 0 ? layoutComicBubbles(panel, quotes, size.w, size.h) : [];

  const handleDown = (event: React.PointerEvent<HTMLDivElement>, quoteId: string, cx: number, cy: number) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { quoteId, startX: event.clientX, startY: event.clientY, cx, cy, moved: false };
  };
  const handleMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (!current.moved && Math.hypot(dx, dy) < 5) return;
    current.moved = true;
    setOffset({ quoteId: current.quoteId, dx, dy });
  };
  const handleUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    drag.current = null;
    setOffset(null);
    if (!current) return;
    if (!current.moved) return;
    onMove(
      current.quoteId,
      Math.min(0.97, Math.max(0.03, (current.cx + event.clientX - current.startX) / size.w)),
      Math.min(0.97, Math.max(0.03, (current.cy + event.clientY - current.startY) / size.h)),
    );
  };

  return (
    <div ref={ref} className="relative" onClick={onOpen}>
      <img src={url} alt="" className="block w-full h-auto" />
      {boxes.map(box => {
        const shift = offset && offset.quoteId === box.quoteId ? offset : null;
        const left = box.cx - box.w / 2 + (shift?.dx ?? 0);
        const top = box.cy - box.h / 2 + (shift?.dy ?? 0);
        return (
          <div
            key={box.id}
            className="absolute touch-none select-none"
            style={{ left, top, width: box.w, height: box.h }}
            onPointerDown={event => handleDown(event, box.quoteId, box.anchorCx, box.anchorCy)}
            onPointerMove={handleMove}
            onPointerUp={handleUp}
            onPointerCancel={handleUp}
            onClick={event => event.stopPropagation()}
          >
            <svg className="absolute inset-0" width={box.w} height={box.h} viewBox={`0 0 ${box.w} ${box.h}`}>
              {box.shape === "rect" ? (
                <rect
                  x={1} y={1} width={box.w - 2} height={box.h - 2}
                  rx={Math.min(box.fontSize * 0.9, box.w / 4)} ry={Math.min(box.fontSize * 0.9, box.h / 4)}
                  fill="#fff" stroke="#1c1c1c" strokeWidth={Math.max(1.2, box.fontSize * 0.09)}
                />
              ) : (
                <ellipse cx={box.w / 2} cy={box.h / 2} rx={box.w / 2 - 1} ry={box.h / 2 - 1} fill="#fff" stroke="#1c1c1c" strokeWidth={Math.max(1.2, box.fontSize * 0.09)} />
              )}
            </svg>
            <div
              className={`absolute inset-0 flex items-center text-[#1c1c1c] ${box.shape === "rect" ? "justify-start" : "justify-center text-center"}`}
              style={{ fontFamily: comicFont.style.fontFamily, fontSize: box.fontSize, lineHeight: `${box.lineHeight}px` }}
            >
              <div style={box.shape === "rect" ? { paddingLeft: box.fontSize * 0.95, paddingRight: box.fontSize * 0.95 } : undefined}>
                {box.lines.map((line, i) => <div key={i}>{line}</div>)}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function EnsembleComicSheet({ script }: { script: EnsembleScript }) {
  const [count, setCount] = useState("6");
  const [request, setRequest] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [books, setBooks] = useState(() => loadComicBooks(script.id));
  // 上次没做完的草稿直接接着做，关掉页面再进来不用重新生成脚本。
  const [book, setBook] = useState<ComicBook | null>(() => loadComicBooks(script.id)[0] ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [imageOptions, setImageOptions] = useState(loadComicImageOptions);
  const [exporting, setExporting] = useState(false);
  const running = useRef(false);
  const presets = comicImagePresets();
  const n = Number(count);
  const valid = Number.isInteger(n) && n > 0 && n <= script.turns.length;
  const source = comicSource(script, valid ? n : 1);

  function updateOptions(patch: Partial<typeof imageOptions>) {
    const next = { ...imageOptions, ...patch };
    setImageOptions(next); saveComicImageOptions(next);
  }
  function persist(next: ComicBook) {
    saveComicBook(script.id, next); setBook({ ...next, panels: [...next.panels] }); setBooks(loadComicBooks(script.id));
  }
  function patchPanel(index: number, patch: Partial<ComicPanel>) {
    if (!book) return;
    persist({ ...book, panels: book.panels.map((p, i) => i === index ? { ...p, ...patch } : p) });
  }
  async function plan() {
    if (!valid || running.current) return;
    running.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const generated = await planComic(script, n, request, source.quotes.filter(q => selected.includes(q.id)));
      persist(generated);
      setNotice(`已生成四格脚本并保存为草稿，选 ${generated.quotes.length} 句对白`);
    } catch (e) { setError(e instanceof Error ? e.message : "脚本生成失败"); }
    finally { running.current = false; setBusy(false); }
  }
  async function draw(indices: number[]) {
    if (!book || running.current) return;
    running.current = true; setBusy(true); setError(""); setNotice("");
    const next = { ...book, panels: book.panels.map(p => ({ ...p })) };
    try {
      for (const index of indices) {
        try { next.panels[index].url = await drawComicPanel(script, next, index); next.panels[index].error = undefined; }
        catch (e) { next.panels[index].error = e instanceof Error ? e.message : "生图失败"; }
        persist(next);
      }
    } finally {
      running.current = false; setBusy(false);
      const failed = next.panels.filter(p => !p.url).length;
      window.dispatchEvent(new CustomEvent("ensemble-comic-complete", { detail: failed ? `漫画制作结束，${failed}格待重试` : "四格漫画已完成" }));
    }
  }
  async function downloadComic() {
    if (!book || exporting) return;
    setExporting(true); setError("");
    try {
      const blob = await exportComic(book, comicFont.style.fontFamily);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = `${book.title}.png`; link.rel = "noopener";
      // Safari 要 a 真的挂在文档里才会触发下载，没挂载就表现为「点导出没反应」
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { setError(e instanceof Error ? e.message : "导出失败"); }
    finally { setExporting(false); }
  }

  const rowClass = "flex items-center gap-2 text-[12px] text-[#111111]";
  const buttonClass = (active: boolean) => `shrink-0 px-3.5 py-2 rounded-[11px] text-[12px] font-medium transition-all ${active ? "bg-[var(--c-primary)] text-white active:scale-[0.97]" : "bg-black/[0.06] text-black/25"}`;

  return (
    <div>
      <details className="bg-white rounded-[16px] p-3 mb-3">
        <summary className="text-[12px] text-[#111111] cursor-pointer list-none flex items-center justify-between">
          <span>漫画生图配置</span>
          <span className="text-[10px] text-black/30">主用 / 备用 / 锁脸</span>
        </summary>
        <div className="space-y-2 pt-3">
          <label className={rowClass}>
            <span className="w-14 shrink-0 text-black/45">主用</span>
            <select value={imageOptions.primary} disabled={busy} onChange={e => updateOptions({ primary: e.target.value })} className="flex-1 min-w-0 h-9 px-2 rounded-[10px] bg-black/[0.04] text-[12px] outline-none">
              <option value="">沿用全局生图</option>
              {presets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className={rowClass}>
            <span className="w-14 shrink-0 text-black/45">备用</span>
            <select value={imageOptions.fallback} disabled={busy} onChange={e => updateOptions({ fallback: e.target.value })} className="flex-1 min-w-0 h-9 px-2 rounded-[10px] bg-black/[0.04] text-[12px] outline-none">
              <option value="">不使用备用</option>
              {presets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className={`${rowClass} justify-between`}>
            <span className="text-black/45">锁脸参考图</span>
            <Toggle checked={imageOptions.useReference} disabled={busy} onChange={next => updateOptions({ useReference: next })} />
          </label>
          <p className="text-[10px] leading-relaxed text-black/30">参考照片会把画风拉向真人，建议关闭后对比一次。失败会重试一次再试备用；请求可能计费。</p>
        </div>
      </details>

      {busy && <div className="flex items-center gap-2 text-[11.5px] text-black/40 py-2"><Loader2 size={13} className="animate-spin" />正在制作，可收起后继续聊天，请保持页面开启</div>}
      {notice && <div className="text-[11px] leading-relaxed text-black/40 mb-2">{notice}</div>}
      {error && <div className="text-[11.5px] leading-relaxed text-[#c0392b] bg-[#c0392b]/[0.06] rounded-[10px] px-2.5 py-2 mb-2">{error}</div>}

      {!book ? (
        <>
          <div className="bg-white rounded-[16px] p-3 mb-3">
            <div className={`${rowClass} mb-2`}>
              <span className="text-black/45">最近</span>
              <input type="number" min="1" max={script.turns.length} value={count} onChange={e => { setCount(e.target.value); setSelected([]); }} className="w-14 h-8 text-center rounded-[9px] bg-black/[0.04] text-[12px] outline-none" />
              <span className="text-black/35">轮剧情</span>
              <button type="button" onClick={plan} disabled={!valid || busy} className={`ml-auto ${buttonClass(valid && !busy)}`}>生成四格脚本</button>
            </div>
            <textarea value={request} onChange={e => setRequest(e.target.value)} placeholder="想画哪一段？例如「超市选果酱」，留空由模型自选" className="w-full h-[54px] bg-transparent text-[12px] leading-relaxed text-[#111111] placeholder:text-black/25 outline-none resize-none" />
          </div>

          <div className="text-[10px] text-black/30 px-1 mb-2">勾选要进画面的对白，可以不选</div>
          <div className="space-y-1.5 mb-3 max-h-[34vh] overflow-y-auto">
            {source.quotes.length === 0 && <div className="text-center text-[11px] text-black/30 py-6">这段剧情里没有对白，可以直接生成纯画面四格</div>}
            {source.quotes.map(q => {
              const checked = selected.includes(q.id);
              return (
                <button
                  key={q.id}
                  type="button"
                  onClick={() => setSelected(s => checked ? s.filter(id => id !== q.id) : [...s, q.id])}
                  className="w-full flex gap-2.5 bg-white rounded-[12px] p-2.5 text-left transition-transform active:scale-[0.995]"
                >
                  <span className={`mt-0.5 grid place-items-center w-[18px] h-[18px] rounded-full shrink-0 transition-colors ${checked ? "bg-[var(--c-primary)] text-white" : "border border-black/[0.14] text-transparent"}`}>
                    <Check size={11} strokeWidth={3.2} />
                  </span>
                  <span className="min-w-0">
                    <span className={`block text-[10px] mb-0.5 ${checked ? "text-black/35" : "text-black/25"}`}>{q.speaker}</span>
                    <span className={`block text-[12px] leading-[1.6] break-words ${checked ? "text-[#111111]" : "text-black/45"}`}>{q.text}</span>
                  </span>
                </button>
              );
            })}
          </div>

          {books.length > 0 && (
            <>
              <div className="text-[10px] text-black/30 px-1 mb-2">我的漫画</div>
              <div className="space-y-1.5">
                {books.map(item => (
                  <button key={item.id} type="button" onClick={() => setBook(item)} className="w-full flex items-center justify-between gap-3 bg-white rounded-[12px] px-3 py-2.5 text-left active:scale-[0.995] transition-transform">
                    <span className="min-w-0 text-[12px] text-[#111111] truncate">{item.title}</span>
                    <span className="shrink-0 text-[10px] text-black/30">{item.panels.filter(p => p.url).length}/4</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="min-w-0 text-[12px] text-[#111111] truncate">{book.title}</span>
            <button type="button" onClick={() => setBook(null)} className="shrink-0 text-[11px] text-black/45">← 新的一本</button>
          </div>

          <label className="flex items-center justify-between bg-white rounded-[12px] px-3 py-2 mb-2">
            <span className="text-[11px] text-black/45">纸漫白缝（格与格之间留白边）</span>
            <Toggle checked={Boolean(book.paperMode)} onChange={next => persist({ ...book, paperMode: next })} />
          </label>

          <div className={book.paperMode ? "space-y-2.5" : "space-y-0"}>
            {book.panels.map((p, i) => (
              <article key={i} className={`bg-white overflow-hidden ${book.paperMode ? "rounded-[12px] border border-black/70" : i === 0 ? "rounded-t-[16px]" : i === book.panels.length - 1 ? "rounded-b-[16px]" : ""}`}>
                {p.url ? (
                  <Bubbles
                    panel={p}
                    quotes={book.quotes}
                    url={p.url}
                    onOpen={() => setPreview(p.url!)}
                    onMove={(quoteId, x, y) => patchPanel(i, { bubbles: moveComicBubble(p, quoteId, x, y) })}
                  />
                ) : (
                  <textarea value={p.description} disabled={busy} onChange={e => patchPanel(i, { description: e.target.value })} aria-label={`第${i + 1}格画面`} className="w-full min-h-[92px] p-3 bg-transparent text-[12px] leading-[1.7] text-[#111111] outline-none resize-y" />
                )}
                {!p.url && p.quoteIds.length > 0 && (
                  <div className="px-3 pb-2 space-y-1">
                    {p.quoteIds.map(id => {
                      const q = book.quotes.find(v => v.id === id);
                      return q ? <div key={id} className="text-[11px] text-black/45"><span className="text-black/25 mr-1">{q.speaker}</span>{q.text}</div> : null;
                    })}
                    <div className="text-[10px] text-black/25">出图后气泡会叠在画面里，可拖动位置</div>
                  </div>
                )}
                {p.error && <div className="px-3 pb-2 text-[11px] text-[#c0392b] leading-relaxed">{p.error}</div>}
                {(p.url || p.error) && (
                  <div className="flex items-center justify-center gap-2 px-3 pb-2.5">
                    {p.url && p.bubbles && (
                      <button type="button" onClick={() => patchPanel(i, { bubbles: undefined })} className="flex items-center gap-1 px-3 py-1.5 rounded-full bg-black/[0.05] text-[11px] text-black/55 active:scale-[0.97]">
                        <RotateCcw size={11} />复位气泡
                      </button>
                    )}
                    <button type="button" disabled={busy} onClick={() => { if (!p.url || window.confirm("重新生成这一格会再次调用生图 API，继续？")) void draw([i]); }} className="px-3 py-1.5 rounded-full bg-black/[0.05] text-[11px] text-black/55 active:scale-[0.97]">
                      {p.url ? "重画这一格" : "重试这一格"}
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>

          {book.panels.some(p => p.url) && (
            <div className="mt-3">
              <button type="button" disabled={exporting || !book.panels.every(p => p.url)} onClick={downloadComic} className={`w-full ${buttonClass(!exporting && book.panels.every(p => p.url))}`}>
                {exporting ? "导出中…" : "导出长图"}
              </button>
            </div>
          )}

          {!book.panels.some(p => p.url) && (
            <div className="mt-3">
              <button type="button" disabled={busy} onClick={() => void draw([0, 1, 2, 3])} className={`w-full ${buttonClass(!busy)}`}>确认脚本 · 生成四格漫画</button>
            </div>
          )}
        </>
      )}

      {preview && typeof document !== "undefined" && createPortal(
        // 用 portal 挂到 body，避免被弹窗的 transform/overflow 裁掉或半透明叠色。
        // 按钮放在图片下方，和分镜配图一致。
        <div className="fixed inset-0 z-[200] flex flex-col" style={{ backgroundColor: "#000" }} onClick={() => setPreview(null)}>
          <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center px-3" style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 14px)" }}>
            <img src={preview} alt="漫画大图" className="max-w-full max-h-full w-auto h-auto rounded-[10px]" onClick={e => e.stopPropagation()} />
          </div>
          <div className="shrink-0 flex items-center justify-center gap-3 px-4 pt-3" style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 18px)" }}>
            <a href={preview} download="comic.png" onClick={e => e.stopPropagation()} className="px-6 py-2.5 rounded-full bg-white/[0.14] text-[13px] text-white">保存图片</a>
            <button type="button" onClick={() => setPreview(null)} className="px-6 py-2.5 rounded-full bg-white/[0.14] text-[13px] text-white">关闭</button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

export default EnsembleComicSheet;
