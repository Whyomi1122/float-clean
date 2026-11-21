"use client";
import { useRef, useState } from "react";
import type { EnsembleScript } from "@/lib/ensemble-storage";
import { comicSource, drawComicPanel, loadComicBooks, planComic, saveComicBook, type ComicBook } from "@/lib/ensemble-comic";

export function EnsembleComicSheet({ script, open, onClose }: { script: EnsembleScript; open: boolean; onClose: () => void }) {
  const [count, setCount] = useState("6");
  const [request, setRequest] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [book, setBook] = useState<ComicBook | null>(null);
  const [books, setBooks] = useState(() => loadComicBooks(script.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const running = useRef(false);
  const n = Number(count);
  const valid = Number.isInteger(n) && n > 0 && n <= script.turns.length;
  const source = comicSource(script, valid ? n : 1);
  const persist = (next: ComicBook) => { saveComicBook(script.id, next); setBook({ ...next, panels: [...next.panels] }); setBooks(loadComicBooks(script.id)); };
  async function plan() {
    if (!valid || running.current) return;
    running.current = true; setBusy(true); setError("");
    try { setBook(await planComic(script, n, request, source.quotes.filter(q => selected.includes(q.id)))); }
    catch (e) { setError(e instanceof Error ? e.message : "脚本生成失败"); }
    finally { running.current = false; setBusy(false); }
  }
  async function draw(indices: number[]) {
    if (!book || running.current) return;
    running.current = true; setBusy(true); setError("");
    const next = { ...book, panels: book.panels.map(p => ({ ...p })) };
    try {
      for (const index of indices) {
        try { next.panels[index].url = await drawComicPanel(script, next, index); next.panels[index].error = undefined; }
        catch (e) { next.panels[index].error = e instanceof Error ? e.message : "生图失败"; }
        persist(next);
      }
    } finally { running.current = false; setBusy(false); }
  }
  if (!open) return null;
  const button = "rounded-full px-4 py-2 text-sm bg-[#5B8FB9] text-white disabled:opacity-40";
  return <div className="fixed inset-0 z-[100] bg-black/35 flex items-center justify-center p-3" onClick={onClose}>
    <section className="w-full max-w-lg max-h-[90dvh] overflow-y-auto rounded-[26px] bg-[#f7f7f8] p-5 space-y-4" style={{ animation: "modalSoftRise .25s ease-out" }} onClick={e => e.stopPropagation()}>
      <header className="flex items-center justify-between"><h2 className="text-lg font-medium">漫画分镜</h2><button onClick={onClose}>收起</button></header>
      {busy && <p className="text-xs text-black/50">正在制作，可收起后继续聊天。请保持页面开启。</p>}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {!book ? <>
        <label className="flex items-center gap-3 text-sm">最近 <input type="number" min="1" max={script.turns.length} value={count} onChange={e => { setCount(e.target.value); setSelected([]); }} className="w-20 bg-white rounded-lg p-2" /> 轮 / 幕</label>
        <textarea placeholder="想画哪段剧情？留空由模型选择" value={request} onChange={e => setRequest(e.target.value)} className="w-full min-h-20 bg-white rounded-xl p-3 text-sm" />
        <p className="text-xs text-black/50">选择想留下的对白，也可以不选</p>
        <div className="space-y-2 max-h-64 overflow-y-auto">{source.quotes.map(q => <label key={q.id} className="flex gap-3 rounded-xl bg-white p-3 text-sm"><input type="checkbox" checked={selected.includes(q.id)} onChange={e => setSelected(s => e.target.checked ? [...s, q.id] : s.filter(id => id !== q.id))} /><span><span className="block text-xs text-black/45 mb-1">{q.speaker}</span>{q.text}</span></label>)}</div>
        <button className={button} disabled={!valid || busy} onClick={plan}>生成四格脚本</button>
        {books.length > 0 && <div className="space-y-2"><p className="text-xs text-black/40">我的漫画</p>{books.map(b => <button key={b.id} onClick={() => setBook(b)} className="block w-full text-left rounded-xl bg-white p-3 text-sm">{b.title}</button>)}</div>}
      </> : <>
        <div className="flex items-center justify-between"><h3>{book.title}</h3><button disabled={busy} className="text-xs text-black/50" onClick={() => setBook(null)}>返回</button></div>
        {book.panels.map((p, i) => <article key={i} className="bg-white overflow-hidden rounded-lg">
          {p.url ? <button className="block w-full" onClick={() => setPreview(p.url!)}><img src={p.url} alt={`第${i + 1}格`} className="w-full h-auto" /></button> : <textarea aria-label={`第${i + 1}格画面`} value={p.description} disabled={busy} onChange={e => setBook({ ...book, panels: book.panels.map((v, j) => j === i ? { ...v, description: e.target.value } : v) })} className="w-full min-h-28 p-4 bg-white text-sm leading-relaxed" />}
          <div className="px-5 py-4 space-y-3">{p.quoteIds.map(id => { const q = book.quotes.find(q => q.id === id); return q && <div key={id} className="rounded-[45%] border border-black/15 px-5 py-3 text-center bg-white" style={{ fontFamily: "'ComicDeYi',sans-serif", fontSize: "18px", lineHeight: 1.7 }}><span className="block text-[10px] text-black/40" style={{ fontFamily: "sans-serif" }}>{q.speaker}</span>{q.text}</div>; })}</div>
          {p.error && <p className="px-4 text-xs text-red-600">{p.error}</p>}
          {(p.url || p.error) && <button disabled={busy} onClick={() => { if (!p.url || window.confirm("重新生成这一格会再次调用生图 API，继续？")) void draw([i]); }} className="px-4 pb-3 text-xs text-black/45">{p.url ? "重画这一格" : "重试这一格"}</button>}
        </article>)}
        {!book.panels.some(p => p.url) && <button className={button} disabled={busy} onClick={() => void draw([0, 1, 2, 3])}>确认脚本 · 生成四格漫画</button>}
      </>}
    </section>
    {preview && <div className="fixed inset-0 z-[110] bg-black/95 overflow-auto p-4 flex flex-col items-center" onClick={() => setPreview(null)}><button className="text-white self-end mb-4">关闭</button><img src={preview} alt="漫画大图" className="max-w-full h-auto" onClick={e => e.stopPropagation()} /><a href={preview} download="comic.png" className="text-white p-4" onClick={e => e.stopPropagation()}>保存图片</a></div>}
    <style>{`@font-face{font-family:ComicDeYi;src:url('/fonts/comic-deyi.otf') format('opentype');font-display:swap}`}</style>
  </div>;
}
