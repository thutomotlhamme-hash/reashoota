// Renders a vertical 9:16 storyboard animatic in the browser (canvas + MediaRecorder).
// Safari records H.264 MP4 natively, so the result goes straight to Photos or social apps.

import { drawCover } from './images.js';
import { cameraLine } from './sections.js';
import { shotLabel } from './project.js';

const FONT = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif';

export function pickVideoMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || null;
}

export function videoExtension(mime) {
  return mime && mime.startsWith('video/mp4') ? 'mp4' : 'webm';
}

export function canRenderVideo() {
  return !!pickVideoMime() && !!HTMLCanvasElement.prototype.captureStream;
}

// images: Map<shotId, ImageBitmap|HTMLImageElement>. Records in real time (≈ total duration).
export async function renderAnimatic(project, images, { width = 720, height = 1280, fps = 30, secondsPerShot, onProgress, signal } = {}) {
  const mime = pickVideoMime();
  if (!mime) throw new Error('This browser cannot record video. Try Safari on iPhone or Chrome.');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const shots = project.shots.length ? project.shots : [];
  const durations = shots.map((s) => secondsPerShot || Math.min(4, Math.max(1.5, Number(s.durationSec) || 3)));
  const titleSec = 1.5;
  const total = titleSec + durations.reduce((a, b) => a + b, 0);

  const drawTitle = (t) => {
    ctx.fillStyle = '#110f1a';
    ctx.fillRect(0, 0, width, height);
    ctx.globalAlpha = Math.min(1, t * 2);
    ctx.fillStyle = '#ff5a36';
    ctx.font = `700 ${width * 0.035}px ${FONT}`;
    ctx.fillText('STORYBOARD ANIMATIC', width * 0.08, height * 0.45);
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${width * 0.08}px ${FONT}`;
    ctx.fillText(project.name, width * 0.08, height * 0.45 + width * 0.11, width * 0.84);
    ctx.fillStyle = '#a6a1b8';
    ctx.font = `${width * 0.04}px ${FONT}`;
    ctx.fillText([project.artist, project.song].filter(Boolean).join(' — '), width * 0.08, height * 0.45 + width * 0.19, width * 0.84);
    ctx.globalAlpha = 1;
  };

  const drawShot = (s, t, d) => {
    const img = images.get(s.id);
    ctx.fillStyle = '#1b1829';
    ctx.fillRect(0, 0, width, height);
    if (img) {
      // Gentle Ken Burns push so stills feel like motion.
      const z = 1 + 0.06 * (t / d);
      const w = width * z;
      const h = height * z;
      drawCover(ctx, img, (width - w) / 2, (height - h) / 2, w, h);
    } else {
      ctx.fillStyle = '#a6a1b8';
      ctx.font = `${width * 0.045}px ${FONT}`;
      const words = (s.description || '').split(/\s+/);
      let line = '';
      let y = height * 0.3;
      for (const w of words) {
        if (ctx.measureText(`${line} ${w}`).width > width * 0.84 && line) { ctx.fillText(line, width * 0.08, y); y += width * 0.065; line = w; } else line = line ? `${line} ${w}` : w;
      }
      ctx.fillText(line, width * 0.08, y);
    }
    const g = ctx.createLinearGradient(0, height * 0.62, 0, height);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.85)');
    ctx.fillStyle = g;
    ctx.fillRect(0, height * 0.62, width, height * 0.38);
    ctx.fillStyle = '#ff5a36';
    ctx.font = `700 ${width * 0.04}px ${FONT}`;
    ctx.fillText(shotLabel(project, s), width * 0.07, height * 0.82);
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${width * 0.06}px ${FONT}`;
    ctx.fillText(s.title, width * 0.07, height * 0.82 + width * 0.08, width * 0.86);
    ctx.fillStyle = '#d6d2e2';
    ctx.font = `${width * 0.035}px ${FONT}`;
    ctx.fillText(s.lyric ? `“${s.lyric}”` : cameraLine(s), width * 0.07, height * 0.82 + width * 0.14, width * 0.86);
  };

  const frameAt = (sec) => {
    if (sec < titleSec) return drawTitle(sec);
    let t = sec - titleSec;
    for (let i = 0; i < shots.length; i += 1) {
      if (t < durations[i] || i === shots.length - 1) return drawShot(shots[i], Math.min(t, durations[i]), durations[i]);
      t -= durations[i];
    }
    return drawTitle(1);
  };

  frameAt(0);
  const stream = canvas.captureStream(fps);
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5_000_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
  recorder.start(250);

  const start = performance.now();
  await new Promise((resolve, reject) => {
    const tick = () => {
      if (signal?.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
      const sec = (performance.now() - start) / 1000;
      frameAt(Math.min(sec, total));
      onProgress?.(Math.min(1, sec / total));
      if (sec >= total) resolve(); else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }).finally(() => {
    if (recorder.state !== 'inactive') recorder.stop();
    stream.getTracks().forEach((t) => t.stop());
  });
  await stopped;
  const type = mime.split(';')[0];
  return { blob: new Blob(chunks, { type }), ext: videoExtension(mime), type };
}
