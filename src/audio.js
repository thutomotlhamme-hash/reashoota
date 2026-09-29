// Song handling on the phone: decode the audio file, draw its waveform, find the tempo,
// and play it in sync with the timeline (one shared AudioContext, unlocked on a tap).

import { detectBpm } from './timeline.js';

let ctx = null;
export function audioContext() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
  }
  return ctx;
}

// Must be called synchronously inside a tap on iOS, before any await.
// iPhones mute web audio when the ring/silent switch is on. Declaring a "playback" audio
// session (iOS 16.4+) and keeping a silent media element playing moves the page into the
// media category, so the song is heard like any music app.
let silentEl = null;
function silentWavUrl() {
  const rate = 8000;
  const n = rate / 2;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const w = (o, str) => { for (let i = 0; i < str.length; i += 1) v.setUint8(o + i, str.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate, true);
  v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, n, true);
  for (let i = 0; i < n; i += 1) v.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

export function unlockAudio() {
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* older iOS */ }
  const c = audioContext();
  if (c.state === 'suspended' || c.state === 'interrupted') c.resume();
  // A one-sample buffer played inside the tap fully unlocks the context on iOS.
  try {
    const b = c.createBuffer(1, 1, 22050);
    const src = c.createBufferSource();
    src.buffer = b;
    src.connect(c.destination);
    src.start(0);
  } catch { /* ignore */ }
  try {
    if (!silentEl) {
      silentEl = new Audio(silentWavUrl());
      silentEl.loop = true;
      silentEl.setAttribute('playsinline', '');
    }
    silentEl.play().catch(() => {});
  } catch { /* ignore */ }
  return c;
}

export function releaseAudio() {
  silentEl?.pause();
}

const buffers = new Map();
export async function decodeSong(blob, key) {
  if (key && buffers.has(key)) return buffers.get(key);
  const data = await blob.arrayBuffer();
  const buf = await new Promise((resolve, reject) => {
    // Callback form for older Safari.
    const p = audioContext().decodeAudioData(data, resolve, reject);
    if (p?.then) p.then(resolve, reject);
  });
  if (key) buffers.set(key, buf);
  return buf;
}

// Waveform (0–100 per bucket) and tempo from a decoded buffer.
export function analyse(buffer, buckets = 800) {
  const ch = buffer.getChannelData(0);
  const ch2 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const size = Math.floor(ch.length / buckets) || 1;
  const peaks = [];
  let top = 0;
  for (let b = 0; b < buckets; b += 1) {
    let sum = 0;
    const from = b * size;
    for (let i = from; i < from + size && i < ch.length; i += 16) {
      const v = ch2 ? (ch[i] + ch2[i]) / 2 : ch[i];
      sum += v * v;
    }
    const rms = Math.sqrt(sum / (size / 16));
    peaks.push(rms);
    if (rms > top) top = rms;
  }
  const norm = peaks.map((v) => Math.round((v / (top || 1)) * 100));

  // Onset envelope: positive energy changes at ~100 Hz, over the first 60s max.
  const hop = Math.round(buffer.sampleRate / 100);
  const limit = Math.min(ch.length, buffer.sampleRate * 60);
  const env = [];
  let prev = 0;
  for (let i = 0; i + hop < limit; i += hop) {
    let e = 0;
    for (let j = i; j < i + hop; j += 4) e += ch[j] * ch[j];
    env.push(Math.max(0, e - prev));
    prev = e;
  }
  return { peaks: norm, bpm: detectBpm(env, 100), duration: buffer.duration };
}

// Plays [from, to) seconds of the song. Returns a handle with stop() and the context time
// at which playback of `from` began.
export function playSong(buffer, from, to, { destination } = {}) {
  const c = audioContext();
  const src = c.createBufferSource();
  src.buffer = buffer;
  src.connect(destination || c.destination);
  const startAt = c.currentTime + 0.05;
  src.start(startAt, Math.max(0, from), to ? Math.max(0.01, to - from) : undefined);
  return {
    startAt,
    stop() { try { src.stop(); } catch { /* already stopped */ } },
    set onended(fn) { src.onended = fn; },
  };
}
