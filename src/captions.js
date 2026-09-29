// Burned-in captions: the four styles from the design (Pop, Karaoke, Clean, Boxed) drawn on
// a canvas in any of the bundled fonts, so they end up inside the exported video.

export const CAPTION_FONTS = [
  { id: 'Anton', label: 'Anton', css: 'Anton', scale: 1 },
  { id: 'Bebas Neue', label: 'Bebas', css: '"Bebas Neue"', scale: 1.15 },
  { id: 'Archivo Black', label: 'Archivo', css: '"Archivo Black"', scale: 0.8 },
  { id: 'Permanent Marker', label: 'Marker', css: '"Permanent Marker"', scale: 0.85 },
  { id: 'Instrument Serif', label: 'Serif', css: '"Instrument Serif"', scale: 1.05 },
  { id: 'JetBrains Mono', label: 'Mono', css: '"JetBrains Mono"', scale: 0.7 },
];

export const CAPTION_STYLES = [
  { id: 'pop', label: 'Pop' },
  { id: 'karaoke', label: 'Karaoke' },
  { id: 'clean', label: 'Clean' },
  { id: 'boxed', label: 'Boxed' },
];

const HIGHLIGHT = '#6c4dff';
const SUNG = '#b6a8ff';

export function fontFor(id) {
  return CAPTION_FONTS.find((f) => f.id === id) || CAPTION_FONTS[0];
}

// Canvas text only uses a web font once it's loaded.
export async function loadCaptionFont(id) {
  const f = fontFor(id);
  try { await document.fonts.load(`40px ${f.css}`); } catch { /* falls back to system font */ }
}

// cap = { words, active } from timeline.captionAt; settings = project.captions.
export function drawCaption(ctx, cap, settings, W, H) {
  if (!cap || !cap.words.length) return;
  const style = settings.style || 'pop';
  const font = fontFor(settings.font);
  const clean = style === 'clean';
  const size = Math.round(W * (clean ? 0.058 : 0.092) * font.scale);
  const weight = clean ? '600 ' : '';
  ctx.save();
  ctx.font = `${weight}${size}px ${clean ? '"Instrument Sans", sans-serif' : `${font.css}, sans-serif`}`;
  ctx.textBaseline = 'middle';
  const words = cap.words.map((w) => (clean ? w : w.toUpperCase()));
  const space = ctx.measureText(' ').width;
  const maxW = W * 0.84;
  const padX = size * 0.22;

  // Lay words into centred lines.
  const lines = [];
  let line = [];
  let lw = 0;
  words.forEach((w, i) => {
    const ww = ctx.measureText(w).width + (style === 'pop' || style === 'boxed' ? padX * 2 : 0);
    if (line.length && lw + space + ww > maxW) { lines.push({ items: line, w: lw }); line = []; lw = 0; }
    lw += (line.length ? space : 0) + ww;
    line.push({ w, ww, i });
  });
  if (line.length) lines.push({ items: line, w: lw });

  const lh = size * 1.25;
  // Centre of the TikTok / Reels / Shorts safe zone: clear of the caption and button overlays.
  let y = H * 0.62 - ((lines.length - 1) * lh) / 2;
  for (const l of lines) {
    let x = (W - l.w) / 2;
    if (style === 'boxed') {
      ctx.fillStyle = 'rgba(0,0,0,0.82)';
      roundRect(ctx, x - padX * 0.3, y - lh / 2, l.w + padX * 0.6, lh, size * 0.18);
      ctx.fill();
    }
    for (const it of l.items) {
      const isActive = it.i === cap.active;
      const sung = it.i <= cap.active;
      const pad = style === 'pop' || style === 'boxed' ? padX : 0;
      if (style === 'pop' && isActive) {
        ctx.fillStyle = HIGHLIGHT;
        roundRect(ctx, x, y - lh / 2 + size * 0.04, it.ww, lh * 0.92, size * 0.16);
        ctx.fill();
      }
      ctx.lineJoin = 'round';
      if (style !== 'boxed') {
        ctx.lineWidth = Math.max(2, size * 0.12);
        ctx.strokeStyle = 'rgba(10,6,30,0.85)';
        ctx.strokeText(it.w, x + pad, y);
      }
      ctx.fillStyle = style === 'karaoke' ? (sung ? SUNG : 'rgba(255,255,255,0.62)') : '#ffffff';
      ctx.fillText(it.w, x + pad, y);
      x += it.ww + space;
    }
    y += lh;
  }
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
