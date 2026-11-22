import type { ComicBook } from './ensemble-comic';

export async function exportComic(book: ComicBook): Promise<Blob> {
  await document.fonts.load('28px ComicDeYi');
  const width = 1080, pad = 48;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器无法导出图片');
  const images = await Promise.all(book.panels.map(panel => new Promise<HTMLImageElement>((resolve, reject) => {
    if (!panel.url) { reject(new Error('请先完成全部四格')); return; }
    const image = new Image(); image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image); image.onerror = () => reject(new Error('图片读取失败，请重试'));
    image.src = panel.url;
  })));
  ctx.font = '32px ComicDeYi, sans-serif';
  function wrap(text: string) {
    const lines: string[] = []; let line = '';
    for (const char of text) {
      if (char === '\n') { lines.push(line); line = ''; continue; }
      if (ctx!.measureText(line + char).width > width - pad * 4) { lines.push(line); line = char; } else line += char;
    }
    if (line) lines.push(line);
    return lines;
  }
  const blocks = book.panels.map((panel, i) => ({
    image: images[i], height: Math.round(images[i].naturalHeight * width / images[i].naturalWidth),
    quotes: panel.quoteIds.map(id => book.quotes.find(q => q.id === id)).filter(q => q !== undefined).map(q => ({ speaker: q.speaker, lines: wrap(q.text) })),
  }));
  canvas.width = width;
  canvas.height = blocks.reduce((sum, b) => sum + b.height + b.quotes.reduce((s, q) => s + 88 + q.lines.length * 48, 0) + 48, 0);
  if (canvas.height > 32000) throw new Error('长图过长，请减少对白后导出');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, canvas.height);
  let y = 0;
  for (const block of blocks) {
    ctx.drawImage(block.image, 0, y, width, block.height); y += block.height + 24;
    for (const quote of block.quotes) {
      const h = 64 + quote.lines.length * 48;
      ctx.strokeStyle = '#d0d0d0'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.roundRect(pad, y, width - pad * 2, h, 32); ctx.stroke();
      ctx.textAlign = 'center'; ctx.fillStyle = '#777'; ctx.font = '22px sans-serif'; ctx.fillText(quote.speaker, width / 2, y + 30);
      ctx.fillStyle = '#222'; ctx.font = '32px ComicDeYi, sans-serif';
      quote.lines.forEach((line, i) => ctx.fillText(line, width / 2, y + 76 + i * 48));
      y += h + 24;
    }
    y += 24;
  }
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('长图导出失败')), 'image/png'));
}
