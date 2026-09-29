// Timeline maths shared by the UI, the preview player and the final render. Pure (no DOM),
// so it's unit-tested in node: slot timing, templates, beat snapping, BPM detection,
// lyric caption timing and auto-fill.

import { createShot, currentTake } from './project.js';

// Templates are slot layouts in seconds plus the edit effects that make them feel finished.
// `roles` (optional) cycles through shot titles. fx: punch (slow push-in), pulse (zoom bump on
// every beat), flash (white flash on each cut).
export const FX_LABELS = { punch: 'Punch-in', pulse: 'Beat pulse', flash: 'Flash cuts' };
export const TEMPLATES = [
  { id: 'hook15', name: 'Viral Hook 15', meta: '15s · TikTok · Reels', slots: [1, 1, 2, 2, 1, 1, 2, 2, 3], roles: ['Hook', 'Face', 'Move', 'Detail'], fx: ['pulse', 'flash'] },
  { id: 'beat30', name: 'Beat Cut 30', meta: '30s · 10 cuts on the beat', slots: [3, 3, 3, 3, 3, 3, 3, 3, 3, 3], roles: ['Performance', 'Close-up', 'B-roll', 'Wide'], fx: ['punch', 'flash'] },
  { id: 'drop20', name: 'Beat Drop 20', meta: '20s · slow build, fast drop', slots: [4, 4, 2, 1, 1, 1, 1, 1, 1, 2, 2], roles: ['Build', 'Build', 'Tension', 'Drop', 'Drop', 'Drop'], fx: ['pulse', 'flash'] },
  { id: 'verse-chorus', name: 'Verse → Chorus', meta: '60s · YouTube Shorts', slots: [8, 6, 8, 4, 10, 6, 8, 10], sections: ['Verse', 'Verse', 'Verse', 'Pre', 'Chorus', 'Chorus', 'Chorus', 'Outro'], fx: ['punch'] },
  { id: 'perf-broll', name: 'Performance + B-roll', meta: '45s · 12 cuts', slots: [6, 2, 2, 6, 2, 2, 6, 3, 3, 6, 3, 4], roles: ['Performance', 'B-roll', 'B-roll'], fx: ['punch', 'flash'] },
  { id: 'onetake', name: 'One-take Hook', meta: '15s · 1 shot', slots: [15], roles: ['One take — the hook'], fx: ['punch'] },
];

export const PX_PER_SEC = 16;

export function totalDuration(project) {
  return project.shots.reduce((n, s) => n + (Number(s.durationSec) || 0), 0);
}

// [{ shot, index, start, end }] in video time (0 = first frame of the edit).
export function slotTimes(project) {
  let t = 0;
  return project.shots.map((shot, index) => {
    const start = t;
    t += Number(shot.durationSec) || 0;
    return { shot, index, start, end: t };
  });
}

export function slotAt(project, t) {
  const slots = slotTimes(project);
  return slots.find((s) => t >= s.start && t < s.end) || slots.at(-1) || null;
}

// Where in the song the edit starts.
export const songOffset = (project) => project.track?.range?.start || 0;

export const beatSec = (bpm) => (bpm ? 60 / bpm : 0);

// Snap a length to whole half-bars (2 beats) so cuts land on the beat.
export function snapToBeat(sec, bpm) {
  const q = beatSec(bpm) * 2;
  if (!q) return sec;
  return Math.round(Math.max(q, Math.round(sec / q) * q) * 100) / 100;
}

export function applyTemplate(project, templateId) {
  const tpl = TEMPLATES.find((t) => t.id === templateId);
  if (!tpl) throw new Error('Unknown template');
  const bpm = project.track?.bpm;
  project.shots = tpl.slots.map((d, i) => createShot({
    title: tpl.roles ? `${tpl.roles[i % tpl.roles.length]} ${i + 1}` : `${tpl.sections?.[i] || 'Shot'} ${i + 1}`,
    section: tpl.sections?.[i] || '',
    durationSec: snapToBeat(d, bpm),
    lyric: project.lyrics[i] || '',
    fx: tpl.fx || [],
  }));
  return project.shots;
}

// Make the edit fit the chosen part of the song, cutting on the beat. Existing shots are
// re-timed (their takes are kept); if there are none, 2-bar shots are created.
export function buildBeatSlots(project) {
  const song = project.track;
  if (!song?.bpm) throw new Error('Add a song first so ReaShoota can find the beat.');
  const len = Math.max(1, (song.range.end || song.duration) - (song.range.start || 0));
  const bar = beatSec(song.bpm) * 4;
  if (!project.shots.length) {
    const n = Math.max(1, Math.round(len / (bar * 2)));
    project.shots = Array.from({ length: n }, (_, i) => createShot({ title: `Shot ${i + 1}`, lyric: project.lyrics[i] || '' }));
  }
  const each = len / project.shots.length;
  let used = 0;
  project.shots.forEach((s, i) => {
    const last = i === project.shots.length - 1;
    s.durationSec = last ? Math.max(beatSec(song.bpm), Math.round((len - used) * 100) / 100) : snapToBeat(each, song.bpm);
    used += s.durationSec;
  });
  return project.shots;
}

// Slot indexes that have no take yet, in order; extra clips get new slots appended.
export function autoFillTargets(project, clipCount, defaultSec = 3) {
  const targets = [];
  project.shots.forEach((s, i) => { if (!s.takes.length && targets.length < clipCount) targets.push(i); });
  while (targets.length < clipCount) {
    project.shots.push(createShot({ title: `Clip ${project.shots.length + 1}`, durationSec: snapToBeat(defaultSec, project.track?.bpm) }));
    targets.push(project.shots.length - 1);
  }
  return targets;
}

export function filledCount(project) {
  return project.shots.filter((s) => currentTake(s)).length;
}

// ---- captions ---------------------------------------------------------------

function wordsOf(text) {
  return String(text || '').split(/\s+/).filter(Boolean);
}

// The caption on screen at video time t: { text, words, active } or null.
// Uses synced lyric times when present, otherwise the current slot's lyric spread across it.
export function captionAt(project, t) {
  const songT = t + songOffset(project);
  const times = project.lyricTimes || [];
  const synced = project.lyrics.map((text, i) => ({ text, at: times[i] })).filter((l) => Number.isFinite(l.at) && l.text.trim());
  let line = null;
  let start = 0;
  let end = 0;
  if (synced.length) {
    for (let i = 0; i < synced.length; i += 1) {
      if (songT >= synced[i].at) {
        line = synced[i].text;
        start = synced[i].at;
        end = synced[i + 1]?.at ?? start + 4;
      }
    }
    if (line && songT > end) line = null;
    if (line) end = Math.min(end, start + 6);
    if (line && songT > end) line = null;
  } else {
    const slot = slotAt(project, t);
    if (slot?.shot.lyric && t < slot.end) {
      line = slot.shot.lyric;
      start = slot.start + songOffset(project);
      end = slot.end + songOffset(project);
    }
  }
  if (!line) return null;
  const words = wordsOf(line);
  const per = (end - start) / Math.max(1, words.length);
  const active = Math.min(words.length - 1, Math.max(0, Math.floor((songT - start) / Math.max(per, 0.01))));
  return { text: line, words, active };
}

// ---- audio analysis (pure) --------------------------------------------------

// Tempo from an onset-strength envelope sampled `rate` times per second.
export function detectBpm(envelope, rate, { min = 70, max = 160 } = {}) {
  if (!envelope?.length || !rate) return null;
  const mean = envelope.reduce((a, b) => a + b, 0) / envelope.length;
  const x = envelope.map((v) => v - mean);
  let best = null;
  let bestScore = -Infinity;
  for (let bpm = min; bpm <= max; bpm += 0.5) {
    const lag = (60 / bpm) * rate;
    const l0 = Math.floor(lag);
    const frac = lag - l0;
    let score = 0;
    for (let i = 0; i + l0 + 1 < x.length; i += 1) {
      score += x[i] * (x[i + l0] * (1 - frac) + x[i + l0 + 1] * frac);
    }
    score /= Math.max(1, x.length - l0);
    if (score > bestScore) { bestScore = score; best = bpm; }
  }
  return best ? Math.round(best) : null;
}

// Start (sec) of the loudest `len`-second stretch — a good guess for the chorus or hook.
export function loudestWindow(peaks, duration, len) {
  if (!peaks?.length || !duration || len >= duration) return 0;
  const perSec = peaks.length / duration;
  const w = Math.max(1, Math.round(len * perSec));
  let sum = 0;
  for (let i = 0; i < w; i += 1) sum += peaks[i];
  let best = sum;
  let bestI = 0;
  for (let i = w; i < peaks.length; i += 1) {
    sum += peaks[i] - peaks[i - w];
    if (sum > best) { best = sum; bestI = i - w + 1; }
  }
  return Math.round((bestI / perSec) * 10) / 10;
}

export function formatTime(sec, { tenths = true } = {}) {
  const s = Math.max(0, sec || 0);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${String(m).padStart(2, '0')}:${tenths ? r.toFixed(1).padStart(4, '0') : String(Math.floor(r)).padStart(2, '0')}`;
}
