// The timeline player: draws each slot's chosen take (or its reference frame) in order,
// synced to the song, with captions burned in. The same engine drives the on-screen
// preview and the final 9:16 MP4 export (canvas + song → MediaRecorder).

import { getAsset } from './store.js';
import { currentTake } from './project.js';
import { captionAt, slotTimes, songOffset, totalDuration } from './timeline.js';
import { drawCaption, loadCaptionFont } from './captions.js';
import { drawCover, loadImage } from './images.js';
import { audioContext, decodeSong, playSong } from './audio.js';

const urls = new Map();
async function blobUrl(assetId) {
  if (urls.has(assetId)) return urls.get(assetId);
  const a = await getAsset(assetId);
  if (!a) return null;
  const u = URL.createObjectURL(a.blob);
  urls.set(assetId, u);
  return u;
}

// Videos stay in the DOM (invisible): iOS Safari only decodes frames for attached elements.
let host = null;
function videoHost() {
  if (!host) {
    host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:0.01;pointer-events:none;z-index:-1';
    document.body.appendChild(host);
  }
  return host;
}

function loadVideo(src) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.loop = true; // a clip shorter than its slot keeps moving instead of freezing
    v.setAttribute('playsinline', '');
    v.preload = 'auto';
    v.width = 2;
    videoHost().appendChild(v);
    const done = () => resolve(v);
    v.addEventListener('loadeddata', done, { once: true });
    v.addEventListener('error', () => resolve(null), { once: true });
    setTimeout(done, 6000);
    v.src = src;
    v.load();
  });
}

// Everything the player needs, loaded once: take videos, reference frames, the song.
export async function loadMedia(project) {
  const clips = new Map();
  const frames = new Map();
  for (const s of project.shots) {
    const take = currentTake(s);
    if (take) {
      const u = await blobUrl(take.assetId);
      const v = u && await loadVideo(u);
      if (v) clips.set(s.id, v);
      const thumb = take.thumbId && await getAsset(take.thumbId);
      if (thumb) { try { frames.set(s.id, await loadImage(thumb.blob)); } catch { /* ignore */ } }
    } else if (s.frameAssetId) {
      const a = await getAsset(s.frameAssetId);
      if (a) { try { frames.set(s.id, await loadImage(a.thumb || a.blob)); } catch { /* ignore */ } }
    }
  }
  let song = null;
  let songEl = null;
  if (project.track?.assetId) {
    const a = await getAsset(project.track.assetId);
    if (a) {
      try { song = await decodeSong(a.blob, a.id); } catch { song = null; }
      // Live playback uses a media element: iPhones play it even with the silent switch on.
      songEl = new Audio(await blobUrl(a.id));
      songEl.preload = 'auto';
      songEl.setAttribute('playsinline', '');
    }
  }
  await loadCaptionFont(project.captions.font);
  return { clips, frames, song, songEl };
}

function drawEmpty(ctx, slot, W, H) {
  ctx.fillStyle = '#2a1a66';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#b6a8ff';
  ctx.font = `700 ${Math.round(W * 0.045)}px "JetBrains Mono", monospace`;
  ctx.textAlign = 'center';
  ctx.fillText(`S${String(slot.index + 1).padStart(2, '0')} · NOT SHOT YET`, W / 2, H * 0.4);
  ctx.fillStyle = '#ffffff';
  ctx.font = `${Math.round(W * 0.075)}px Anton, sans-serif`;
  ctx.fillText(slot.shot.title.toUpperCase().slice(0, 22), W / 2, H * 0.4 + W * 0.11);
  ctx.textAlign = 'start';
}

export class TimelinePlayer {
  constructor(project, media, { canvas, destination, onTime, onEnd, fades = false, fillGaps = false } = {}) {
    this.fades = fades;
    this.fillGaps = fillGaps;
    this.activeVideo = null;
    this.project = project;
    this.media = media;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.destination = destination;
    this.onTime = onTime;
    this.onEnd = onEnd;
    this.playing = false;
    this.activeSlot = -1;
  }

  get duration() { return totalDuration(this.project); }

  // Clip sound for song-less edits: to the speakers in preview, into the recording on export.
  routeClipAudio(v) {
    if (this.destination) {
      const ac = audioContext();
      if (!v.audioNode) { try { v.audioNode = ac.createMediaElementSource(v); } catch { return; } }
      try { v.audioNode.disconnect(); } catch { /* not connected */ }
      v.audioNode.connect(this.destination);
    }
    v.muted = false;
  }

  sourceSlot(slots, i) {
    if (this.media.clips.has(slots[i].shot.id)) return slots[i];
    for (let k = i - 1; k >= 0; k -= 1) if (this.media.clips.has(slots[k].shot.id)) return slots[k];
    for (let k = i + 1; k < slots.length; k += 1) if (this.media.clips.has(slots[k].shot.id)) return slots[k];
    return slots[i];
  }

  draw(t, { live = false } = {}) {
    const { ctx, canvas } = this;
    const W = canvas.width;
    const H = canvas.height;
    const slots = slotTimes(this.project);
    const slot = slots.find((s) => t >= s.start && t < s.end) || slots.at(-1);
    if (!slot) { ctx.fillStyle = '#2a1a66'; ctx.fillRect(0, 0, W, H); return; }
    // In the finished video an unfilmed slot keeps the nearest filmed clip rolling, so no
    // placeholder card ever reaches the viewer.
    const src = this.fillGaps ? this.sourceSlot(slots, slot.index) : slot;
    const v = this.media.clips.get(src.shot.id);
    if (live && slot.index !== this.activeSlot) {
      this.activeSlot = slot.index;
      if (v !== this.activeVideo) {
        if (this.activeVideo) { this.activeVideo.pause(); this.activeVideo.muted = true; }
        this.activeVideo = v || null;
        if (v) {
          // No song: the clip's own sound is the soundtrack.
          if (this.clipAudio) this.routeClipAudio(v);
          const want = src === slot ? Math.max(0, t - slot.start) : 0;
          // Only seek when needed: slots normally start their clip from the top.
          if (Math.abs(v.currentTime - want) > 0.25) { try { v.currentTime = want; } catch { /* not seekable */ } }
          v.play().catch(() => {});
        }
      }
    }
    const frame = this.media.frames.get(src.shot.id);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    // Edit effects: punch-in over the slot, zoom bump on every beat.
    const fx = slot.shot.fx || [];
    const local = t - slot.start;
    const len = Math.max(0.01, slot.end - slot.start);
    let zoom = 1;
    if (fx.includes('punch')) zoom += 0.07 * Math.min(1, local / len);
    const bpm = this.project.track?.bpm;
    if (fx.includes('pulse') && bpm) {
      const beat = 60 / bpm;
      const phase = ((t + songOffset(this.project)) % beat) / beat;
      zoom += 0.045 * (1 - phase) ** 3;
    }
    const zw = W * zoom;
    const zh = H * zoom;
    const zx = (W - zw) / 2;
    const zy = (H - zh) / 2;
    if (v && (v.readyState >= 2 || (v.seeking && v.videoWidth))) drawCover(ctx, v, zx, zy, zw, zh);
    else if (frame) drawCover(ctx, frame, zx, zy, zw, zh);
    else drawEmpty(ctx, slot, W, H);
    if (fx.includes('flash') && slot.index > 0 && local < 0.14) {
      ctx.fillStyle = `rgba(255,255,255,${0.85 * (1 - local / 0.14)})`;
      ctx.fillRect(0, 0, W, H);
    }
    if (this.project.captions.enabled) drawCaption(ctx, captionAt(this.project, t), this.project.captions, W, H);
    if (this.fades) {
      // Fade up from black and out at the end, like a finished edit.
      const total = this.duration;
      const a = Math.max(0, 1 - t / 0.35, 1 - (total - t) / 0.6);
      if (a > 0) { ctx.fillStyle = `rgba(0,0,0,${Math.min(1, a)})`; ctx.fillRect(0, 0, W, H); }
    }
  }

  play(from = 0) {
    this.stop();
    const total = this.duration;
    if (!total) return Promise.resolve();
    this.playing = true;
    this.activeSlot = -1;
    const song = this.media.song;
    const el = this.media.songEl;
    const off = songOffset(this.project);
    this.clipAudio = !song && !el;
    let clock;
    if (el && !this.destination) {
      // Preview: the song plays through a media element and drives the clock.
      el.currentTime = off + from;
      el.play().catch(() => {});
      this.el = el;
      const t0 = performance.now();
      clock = () => (el.paused || el.currentTime < off + from - 0.05
        ? from + (performance.now() - t0) / 1000
        : el.currentTime - off);
    } else if (song) {
      this.audio = playSong(song, off + from, off + total, { destination: this.destination });
      const ac = audioContext();
      const startAt = this.audio.startAt;
      clock = () => Math.max(0, ac.currentTime - startAt) + from;
    } else {
      const t0 = performance.now();
      clock = () => (performance.now() - t0) / 1000 + from;
    }
    return new Promise((resolve) => {
      this.resolve = resolve;
      const tick = () => {
        if (!this.playing) return;
        const t = clock();
        if (t >= total) { this.draw(total - 0.01); this.finish(); return; }
        this.draw(t, { live: true });
        this.onTime?.(t);
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    });
  }

  finish() {
    this.stop();
    this.onEnd?.();
  }

  stop() {
    const wasPlaying = this.playing;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.audio?.stop();
    this.audio = null;
    this.el?.pause();
    this.el = null;
    for (const v of this.media.clips.values()) v.pause();
    this.activeVideo = null;
    this.activeSlot = -1;
    if (wasPlaying) { this.resolve?.(); this.resolve = null; }
  }
}

function pickMime(withAudio) {
  if (typeof MediaRecorder === 'undefined') return null;
  const list = withAudio
    ? ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4;codecs=avc1.42E01E,opus', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  return list.find((m) => MediaRecorder.isTypeSupported(m)) || null;
}

// Records the whole timeline to a vertical video with the song. Takes real time.
export async function renderFinal(project, { onProgress, onCanvas, signal, width = 1080, height = 1920 } = {}) {
  const media = await loadMedia(project);
  const mime = pickMime(true);
  if (!mime) throw new Error('This browser can’t record video. Use Safari on iPhone.');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ac = audioContext();
  const dest = ac.createMediaStreamDestination();
  // Song goes through a gain node so it can fade out with the picture.
  let gain = null;
  gain = ac.createGain();
  gain.connect(dest);
  const total = totalDuration(project);
  const player = new TimelinePlayer(project, media, {
    canvas, destination: gain, fades: true, fillGaps: true, onTime: (t) => onProgress?.(t / total),
  });
  for (const v of media.clips.values()) { try { v.currentTime = 0; } catch { /* ignore */ } }
  player.draw(0);
  onCanvas?.(canvas);
  const stream = new MediaStream([
    ...canvas.captureStream(30).getVideoTracks(),
    ...dest.stream.getAudioTracks(),
  ]);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000, audioBitsPerSecond: 256_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });
  const abort = () => player.stop();
  signal?.addEventListener('abort', abort);
  rec.start(500);
  {
    const t0 = ac.currentTime + 0.05;
    gain.gain.setValueAtTime(1, t0 + Math.max(0, total - 0.6));
    gain.gain.linearRampToValueAtTime(0.0001, t0 + total);
  }
  await player.play(0);
  // Hold the last (black) frame briefly so the recorder never clips the ending.
  await new Promise((r) => { setTimeout(r, 300); });
  signal?.removeEventListener('abort', abort);
  if (rec.state !== 'inactive') rec.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const type = mime.split(';')[0];
  return { blob: new Blob(chunks, { type }), ext: type === 'video/mp4' ? 'mp4' : 'webm', type };
}
