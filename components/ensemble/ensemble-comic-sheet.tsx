"use client";
import { useRef, useState } from "react";
import type { EnsembleScript } from "@/lib/ensemble-storage";
import { comicImagePresets, comicSource, drawComicPanel, loadComicBooks, loadComicImageOptions, planComic, saveComicBook, saveComicImageOptions, type ComicBook } from "@/lib/ensemble-comic";
import { exportComic } from "@/lib/ensemble-comic-export";

export function EnsembleComicSheet({ script, open, onClose }: { script: EnsembleScript; open: boolean; onClose: () => void }) {
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
  const [exportUrl, setExportUrl] = useState<string | null>(null);
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
      const blob = await exportComic(book);
      const url = URL.createObjectURL(blob);
      if (exportUrl) URL.revokeObjectURL(exportUrl);
      setExportUrl(url);
      const link = document.createElement("a"); link.href = url; link.download = `${book.title}.png`; link.click();
    } catch (e) { setError(e instanceof Error ? e.message : "导出失败"); }
    finally { setExporting(false); }
  }
  if (!open) return null;
  return (
    <div className="comic-mask" onClick={onClose}>
      <style>{COMIC_CSS}</style>
      <section className="comic-sheet" onClick={e => e.stopPropagation()}>
        <header className="comic-head">
          <h2>漫画分镜</h2>
          <button type="button" onClick={onClose}>收起</button>
        </header>

        <details className="comic-config">
          <summary>漫画生图配置</summary>
          <div className="comic-config-body">
            <label className="comic-row"><span>主用</span>
              <select value={imageOptions.primary} disabled={busy} onChange={e => updateOptions({ primary: e.target.value })}>
                <option value="">沿用全局生图</option>
                {presets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <label className="comic-row"><span>备用</span>
              <select value={imageOptions.fallback} disabled={busy} onChange={e => updateOptions({ fallback: e.target.value })}>
                <option value="">不使用备用</option>
                {presets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <label className="comic-row"><span>锁脸参考图</span>
              <input type="checkbox" className="comic-switch" checked={imageOptions.useReference} disabled={busy} onChange={e => updateOptions({ useReference: e.target.checked })} />
            </label>
            <p className="comic-hint">参考照片会把画风拉向真人，建议关闭后对比一次。失败会重试一次再试备用；请求可能计费。</p>
          </div>
        </details>

        {busy && <p className="comic-hint">正在制作，可收起后继续聊天。请保持页面开启。</p>}
        {notice && <p className="comic-notice">{notice}</p>}
        {error && <p className="comic-error" role="alert">{error}</p>}

        {!book ? <>
          <label className="comic-row"><span>最近</span>
            <input className="comic-input" type="number" min="1" max={script.turns.length} value={count} onChange={e => { setCount(e.target.value); setSelected([]); }} />
            <span>轮 / 幕</span>
          </label>
          <textarea className="comic-textarea" placeholder="想画哪段剧情？留空由模型选择" value={request} onChange={e => setRequest(e.target.value)} />
          <p className="comic-hint">选择想留下的对白，也可以不选</p>
          <div className="comic-quotes">
            {source.quotes.length === 0 && <p className="comic-hint">这段剧情里没有可用的对白，可直接生成纯画面四格。</p>}
            {source.quotes.map(q => (
              <label key={q.id} className={selected.includes(q.id) ? "comic-quote is-on" : "comic-quote"}>
                <input type="checkbox" checked={selected.includes(q.id)} onChange={e => setSelected(s => e.target.checked ? [...s, q.id] : s.filter(id => id !== q.id))} />
                <span><span className="comic-quote-name">{q.speaker}</span>{q.text}</span>
              </label>
            ))}
          </div>
          <button type="button" className="comic-primary" disabled={!valid || busy} onClick={plan}>生成四格脚本</button>
          {books.length > 0 && <div className="comic-history">
            <p className="comic-hint">我的漫画</p>
            {books.map(b => <button type="button" key={b.id} onClick={() => setBook(b)}>{b.title}<span>{b.panels.filter(p => p.url).length}/4</span></button>)}
          </div>}
        </> : <>
          <div className="comic-book-head"><h3>{book.title}</h3><button type="button" onClick={() => setBook(null)}>返回</button></div>
          {book.panels.map((p, i) => (
            <article key={i} className="comic-panel">
              {p.url
                ? <button type="button" className="comic-panel-img" onClick={() => setPreview(p.url!)}><img src={p.url} alt={`第${i + 1}格`} /></button>
                : <textarea className="comic-panel-desc" aria-label={`第${i + 1}格画面`} value={p.description} disabled={busy} onChange={e => setBook({ ...book, panels: book.panels.map((v, j) => j === i ? { ...v, description: e.target.value } : v) })} />}
              <div className="comic-bubbles">
                {p.quoteIds.map(id => {
                  const q = book.quotes.find(q => q.id === id);
                  return q ? <div key={id} className="comic-bubble"><span>{q.speaker}</span><p>{q.text}</p></div> : null;
                })}
              </div>
              {p.error && <p className="comic-error">{p.error}</p>}
              {(p.url || p.error) && <button type="button" className="comic-link" disabled={busy} onClick={() => { if (!p.url || window.confirm("重新生成这一格会再次调用生图 API，继续？")) void draw([i]); }}>{p.url ? "重画这一格" : "重试这一格"}</button>}
            </article>
          ))}
          {book.panels.every(p => p.url) && <div className="comic-export">
            <button type="button" className="comic-primary" disabled={exporting} onClick={downloadComic}>{exporting ? "正在导出…" : "导出带对白长图"}</button>
            {exportUrl && <a href={exportUrl} download={`${book.title}.png`}>再次保存长图</a>}
          </div>}
          {!book.panels.some(p => p.url) && <button type="button" className="comic-primary" disabled={busy} onClick={() => void draw([0, 1, 2, 3])}>确认脚本 · 生成四格漫画</button>}
        </>}
      </section>
      {preview && <div className="comic-preview" onClick={() => setPreview(null)}>
        <button type="button" onClick={() => setPreview(null)}>关闭</button>
        <img src={preview} alt="漫画大图" onClick={e => e.stopPropagation()} />
        <a href={preview} download="comic.png" onClick={e => e.stopPropagation()}>保存图片</a>
      </div>}
    </div>
  );
}

const COMIC_CSS = `
@font-face{font-family:ComicDeYi;src:url('/fonts/comic-deyi.otf') format('opentype');font-display:swap}
.comic-mask{position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;padding:12px;background:rgba(0,0,0,.35)}
.comic-sheet{width:100%;max-width:440px;max-height:88dvh;overflow-y:auto;padding:18px 16px 22px;border-radius:24px;background:var(--c-card,#f7f7f8);box-shadow:0 18px 48px rgba(0,0,0,.16);animation:modalSoftRise .24s ease;color:var(--c-text,#222);display:flex;flex-direction:column;gap:10px}
.comic-head{display:flex;align-items:center;justify-content:space-between;padding:0 2px 2px}
.comic-head h2{margin:0;font-size:17px;font-weight:600}
.comic-head button{border:none;background:none;color:var(--c-secondary-text,#8a8a8a);font-size:13px;padding:6px 2px}
.comic-config{border-radius:14px;background:color-mix(in srgb,var(--c-text,#222) 4%,transparent);padding:10px 12px}
.comic-config summary{font-size:13px;color:var(--c-secondary-text,#8a8a8a);list-style:none;cursor:pointer}
.comic-config summary::-webkit-details-marker{display:none}
.comic-config-body{display:flex;flex-direction:column;gap:8px;padding-top:8px}
.comic-row{display:flex;align-items:center;gap:8px;font-size:14px;min-height:40px}
.comic-row>span:first-child{flex:0 0 auto;min-width:64px}
.comic-row select,.comic-row .comic-input{flex:1 1 auto;min-width:0;height:40px;padding:0 10px;border-radius:10px;border:1px solid transparent;background:var(--c-card,#fff);color:var(--c-text,#222);font-size:14px;appearance:none}
.comic-input{flex:0 0 88px!important;text-align:center}
.comic-switch{width:44px;height:26px;appearance:none;border-radius:13px;background:color-mix(in srgb,var(--c-text,#222) 14%,transparent);position:relative;transition:background .2s;margin-left:auto}
.comic-switch:checked{background:#5B8FB9}
.comic-switch:after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;transition:transform .2s;box-shadow:0 1px 3px rgba(0,0,0,.2)}
.comic-switch:checked:after{transform:translateX(18px)}
.comic-textarea{width:100%;min-height:84px;padding:12px;border-radius:12px;border:none;background:var(--c-card,#fff);font-size:14px;line-height:1.6;color:var(--c-text,#222);resize:vertical;box-sizing:border-box}
.comic-hint{margin:0;padding:0 2px;font-size:12px;line-height:1.5;color:var(--c-secondary-text,#8a8a8a)}
.comic-notice{margin:0;padding:8px 10px;border-radius:10px;background:#5B8FB918;color:#3d6c92;font-size:12px}
.comic-error{margin:0;padding:8px 10px;border-radius:10px;background:#ef444414;color:#c0392b;font-size:12px;line-height:1.5}
.comic-quotes{display:flex;flex-direction:column;gap:8px;max-height:38vh;overflow-y:auto;padding-right:2px}
.comic-quote{display:flex;gap:10px;padding:10px 12px;border-radius:12px;background:var(--c-card,#fff);font-size:14px;line-height:1.55;word-break:break-word}
.comic-quote.is-on{box-shadow:inset 0 0 0 1.5px #5B8FB9}
.comic-quote input{margin-top:4px;width:18px;height:18px;accent-color:#5B8FB9;flex:0 0 auto}
.comic-quote-name{display:block;font-size:12px;color:var(--c-secondary-text,#8a8a8a);margin-bottom:2px}
.comic-primary{width:100%;height:46px;border:none;border-radius:14px;background:#5B8FB9;color:#fff;font-size:15px;font-weight:500}
.comic-primary:disabled{opacity:.45}
.comic-history{display:flex;flex-direction:column;gap:8px}
.comic-history button{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px;border:none;border-radius:12px;background:var(--c-card,#fff);font-size:14px;color:var(--c-text,#222);text-align:left}
.comic-history button span{font-size:12px;color:var(--c-secondary-text,#8a8a8a)}
.comic-book-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:2px}
.comic-book-head h3{margin:0;font-size:15px;font-weight:600}
.comic-book-head button{border:none;background:none;color:var(--c-secondary-text,#8a8a8a);font-size:13px;padding:6px 2px}
.comic-panel{display:flex;flex-direction:column;gap:0;border-radius:14px;overflow:hidden;background:var(--c-card,#fff)}
.comic-panel-img{display:block;padding:0;border:none;background:none;width:100%}
.comic-panel-img img{display:block;width:100%;height:auto}
.comic-panel-desc{width:100%;min-height:104px;padding:12px;border:none;background:transparent;font-size:13px;line-height:1.7;color:var(--c-text,#222);resize:vertical;box-sizing:border-box}
.comic-bubbles{display:flex;flex-direction:column;gap:8px;padding:0 16px 4px}
.comic-bubble{margin:0 auto;width:100%;padding:10px 18px 12px;border-radius:45%/34%;border:1px solid color-mix(in srgb,var(--c-text,#222) 14%,transparent);text-align:center}
.comic-bubble span{display:block;font-size:10px;color:var(--c-secondary-text,#8a8a8a);margin-bottom:2px;font-family:system-ui,sans-serif}
.comic-bubble p{margin:0;font-family:ComicDeYi,sans-serif;font-size:17px;line-height:1.7;word-break:break-word}
.comic-link{align-self:flex-start;margin:0 16px 12px;padding:6px 0;border:none;background:none;font-size:12px;color:var(--c-secondary-text,#8a8a8a)}
.comic-export{display:flex;flex-direction:column;gap:8px}
.comic-export a{text-align:center;font-size:13px;color:#5B8FB9}
.comic-preview{position:fixed;inset:0;z-index:110;display:flex;flex-direction:column;align-items:center;gap:12px;padding:16px;background:rgba(0,0,0,.94);overflow:auto}
.comic-preview button{align-self:flex-end;border:none;background:none;color:#fff;font-size:14px;padding:8px}
.comic-preview img{max-width:100%;height:auto}
.comic-preview a{color:#fff;font-size:14px;padding:8px 0 24px}
`;
