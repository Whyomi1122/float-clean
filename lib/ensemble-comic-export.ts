import { bubbleSlot, type ComicBook } from './ensemble-comic';

/** 导出竖版长图：四格满版上下相接，对白气泡像例图那样叠在画面里。 */
export async function exportComic(book: ComicBook): Promise<Blob> {
  await document.fonts.load('30px ComicDeYi');
  const width = 1080;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器无法导出图片');
  const images = await Promise.all(book.panels.map(panel => new Promise<HTMLImageElement>((resolve, reject) => {
    if (!panel.url) { reject(new Error('请先完成全部四格')); return; }
    const image = new Image(); image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image); image.onerror = () => reject(new Error('图片读取失败，请重试'));
    image.src = panel.url;
  })));
  const font = '30px ComicDeYi, sans-serif';
  ctx.font = font;
  const bubbleMax = Math.round(width * 0.58) - 64;
  function wrap(text: string, max: number) {
    const lines: string[] = []; let line = '';
    for (const char of text) {
      if (char === '\n') { lines.push(line); line = ''; continue; }
      if (ctx!.measureText(line + char).width > max) { lines.push(line); line = char; } else line += char;
    }
    if (line) lines.push(line);
    return lines;
  }
  const blocks = book.panels.map((panel, i) => ({
    image: images[i],
    height: Math.round(images[i].naturalHeight * width / images[i].naturalWidth),
    quotes: panel.quoteIds
      .map(id => book.quotes.find(q => q.id === id))
      .filter(q => q !== undefined)
      .map(q => ({ lines: wrap(q.text, bubbleMax) })),
  }));
  canvas.width = width;
  canvas.height = blocks.reduce((sum, b) => sum + b.height, 0);
  if (canvas.height > 32000) throw new Error('长图过长，请减少对白后导出');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, canvas.height);
  let y = 0;
  for (const block of blocks) {
    ctx.drawImage(block.image, 0, y, width, block.height);
    block.quotes.forEach((quote, qi) => {
      const slot = bubbleSlot(qi, block.quotes.length);
      const lineH = 48;
      const textW = Math.max(...quote.lines.map(line => ctx.measureText(line).width), 120);
      const bw = Math.min(width * 0.62, textW + 76);
      const bh = quote.lines.length * lineH + 58;
      const cx = slot.side === 'right' ? width - width * 0.06 - bw / 2 : width * 0.06 + bw / 2;
      const minCy = y + bh / 2 + 14;
      const maxCy = y + block.height - bh / 2 - 14;
      const rawCy = y + block.height * slot.top / 100 + bh / 2;
      const cy = maxCy <= minCy ? y + block.height / 2 : Math.min(maxCy, Math.max(minCy, rawCy));
      ctx.beginPath();
      ctx.ellipse(cx, cy, bw / 2, bh / 2, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.97)'; ctx.fill();
      ctx.strokeStyle = '#1c1c1c'; ctx.lineWidth = 4; ctx.stroke();
      ctx.fillStyle = '#1c1c1c'; ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const startY = cy - (quote.lines.length - 1) * lineH / 2;
      quote.lines.forEach((line, li) => ctx.fillText(line, cx, startY + li * lineH));
    });
    y += block.height;
  }
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('长图导出失败')), 'image/png'));
}
