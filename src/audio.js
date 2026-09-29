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
export function unlockAudio() {
  const c = audioContext();
  if (c.state === 'suspended') c.resume();
  return c;
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
