// Young-D-Guide association engine. Pure (no DOM) so it's unit-tested and runs offline.
//
// SONG MOMENT → LYRIC → MEANING → EMOTION → ASSOCIATION → WEIRD VISUAL ECHO → SHOT IDEA
//
// Moments come from lyrics (synced or per-slot) and from the sound itself (bass hits, drop-outs,
// beat switches, the chorus, ad-libs). For each moment the engine ranks the library's ideas in
// six directions, steered by the weirdness slider, SPIN modifiers and the video's motif world.

import { CONCEPTS, GENERIC, SONIC, MOTIFS } from './lexicon.js';
import { loudestWindow, slotTimes, songOffset, snapToBeat, formatTime } from '../timeline.js';

export { MOTIFS };

export const DIRECTIONS = [
  { id: 'literal', label: 'Literal', icon: '◆' },
  { id: 'object', label: 'Object rhyme', icon: '◆' },
  { id: 'metaphor', label: 'Metaphor', icon: '◆' },
  { id: 'weird', label: 'Weird / surreal', icon: '✦' },
  { id: 'practical', label: 'Practical', icon: '○' },
  { id: 'hybrid', label: 'Premium / AI hybrid', icon: '⬡' },
];

export const WEIRDNESS = ['Safe', 'Strange', 'Unhinged'];

export const MODIFIERS = [
  { id: 'weirder', label: 'Weirder' },
  { id: 'cheap', label: 'Cheaper' },
  { id: 'cinematic', label: 'More cinematic' },
  { id: 'street', label: 'More street' },
  { id: 'luxury', label: 'More luxury' },
  { id: 'emotional', label: 'More emotional' },
  { id: 'minimal', label: 'More minimal' },
  { id: 'surreal', label: 'More surreal' },
  { id: 'solo', label: 'Solo shoot' },
  { id: 'ai', label: 'AI version' },
];

// ---- library -----------------------------------------------------------------

function parseIdea(t, source, i) {
  const [dir, level, text, why, doThis, spec, tags, motifs, ai] = t;
  const [size, position, move, lens, fps, light, location, props] = spec.split('|');
  return {
    id: `${source.id}.${i}`,
    source: source.id,
    sourceLabel: source.label,
    dir, level, text, why,
    doThis: doThis.split(' / ').map((s) => s.trim()).filter(Boolean),
    spec: { size, position, move, lens, fps, light, location, props: (props || '').split(';').map((s) => s.trim()).filter(Boolean) },
    tags: (tags || '').split(',').map((s) => s.trim()).filter(Boolean),
    motifs: (motifs || '').split(',').map((s) => s.trim()).filter(Boolean),
    ai: ai || '',
  };
}

const SOURCES = [...CONCEPTS, GENERIC, ...Object.entries(SONIC).map(([id, s]) => ({ ...s, id: `sonic-${id}` }))];
const IDEAS = new Map();
const BY_SOURCE = new Map();
for (const src of SOURCES) {
  const list = (src.ideas || []).map((t, i) => parseIdea(t, src, i));
  BY_SOURCE.set(src.id, list);
  for (const idea of list) IDEAS.set(idea.id, idea);
}

export const getIdea = (id) => IDEAS.get(id) || null;
export const ideaCount = () => IDEAS.size;
export const sourceOf = (id) => SOURCES.find((s) => s.id === id) || null;

// ---- lyric analysis ----------------------------------------------------------

export function splitAdlibs(text) {
  const adlibs = [];
  const main = String(text || '').replace(/\(([^)]*)\)/g, (_, a) => { adlibs.push(a.trim()); return ' '; }).replace(/\s+/g, ' ').trim();
  return { main, adlibs };
}

// Concepts a lyric touches, strongest first: [{ concept, hits }]
export function detectConcepts(text) {
  const { main } = splitAdlibs(text);
  if (!main) return [];
  const found = [];
  for (const c of CONCEPTS) {
    const re = new RegExp(c.match.source, 'gi');
    const hits = (main.match(re) || []).length;
    if (hits) found.push({ concept: c, hits, first: main.search(re) });
  }
  // More hits first; ties go to the word that appears first in the line.
  return found.sort((a, b) => b.hits - a.hits || a.first - b.first).slice(0, 3).map(({ concept, hits }) => ({ concept, hits }));
}

// ---- ranking -----------------------------------------------------------------

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rand(seedStr) {
  let t = hashStr(seedStr) + 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function targetLevel(weirdness, mods) {
  return clamp(weirdness + (mods.includes('weirder') ? 1 : 0) + (mods.includes('surreal') ? 1 : 0) - (mods.includes('cheap') ? 0.5 : 0), 0, 2);
}

function scoreIdea(idea, { weight, L, mods, world, seed, exclude, momentId }) {
  let s = weight * 6;
  const want = idea.dir === 'weird' ? Math.max(L, 1) : L;
  const levelGap = Math.abs(idea.level - want);
  s -= levelGap * (idea.dir === 'literal' || idea.dir === 'practical' ? 0.8 : 2.2);
  for (const m of mods) {
    if (m === 'weirder' || m === 'surreal') { if (idea.tags.includes('surreal')) s += 2; continue; }
    if (idea.tags.includes(m)) s += 3.2;
    if (m === 'cheap' && idea.tags.includes('ai')) s -= 2.5;
    if (m === 'solo' && idea.tags.includes('crew')) s -= 3;
    if (m === 'ai' && idea.dir === 'hybrid') s += 2;
    if (m === 'minimal' && idea.tags.includes('crew')) s -= 1;
  }
  const overlap = idea.motifs.filter((x) => world.includes(x)).length;
  s += Math.min(overlap, 2) * 1.8;
  if (exclude.includes(idea.id)) s -= 100;
  s += rand(`${seed}|${momentId}|${idea.id}`) * 1.4;
  return s;
}

function poolFor(moment) {
  const pool = [];
  const concepts = moment.lyric ? detectConcepts(moment.lyric) : [];
  const weights = [1, 0.65, 0.45];
  concepts.forEach(({ concept }, i) => {
    for (const idea of BY_SOURCE.get(concept.id)) pool.push({ idea, weight: weights[i] });
  });
  const sonicKey = moment.sonic || (['bass', 'pause', 'switch', 'adlib'].includes(moment.kind) ? moment.kind : null);
  if (sonicKey && BY_SOURCE.get(`sonic-${sonicKey}`)?.length) {
    for (const idea of BY_SOURCE.get(`sonic-${sonicKey}`)) pool.push({ idea, weight: concepts.length ? 0.7 : 1 });
  }
  const generic = !concepts.length && !sonicKey;
  for (const idea of BY_SOURCE.get('statement')) pool.push({ idea, weight: generic ? 0.9 : 0.25 });
  return { pool, concepts };
}

// Six directions for one moment. opts: { weirdness 0-2, modifiers[], world[], seed, exclude[] }
export function suggest(moment, opts = {}) {
  const { weirdness = 1, modifiers = [], world = [], seed = 0, exclude = [] } = opts;
  const mods = modifiers;
  const L = targetLevel(weirdness, mods);
  const { pool, concepts } = poolFor(moment);
  const scored = pool.map(({ idea, weight }) => ({
    idea, score: scoreIdea(idea, { weight, L, mods, world, seed, exclude, momentId: moment.id }),
  })).sort((a, b) => b.score - a.score);

  // One idea per direction (best), plus two alternatives.
  const seen = new Set();
  const directions = DIRECTIONS.map((d) => {
    const list = scored.filter((x) => x.idea.dir === d.id && !seen.has(x.idea.id));
    const [main, ...rest] = list;
    if (main) seen.add(main.idea.id);
    return { ...d, idea: main?.idea || null, alts: rest.slice(0, 2).map((x) => x.idea) };
  }).filter((d) => d.idea);
  if (mods.includes('ai')) directions.sort((a, b) => (b.id === 'hybrid') - (a.id === 'hybrid'));
  if (mods.includes('cheap') || mods.includes('solo')) directions.sort((a, b) => (b.id === 'practical') - (a.id === 'practical'));

  // Headline "visual echo": weird leads once the slider leaves SAFE.
  const dirBonus = (dir) => (L >= 1 ? { weird: 2.5, metaphor: 1 }[dir] || 0 : { metaphor: 1.5, object: 1.2, literal: 0.5 }[dir] || 0);
  const headline = directions
    .map((d) => ({ d, s: scored.find((x) => x.idea.id === d.idea.id).score + dirBonus(d.id) }))
    .sort((a, b) => b.s - a.s)[0]?.d.idea || null;

  const top = concepts[0]?.concept;
  const sonic = moment.sonic || moment.kind;
  const sonicSrc = SONIC[sonic];
  return {
    headline,
    directions,
    bridge: {
      says: moment.lyric ? splitAdlibs(moment.lyric).main : (sonicSrc?.label || 'Instrumental'),
      means: top?.meaning || sonicSrc?.meaning || GENERIC.meaning,
      feels: top?.emotion || sonicSrc?.emotion || GENERIC.emotion,
      concepts: concepts.map((c) => c.concept.label),
      motifs: [...new Set([...(top?.motifs || sonicSrc?.motifs || GENERIC.motifs)])].slice(0, 4),
    },
  };
}

// Ideas that share a direction or motif world with `idea`, same concept first.
export function moreLike(idea, { exclude = [], world = [], seed = 0 } = {}) {
  const out = [];
  for (const other of IDEAS.values()) {
    if (other.id === idea.id || exclude.includes(other.id)) continue;
    let s = 0;
    if (other.source === idea.source) s += 3;
    if (other.dir === idea.dir) s += 2.5;
    s += other.motifs.filter((m) => idea.motifs.includes(m)).length * 1.5;
    s += other.motifs.filter((m) => world.includes(m)).length * 0.8;
    s -= Math.abs(other.level - idea.level) * 0.7;
    s += rand(`${seed}|more|${other.id}`) * 0.8;
    if (s > 3) out.push({ other, s });
  }
  return out.sort((a, b) => b.s - a.s).slice(0, 3).map((x) => x.other);
}

// ---- sonic events --------------------------------------------------------------

function spaced(cands, gap, max) {
  const out = [];
  for (const c of cands.sort((a, b) => b.score - a.score)) {
    if (out.every((o) => Math.abs(o.t - c.t) >= gap)) out.push(c);
    if (out.length >= max) break;
  }
  return out.sort((a, b) => a.t - b.t);
}

// From the waveform's energy (0–100 per bucket): bass hits, drop-outs and beat switches.
export function detectSonicEvents(peaks, duration) {
  if (!peaks?.length || !duration) return [];
  const per = peaks.length / duration;
  const at = (i) => Math.round((i / per) * 10) / 10;
  const mean = (a, b) => {
    let s = 0; let n = 0;
    for (let i = Math.max(0, a); i < Math.min(peaks.length, b); i += 1) { s += peaks[i]; n += 1; }
    return n ? s / n : 0;
  };
  const bass = [];
  const pause = [];
  const change = [];
  const w = Math.max(2, Math.round(per * 3));
  for (let i = 4; i < peaks.length; i += 1) {
    const prev = mean(i - 4, i);
    const jump = peaks[i] - prev;
    if (jump > 30 && peaks[i] > 55) bass.push({ kind: 'bass', t: at(i), score: jump });
  }
  for (let i = 1; i < peaks.length; i += 1) {
    const local = mean(i - Math.round(per * 2), i + Math.round(per * 2));
    if (local < 25 || peaks[i] >= local * 0.35 || peaks[i - 1] < local * 0.35) continue;
    let j = i;
    while (j < peaks.length && peaks[j] < local * 0.35) j += 1;
    const len = (j - i) / per;
    if (len >= 0.2 && len <= 2.5 && j < peaks.length) pause.push({ kind: 'pause', t: at(i), score: local });
  }
  for (let i = w; i < peaks.length - w; i += Math.max(1, Math.round(per / 2))) {
    const d = mean(i, i + w) - mean(i - w, i);
    if (Math.abs(d) > 22) change.push({ kind: 'switch', t: at(i), score: Math.abs(d) });
  }
  return [...spaced(bass, 6, 6), ...spaced(pause, 6, 4), ...spaced(change, 8, 4)].sort((a, b) => a.t - b.t);
}

// ---- moments on the timeline -------------------------------------------------

const normLine = (s) => splitAdlibs(s).main.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim();

// Every creative opportunity on the song timeline, in song time.
export function buildMoments(project) {
  const off = songOffset(project);
  const track = project.track;
  const start = track ? track.range.start : 0;
  // Without a song there's no range to clip to: every lyric line is a moment.
  const end = track ? track.range.end : Infinity;
  const moments = [];
  const times = project.lyricTimes || [];
  const counts = new Map();
  for (const l of project.lyrics) { const k = normLine(l); if (k) counts.set(k, (counts.get(k) || 0) + 1); }

  const pushLyric = (lyric, t, e) => {
    if (!lyric?.trim() || t < start - 0.01 || t >= end) return;
    const hero = (counts.get(normLine(lyric)) || 0) >= 2;
    moments.push({ id: `l-${Math.round(t * 10)}`, kind: 'lyric', t, end: Math.min(e, end), lyric, hero });
    const { adlibs } = splitAdlibs(lyric);
    if (adlibs.length) {
      const at = t + (Math.min(e, end) - t) * 0.7;
      moments.push({ id: `a-${Math.round(at * 10)}`, kind: 'adlib', t: at, end: Math.min(at + 1, end), lyric: adlibs.join(' '), adlib: true });
    }
  };

  const synced = project.lyrics.map((text, i) => ({ text, at: times[i] })).filter((l) => Number.isFinite(l.at));
  if (synced.length) {
    synced.sort((a, b) => a.at - b.at).forEach((l, i, arr) => pushLyric(l.text, l.at, arr[i + 1]?.at ?? l.at + 4));
  } else {
    for (const s of slotTimes(project)) if (s.shot.lyric) pushLyric(s.shot.lyric, off + s.start, off + s.end);
  }

  if (track?.peaks?.length) {
    for (const ev of detectSonicEvents(track.peaks, track.duration)) {
      if (ev.t < start || ev.t >= end) continue;
      const near = moments.find((m) => m.kind === 'lyric' && Math.abs(m.t - ev.t) < 0.8);
      if (near) { near.sonic = near.sonic || ev.kind; continue; }
      moments.push({ id: `${ev.kind[0]}-${Math.round(ev.t * 10)}`, kind: ev.kind, t: ev.t, end: Math.min(ev.t + 2, end), lyric: '' });
    }
    const len = end - start;
    if (len > 20) {
      const c = loudestWindow(track.peaks, track.duration, Math.min(15, len / 3));
      if (c >= start && c < end) {
        const near = moments.find((m) => m.kind === 'lyric' && Math.abs(m.t - c) < 1.5);
        if (near) near.hero = true;
        else moments.push({ id: `c-${Math.round(c * 10)}`, kind: 'chorus', t: c, end: Math.min(c + 4, end), lyric: '', hero: true });
      }
    }
  }

  return moments.sort((a, b) => a.t - b.t).map((m) => {
    const concepts = m.lyric ? detectConcepts(m.lyric) : [];
    const strength = (m.kind === 'lyric' ? 2 : 1) + concepts.reduce((n, c) => n + c.hits, 0) + (m.hero ? 3 : 0) + (m.sonic ? 1.5 : 0) + (m.kind === 'switch' ? 1 : 0);
    return { ...m, videoT: m.t - off, strength, concept: concepts[0]?.concept.label || null };
  });
}

// Timeline marker symbol for a moment, given its headline idea.
export function markerFor(moment, headline) {
  if (moment.hero || moment.kind === 'chorus') return { icon: '⚡', label: 'Hero moment' };
  if (moment.kind === 'switch') return { icon: '↗', label: 'Transition' };
  const d = headline?.dir;
  if (d === 'weird') return { icon: '✦', label: 'Weird visual' };
  if (d === 'practical') return { icon: '○', label: 'Easy practical' };
  if (d === 'hybrid') return { icon: '⬡', label: 'AI / hybrid' };
  return { icon: '◆', label: 'Lyric visual' };
}

// Show the strongest moments by default: at most one per `gap` seconds.
export function strongest(moments, gap = 3.5) {
  const keep = [];
  for (const m of [...moments].sort((a, b) => b.strength - a.strength)) {
    if (keep.every((k) => Math.abs(k.t - m.t) >= gap)) keep.push(m);
  }
  return keep.sort((a, b) => a.t - b.t);
}

// ---- USE THIS → production shot ----------------------------------------------

function titleFrom(text) {
  const first = text.split(/[,;:—.]/)[0].trim();
  return first.length > 46 ? `${first.slice(0, 44).replace(/\s+\S*$/, '')}…` : first;
}

export function ideaToShot(idea, moment, project) {
  const bpm = project.track?.bpm;
  const len = Math.max(1, moment.end - moment.t);
  const lensLabel = idea.spec.lens ? `${idea.spec.lens.replace(/x$/, '×')}` : '';
  return {
    title: titleFrom(idea.text),
    description: idea.text,
    lyric: moment.lyric ? splitAdlibs(moment.lyric).main : '',
    camera: {
      lens: lensLabel,
      move: idea.spec.move,
      angle: [idea.spec.size, idea.spec.position].filter(Boolean).join(' · '),
      fps: idea.spec.fps,
      notes: idea.spec.light,
    },
    location: idea.spec.location,
    props: idea.spec.props,
    durationSec: bpm ? snapToBeat(len, bpm) : Math.round(len * 10) / 10,
    echo: {
      ideaId: idea.id,
      dir: idea.dir,
      level: idea.level,
      concept: idea.sourceLabel,
      why: idea.why,
      size: idea.spec.size,
      position: idea.spec.position,
      move: idea.spec.move,
      light: idea.spec.light,
      howTo: idea.doThis,
      ai: idea.ai || (idea.dir === 'hybrid' || idea.tags.includes('ai') ? 'Compositing / AI video needed' : ''),
      cut: `In on the downbeat at ${formatTime(moment.t)}, out at ${formatTime(moment.end)}`,
      at: moment.t,
      end: moment.end,
      motifs: idea.motifs,
    },
  };
}

// Put an idea into the shot list at the moment's place on the timeline. Returns the slot index.
export function applyIdea(project, moment, idea, createShot) {
  const fields = ideaToShot(idea, moment, project);
  const slots = slotTimes(project);
  let slot = slots.find((s) => moment.videoT >= s.start - 0.01 && moment.videoT < s.end);
  if (!slot && slots.length) slot = moment.videoT < 0 ? slots[0] : slots.at(-1);
  if (!slot) {
    project.shots.push(createShot({ ...fields, durationSec: fields.durationSec }));
    project.shots.at(-1).echo = fields.echo;
    growWorld(project, idea);
    return project.shots.length - 1;
  }
  const shot = slot.shot;
  // Keep the previous plan so "Undo idea" can restore it; takes and timing stay.
  shot.history = [...(shot.history || []), {
    at: new Date().toISOString(), title: shot.title, description: shot.description,
    camera: JSON.parse(JSON.stringify(shot.camera)), location: shot.location, props: [...shot.props], durationSec: shot.durationSec,
    lyric: shot.lyric, echo: shot.echo ? JSON.parse(JSON.stringify(shot.echo)) : null,
  }].slice(-5);
  Object.assign(shot, {
    title: fields.title, description: fields.description, camera: fields.camera,
    location: fields.location, props: fields.props, echo: fields.echo,
  });
  if (fields.lyric) shot.lyric = fields.lyric;
  growWorld(project, idea);
  return slot.index;
}

// The first ideas a creator picks define the motif world later suggestions stay inside.
function growWorld(project, idea) {
  const world = project.direction.motifs || (project.direction.motifs = []);
  for (const m of idea.motifs) {
    if (world.length >= 4) break;
    if (!world.includes(m)) world.push(m);
  }
}

// Give every slot of a fresh layout (template / beat slots) a real idea instead of
// "B-roll 3": the slot's role picks the direction, its lyric (or the song's lyrics in
// order) picks the concept, and ideas never repeat within the video.
const ROLE_DIRS = [
  [/b-roll|detail|build|tension|insert/i, ['object', 'weird', 'metaphor']],
  [/performance|face|one take|verse/i, ['literal', 'practical', 'metaphor']],
  [/hook|drop|chorus|close-up|move/i, ['weird', 'metaphor', 'object']],
  [/wide|outro|pre/i, ['metaphor', 'literal', 'weird']],
];

export function fillSlotIdeas(project, { weirdness = 1, onlyAuto = false } = {}) {
  const slots = slotTimes(project);
  const off = songOffset(project);
  const used = [];
  const world = [...(project.direction.motifs || [])];
  const lyrics = project.lyrics.filter((l) => l.trim());
  let filled = 0;
  for (const s of slots) {
    const shot = s.shot;
    if (shot.echo && !(onlyAuto && shot.echo.auto)) { if (shot.echo.ideaId) used.push(shot.echo.ideaId); continue; }
    const role = shot.echo?.role || shot.title.replace(/\s*\d+$/, '').trim() || 'Shot';
    const lyric = shot.lyric || (lyrics.length ? lyrics[s.index % lyrics.length] : '');
    const m = { id: `slot-${s.index}`, kind: 'lyric', t: off + s.start, end: off + s.end, videoT: s.start, lyric };
    const r = suggest(m, { weirdness, world, seed: s.index, exclude: used });
    const prefs = ROLE_DIRS.find(([re]) => re.test(role))?.[1] || [];
    let idea = r.headline;
    for (const d of prefs) {
      const hit = r.directions.find((x) => x.id === d && !used.includes(x.idea.id));
      if (hit) { idea = hit.idea; break; }
    }
    if (!idea) continue;
    const f = ideaToShot(idea, m, project);
    Object.assign(shot, {
      title: `${role} · ${f.title}`,
      description: f.description,
      camera: f.camera,
      location: f.location,
      props: f.props,
      echo: { ...f.echo, auto: true, role },
    });
    used.push(idea.id);
    for (const mo of idea.motifs) if (world.length < 4 && !world.includes(mo)) world.push(mo);
    filled += 1;
  }
  if (!(project.direction.motifs || []).length) project.direction.motifs = world;
  return filled;
}
