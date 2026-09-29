// In-app camera: live preview, countdown and a take recorded for exactly the slot's length.

import { canvasToBlob, drawCover } from './images.js';

export function cameraSupported() {
  return !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
}

export async function openCamera(facingMode = 'environment') {
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode, width: { ideal: 1080 }, height: { ideal: 1920 }, frameRate: { ideal: 30 } },
    audio: true,
  });
}

export function closeCamera(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

function pickMime() {
  const list = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
  return list.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

// Records `seconds` of the stream. onTick(elapsedSec) drives the progress bar.
export function recordTake(stream, seconds, { onTick, signal } = {}) {
  return new Promise((resolve, reject) => {
    const mimeType = pickMime();
    const rec = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 10_000_000 } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    rec.onerror = (e) => reject(e.error || new Error('Recording failed'));
    rec.onstop = () => {
      const type = (rec.mimeType || mimeType || 'video/mp4').split(';')[0];
      resolve({ blob: new Blob(chunks, { type }), type, ext: type === 'video/mp4' ? 'mp4' : 'webm', dur: seconds });
    };
    const t0 = performance.now();
    rec.start(250);
    const tick = () => {
      const el = (performance.now() - t0) / 1000;
      onTick?.(Math.min(el, seconds));
      if (signal?.aborted) { rec.stop(); return; }
      if (el >= seconds) { if (rec.state !== 'inactive') rec.stop(); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

// A still from a video blob for the timeline thumbnail.
export async function videoThumb(blob, at = 0.4) {
  const url = URL.createObjectURL(blob);
  try {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.src = url;
    await new Promise((res, rej) => {
      v.onloadeddata = res;
      v.onerror = () => rej(new Error('Unreadable video'));
      setTimeout(res, 5000);
    });
    const dur = Number.isFinite(v.duration) ? v.duration : 1;
    await new Promise((res) => {
      v.onseeked = res;
      try { v.currentTime = Math.min(at, dur / 2); } catch { res(); }
      setTimeout(res, 2000);
    });
    const c = document.createElement('canvas');
    c.width = 270;
    c.height = 480;
    drawCover(c.getContext('2d'), v, 0, 0, c.width, c.height);
    return { blob: await canvasToBlob(c, 'image/jpeg', 0.8), duration: dur };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
