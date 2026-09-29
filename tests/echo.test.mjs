import test from 'node:test';
import assert from 'node:assert/strict';

import { createProject, createShot, demoProject, restorePreviousIdea } from '../src/project.js';
import {
  DIRECTIONS, MOTIFS, applyIdea, buildMoments, detectConcepts, detectSonicEvents, getIdea, ideaCount,
  ideaToShot, markerFor, moreLike, splitAdlibs, strongest, suggest,
} from '../src/echo/engine.js';
import { CONCEPTS } from '../src/echo/lexicon.js';

const moment = (lyric, extra = {}) => ({ id: `m-${lyric}`, kind: 'lyric', t: 12, end: 16, videoT: 12, lyric, ...extra });

test('library is well formed: every idea parses, has a why, steps and a real motif', () => {
  assert.ok(ideaCount() > 200, `${ideaCount()} ideas`);
  for (const c of CONCEPTS) {
    const dirs = new Set(c.ideas.map((i) => i[0]));
    for (const d of DIRECTIONS) assert.ok(dirs.has(d.id), `${c.id} has ${d.id}`);
    for (const t of c.ideas) {
      assert.ok(t.length >= 8, `${c.id}: ${t[2]}`);
      assert.equal(t[5].split('|').length, 8, `${c.id} spec: ${t[5]}`);
      assert.ok(t[3].length > 10, `${c.id} why`);
      for (const m of t[7].split(',')) assert.ok(MOTIFS.includes(m), `${c.id} motif ${m}`);
    }
  }
});

test('the brief’s example lyrics land on the right concepts', () => {
  const top = (l) => detectConcepts(l)[0]?.concept.id;
  assert.equal(top('Everybody watching me'), 'watched');
  assert.equal(top('My heart went cold'), 'cold');
  assert.equal(top('They switched sides'), 'switched');
  assert.equal(top('I carry the whole team'), 'carry');
  assert.equal(detectConcepts('la la la').length, 0);
});

test('suggest returns six directions with reasons; weird leads once the slider leaves safe', () => {
  const r = suggest(moment('Everybody watching me'), { weirdness: 1, seed: 1 });
  assert.equal(r.directions.length, 6);
  for (const d of r.directions) { assert.ok(d.idea.why); assert.ok(d.idea.doThis.length); }
  assert.equal(r.headline.dir, 'weird');
  assert.match(r.bridge.means, /scrutiny/i);
  const safe = suggest(moment('Everybody watching me'), { weirdness: 0, seed: 1 });
  assert.notEqual(safe.headline.dir, 'weird');
});

test('weirdness slider moves the weird pick from strange to unhinged', () => {
  const lv = (w) => suggest(moment('My heart went cold'), { weirdness: w, seed: 3 }).directions.find((d) => d.id === 'weird').idea.level;
  assert.equal(lv(1), 1);
  assert.equal(lv(2), 2);
});

test('spin modifiers steer the ideas', () => {
  const m = moment('I carry the whole team');
  const cheap = suggest(m, { modifiers: ['cheap', 'solo'], seed: 2 });
  assert.equal(cheap.directions[0].id, 'practical');
  assert.ok(cheap.directions[0].idea.tags.includes('cheap'));
  const ai = suggest(m, { modifiers: ['ai'], seed: 2 });
  assert.equal(ai.directions[0].id, 'hybrid');
  const lux = suggest(moment('Money on my mind'), { modifiers: ['luxury'], seed: 5 });
  assert.ok(lux.directions.some((d) => d.idea.tags.includes('luxury')));
});

test('spin again gives fresh ideas; the same seed is stable', () => {
  const m = moment('They switched sides');
  const a = suggest(m, { seed: 1 });
  const shown = a.directions.map((d) => d.idea.id);
  const b = suggest(m, { seed: 2, exclude: shown });
  for (const d of b.directions) assert.ok(!shown.includes(d.idea.id), d.idea.id);
  assert.deepEqual(suggest(m, { seed: 1 }).directions.map((d) => d.idea.id), shown);
});

test('motif world pulls ideas into the same visual world', () => {
  const m = moment('I saw you in the window of a moving car');
  const glassy = suggest(m, { world: ['water', 'glass'], seed: 4, weirdness: 1 });
  const hits = glassy.directions.filter((d) => d.idea.motifs.some((x) => ['water', 'glass'].includes(x))).length;
  assert.ok(hits >= 3, `${hits} ideas in the world`);
});

test('more like this stays close to the chosen idea', () => {
  const idea = getIdea('cold.3');
  const more = moreLike(idea, { exclude: [idea.id] });
  assert.equal(more.length, 3);
  assert.ok(more.every((o) => o.source === 'cold' || o.dir === 'weird' || o.motifs.some((x) => idea.motifs.includes(x))));
});

test('sonic events: bass hits, drop-outs and beat switches', () => {
  const peaks = Array.from({ length: 600 }, (_, i) => {
    const t = i / 10;
    if (t >= 20 && t < 20.6) return 3; // drop-out
    if (t >= 40) return 85; // beat switch up
    return i % 50 === 0 ? 95 : 35; // hits
  });
  const ev = detectSonicEvents(peaks, 60);
  assert.ok(ev.some((e) => e.kind === 'bass'), 'bass');
  assert.ok(ev.some((e) => e.kind === 'pause' && Math.abs(e.t - 20) < 0.3), 'pause');
  assert.ok(ev.some((e) => e.kind === 'switch' && Math.abs(e.t - 40) < 3.5), 'switch');
  const s = suggest({ id: 'b', kind: 'bass', t: 5, end: 7, lyric: '' });
  assert.equal(s.directions.length, 6);
  assert.match(s.bridge.means, /impact/i);
});

test('moments: lyrics, repeated lines are hero moments, ad-libs get their own', () => {
  const p = createProject({
    lyrics: ['Everybody watching me (yeah)', 'They switched sides', 'Everybody watching me (yeah)'],
    lyricTimes: [2, 6, 10],
  });
  const ms = buildMoments(p);
  const lyr = ms.filter((m) => m.kind === 'lyric');
  assert.equal(lyr.length, 3);
  assert.ok(lyr[0].hero && lyr[2].hero && !lyr[1].hero);
  assert.ok(ms.some((m) => m.kind === 'adlib' && m.lyric === 'yeah'));
  assert.equal(splitAdlibs('Everybody watching me (yeah)').main, 'Everybody watching me');
  assert.equal(markerFor(lyr[0], null).icon, '⚡');
  assert.equal(markerFor(lyr[1], { dir: 'weird' }).icon, '✦');
  const demo = buildMoments(demoProject());
  assert.ok(demo.length >= 5, 'demo slots with lyrics become moments');
  assert.ok(strongest(demo).length <= demo.length);
});

test('USE THIS becomes a full production shot in the right slot, and is undoable', () => {
  const p = demoProject();
  const m = buildMoments(p).find((x) => /amber/i.test(x.lyric));
  const idea = suggest(m, { seed: 1 }).headline;
  const shot = ideaToShot(idea, m, p);
  for (const k of ['title', 'description', 'lyric', 'location', 'durationSec']) assert.ok(shot[k] !== undefined, k);
  for (const k of ['why', 'size', 'position', 'move', 'light', 'howTo', 'cut']) assert.ok(shot.echo[k], `echo.${k}`);
  assert.ok(shot.camera.lens && shot.camera.fps);
  const before = p.shots[2].title;
  p.shots[2].takes.push({ assetId: 'tk' });
  const idx = applyIdea(p, m, idea, createShot);
  assert.equal(idx, 2, 'slot covering the moment');
  assert.equal(p.shots[2].echo.ideaId, idea.id);
  assert.equal(p.shots[2].takes.length, 1, 'takes kept');
  assert.ok(p.direction.motifs.length >= 3);
  restorePreviousIdea(p, p.shots[2].id);
  assert.equal(p.shots[2].title, before);
  assert.equal(p.shots[2].echo, null);
  const empty = createProject();
  assert.equal(applyIdea(empty, { ...m, videoT: 0 }, idea, createShot), 0);
  assert.equal(empty.shots[0].echo.ideaId, idea.id);
});
