// Canvas renderers for phone-friendly image exports: shot cards, storyboard sheets and
// moodboards, plus helpers to thumbnail frames and turn them into JPEG bytes for PDFs.

import { cameraLine } from './sections.js';
import { shotLabel } from './project.js';

const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Arial, sans-serif';
const BG = '#110f1a';
const PANEL = '#1e1b2c';
const ACCENT = '#ff5a36';
const TEXT = '#f4f1fa';
const MUTED = '#a6a1b8';

export async function loadImage(blob) {
  if (globalThis.createImageBitmap) {
    try { return await createImageBitmap(blob); } catch { /* fall through (e.g. HEIC on old iOS) */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export function canvasToBlob(canvas, type = 'image/png', quality = 0.9) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not render image'))), type, quality);
  });
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

const dims = (img) => ({
  w: img.videoWidth || img.naturalWidth || img.width,
  h: img.videoHeight || img.naturalHeight || img.height,
});

export function drawCover(ctx, img, x, y, w, h) {
  const { w: iw, h: ih } = dims(img);
  const scale = Math.max(w / iw, h / ih);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
}

// Downscale any image to a JPEG no larger than maxSide (keeps memory sane on iPhone).
export async function toJpeg(blobOrImg, maxSide = 1400, quality = 0.85) {
  const img = blobOrImg instanceof Blob ? await loadImage(blobOrImg) : blobOrImg;
  const { w, h } = dims(img);
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const c = makeCanvas(Math.round(w * scale), Math.round(h * scale));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return { blob: await canvasToBlob(c, 'image/jpeg', quality), width: c.width, height: c.height };
}

export async function jpegBytes(blob, maxSide = 1200) {
  const { blob: jpg } = await toJpeg(blob, maxSide, 0.82);
  return new Uint8Array(await jpg.arrayBuffer());
}

function wrap(ctx, text, maxWidth) {
  const lines = [];
  for (const para of String(text || '').split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const t = line ? `${line} ${word}` : word;
      if (ctx.measureText(t).width > maxWidth && line) { lines.push(line); line = word; } else line = t;
    }
    lines.push(line);
  }
  return lines;
}

function drawLines(ctx, text, x, y, maxWidth, lineHeight, maxLines = Infinity) {
  const lines = wrap(ctx, text, maxWidth);
  const shown = lines.slice(0, maxLines);
  if (lines.length > maxLines) shown[shown.length - 1] = `${shown.at(-1).replace(/\s+\S*$/, '')}…`;
  shown.forEach((l, i) => ctx.fillText(l, x, y + i * lineHeight));
  return y + shown.length * lineHeight;
}

function placeholder(ctx, shot, x, y, w, h, scale = 1) {
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, '#2a2540');
  g.addColorStop(1, '#171425');
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = MUTED;
  ctx.font = `${Math.round(22 * scale)}px ${FONT}`;
  drawLines(ctx, shot.description || shot.title, x + 24 * scale, y + 48 * scale, w - 48 * scale, 30 * scale, Math.floor((h - 60 * scale) / (30 * scale)));
}

// 1080×1920 card for one shot: frame on top, instructions below. Ideal to keep in Photos.
export function renderShotCard(project, shot, img) {
  const W = 1080;
  const H = 1920;
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d');
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
  const fh = 1180;
  if (img) drawCover(ctx, img, 0, 0, W, fh); else placeholder(ctx, shot, 0, 0, W, fh, 2);
  const g = ctx.createLinearGradient(0, fh - 260, 0, fh);
  g.addColorStop(0, 'rgba(17,15,26,0)');
  g.addColorStop(1, BG);
  ctx.fillStyle = g;
  ctx.fillRect(0, fh - 260, W, 260);

  let y = fh - 40;
  ctx.fillStyle = ACCENT;
  ctx.font = `700 44px ${FONT}`;
  ctx.fillText(`${shotLabel(project, shot)}${shot.status === 'done' ? '  ✓ DONE' : ''}`, 64, y);
  y += 76;
  ctx.fillStyle = TEXT;
  ctx.font = `700 64px ${FONT}`;
  y = drawLines(ctx, shot.title, 64, y, W - 128, 74, 2) + 10;
  ctx.font = `36px ${FONT}`;
  ctx.fillStyle = MUTED;
  y = drawLines(ctx, shot.description, 64, y, W - 128, 48, 4) + 20;
  const rows = [['CAMERA', cameraLine(shot)], ['LYRIC', shot.lyric && `“${shot.lyric}”`], ['WHERE', shot.location], ['PROPS', shot.props.join(', ')], ['TIME', shot.durationSec && `${shot.durationSec}s`]].filter(([, v]) => v);
  for (const [k, v] of rows) {
    if (y > H - 120) break;
    ctx.fillStyle = ACCENT;
    ctx.font = `700 26px ${FONT}`;
    ctx.fillText(k, 64, y);
    ctx.fillStyle = TEXT;
    ctx.font = `34px ${FONT}`;
    y = drawLines(ctx, v, 230, y, W - 294, 44, 2) + 14;
  }
  ctx.fillStyle = MUTED;
  ctx.font = `26px ${FONT}`;
  ctx.fillText(`ReaShoota · ${project.name}`, 64, H - 56);
  return c;
}

// One tall image with every panel, 2 per row — easy to scroll through in Photos on set.
export function renderStoryboardSheet(project, images) {
  const W = 1080;
  const cols = 2;
  const pad = 40;
  const gap = 28;
  const cw = (W - pad * 2 - gap) / cols;
  const ph = cw * 16 / 9;
  const cap = 150;
  const rows = Math.max(1, Math.ceil(project.shots.length / cols));
  const H = 170 + rows * (ph + cap + gap) + 40;
  const c = makeCanvas(W, Math.round(H));
  const ctx = c.getContext('2d');
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = ACCENT;
  ctx.font = `700 28px ${FONT}`;
  ctx.fillText('STORYBOARD', pad, 70);
  ctx.fillStyle = TEXT;
  ctx.font = `700 48px ${FONT}`;
  ctx.fillText(project.name, pad, 128);
  project.shots.forEach((s, i) => {
    const x = pad + (i % cols) * (cw + gap);
    const y = 170 + Math.floor(i / cols) * (ph + cap + gap);
    const img = images.get(s.id);
    if (img) drawCover(ctx, img, x, y, cw, ph); else placeholder(ctx, s, x, y, cw, ph, 1.1);
    if (s.status === 'done') {
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 6;
      ctx.strokeRect(x + 3, y + 3, cw - 6, ph - 6);
    }
    ctx.fillStyle = ACCENT;
    ctx.font = `700 26px ${FONT}`;
    ctx.fillText(`${shotLabel(project, s)}${s.status === 'done' ? ' ✓' : ''}`, x, y + ph + 40);
    ctx.fillStyle = TEXT;
    ctx.font = `700 30px ${FONT}`;
    drawLines(ctx, s.title, x, y + ph + 80, cw, 34, 1);
    ctx.fillStyle = MUTED;
    ctx.font = `24px ${FONT}`;
    drawLines(ctx, cameraLine(s), x, y + ph + 116, cw, 28, 1);
  });
  return c;
}

// 1080×1920 moodboard: concept images collage, palette strip and the logline.
export function renderMoodboard(project, images) {
  const W = 1080;
  const H = 1920;
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d');
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
  const pad = 36;
  const grid = images.slice(0, 6);
  const gh = 1240;
  const layout = grid.length <= 1 ? [[0, 0, 1, 1]]
    : grid.length === 2 ? [[0, 0, 1, 0.5], [0, 0.5, 1, 0.5]]
      : grid.length === 3 ? [[0, 0, 1, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]]
        : grid.length === 4 ? [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]]
          : [[0, 0, 0.5, 1 / 3], [0.5, 0, 0.5, 1 / 3], [0, 1 / 3, 0.5, 1 / 3], [0.5, 1 / 3, 0.5, 1 / 3], [0, 2 / 3, 0.5, 1 / 3], [0.5, 2 / 3, 0.5, 1 / 3]];
  const iw = W - pad * 2;
  if (!grid.length) {
    ctx.fillStyle = PANEL;
    ctx.fillRect(pad, pad, iw, gh);
    ctx.fillStyle = MUTED;
    ctx.font = `36px ${FONT}`;
    ctx.fillText('Add concept images or frames to fill the moodboard', pad + 40, pad + 90);
  }
  grid.forEach((img, i) => {
    const [fx, fy, fw, fh] = layout[i];
    const g = 8;
    drawCover(ctx, img, pad + fx * iw + g / 2, pad + fy * gh + g / 2, fw * iw - g, fh * gh - g);
  });
  let y = pad + gh + 40;
  const pal = project.direction.palette;
  pal.forEach((col, i) => {
    const sw = iw / pal.length;
    ctx.fillStyle = col;
    ctx.fillRect(pad + i * sw, y, sw, 90);
  });
  if (pal.length) y += 150;
  ctx.fillStyle = TEXT;
  ctx.font = `700 60px ${FONT}`;
  y = drawLines(ctx, project.name, pad, y, iw, 70, 2) + 10;
  ctx.fillStyle = MUTED;
  ctx.font = `34px ${FONT}`;
  drawLines(ctx, project.direction.logline || project.direction.mood, pad, y, iw, 46, Math.floor((H - y - 90) / 46));
  ctx.fillStyle = ACCENT;
  ctx.font = `700 24px ${FONT}`;
  ctx.fillText('REASHOOTA · MOODBOARD', pad, H - 50);
  return c;
}
