import { bubbleTailPoints, layoutComicBubbles, type ComicBook } from './ensemble-comic';

/** 导出竖版长图：四格满版上下相接（或纸漫白缝），对白气泡与预览用同一套排版。 */
export async function exportComic(book: ComicBook): Promise<Blob> {
  await document.fonts.load('30px ComicDeYi');
  await document.fonts.ready;
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
  const gap = book.paperMode ? 14 : 0;
  const blocks = book.panels.map((panel, i) => {
    const height = Math.round(images[i].naturalHeight * width / images[i].naturalWidth);
    return { image: images[i], height, bubbles: layoutComicBubbles(panel, book.quotes, width, height) };
  });
  canvas.width = width;
  canvas.height = blocks.reduce((sum, b) => sum + b.height, 0) + gap * (blocks.length - 1);
  if (canvas.height > 32000) throw new Error('长图过长，请减少对白后导出');
  // 设完尺寸后 context 状态会被重置，字体必须重新声明，否则量字与画字不同步（气泡文字会溢出）。
  const font = (size: number) => `${size}px ComicDeYi, sans-serif`;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, canvas.height);
  let y = 0;
  for (const block of blocks) {
    ctx.drawImage(block.image, 0, y, width, block.height);
    if (book.paperMode) {
      ctx.strokeStyle = '#1c1c1c'; ctx.lineWidth = 4;
      ctx.strokeRect(2, y + 2, width - 4, block.height - 4);
    }
    for (const box of block.bubbles) {
      ctx.font = font(box.fontSize);
      ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
      const cx = box.cx; const cy = y + box.cy;
      const tail = bubbleTailPoints(box.w, box.h, box.tail);
      // 先填气泡本体与尾巴，再统一描边，避免接缝处出现内框线
      ctx.beginPath(); ctx.ellipse(cx, cy, box.w / 2, box.h / 2, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill();
      if (tail) {
        ctx.beginPath();
        ctx.moveTo(cx + tail[0][0], cy + tail[0][1]);
        ctx.lineTo(cx + tail[1][0], cy + tail[1][1]);
        ctx.lineTo(cx + tail[2][0], cy + tail[2][1]);
        ctx.closePath(); ctx.fill();
      }
      ctx.strokeStyle = '#1c1c1c'; ctx.lineWidth = Math.max(2, box.fontSize * 0.09);
      ctx.beginPath(); ctx.ellipse(cx, cy, box.w / 2, box.h / 2, 0, 0, Math.PI * 2); ctx.stroke();
      if (tail) {
        ctx.beginPath();
        ctx.moveTo(cx + tail[0][0], cy + tail[0][1]);
        ctx.lineTo(cx + tail[1][0], cy + tail[1][1]);
        ctx.lineTo(cx + tail[2][0], cy + tail[2][1]);
        ctx.stroke();
      }
      ctx.fillStyle = '#1c1c1c';
      const startY = cy - ((box.lines.length - 1) * box.lineHeight) / 2;
      box.lines.forEach((line, li) => ctx.fillText(line, cx, startY + li * box.lineHeight));
    }
    y += block.height + gap;
  }
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('长图导出失败')), 'image/png'));
}
