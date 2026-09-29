import test from 'node:test';
import assert from 'node:assert/strict';

import { createProject, demoProject, referencedAssetIds, duplicateProject } from '../src/project.js';
import {
  TEMPLATES, applyTemplate, autoFillTargets, buildBeatSlots, captionAt, detectBpm, loudestWindow,
  slotAt, slotTimes, snapToBeat, totalDuration, formatTime,
} from '../src/timeline.js';

test('slot times are cumulative and slotAt finds the right slot', () => {
  const p = demoProject();
  const slots = slotTimes(p);
  assert.equal(slots[0].start, 0);
  assert.equal(slots[1].start, p.shots[0].durationSec);
  assert.equal(slots.at(-1).end, totalDuration(p));
  assert.equal(slotAt(p, 4.5).index, 1);
});

test('templates create timed slots, snapped to the beat when a song is known', () => {
  const p = createProject({ lyrics: ['one', 'two'] });
  applyTemplate(p, 'beat30');
  assert.equal(p.shots.length, 10);
  assert.equal(totalDuration(p), 30);
  assert.equal(p.shots[0].lyric, 'one');
  p.track = { bpm: 100, duration: 60, range: { start: 0, end: 60 } };
  applyTemplate(p, 'verse-chorus');
  for (const s of p.shots) assert.ok(Math.abs(s.durationSec / 1.2 - Math.round(s.durationSec / 1.2)) < 0.01, `${s.durationSec} on half-bars`);
  for (const t of TEMPLATES) assert.ok(applyTemplate(createProject(), t.id).length);
});

test('snapToBeat and buildBeatSlots fill the chosen song range', () => {
  assert.equal(snapToBeat(3, 120), 3);
  assert.equal(snapToBeat(0.2, 120), 1);
  const p = demoProject();
  p.shots[0].takes.push({ assetId: 'take1', dur: 4 });
  p.track = { bpm: 96, duration: 192, range: { start: 42, end: 75 } };
  buildBeatSlots(p);
  assert.ok(Math.abs(totalDuration(p) - 33) < 0.05, `total ${totalDuration(p)}`);
  assert.equal(p.shots[0].takes[0].assetId, 'take1', 'takes kept');
  const empty = createProject({ track: { bpm: 120, duration: 30, range: { start: 0, end: 16 } } });
  buildBeatSlots(empty);
  assert.equal(empty.shots.length, 4, '16s at 120bpm = four 2-bar shots');
  assert.throws(() => buildBeatSlots(createProject()), /Add a song/);
});

test('auto-fill targets empty slots first, then appends', () => {
  const p = demoProject();
  p.shots[0].takes.push({ assetId: 'x' });
  const t = autoFillTargets(p, 9);
  assert.equal(t[0], 1);
  assert.equal(t.length, 9);
  assert.equal(p.shots.length, 10, '7 empty slots + 2 appended');
});

test('captions follow synced lyric times, word by word', () => {
  const p = createProject({ lyrics: ['every light turns amber', 'second line'], lyricTimes: [10, 14] });
  p.track = { duration: 60, range: { start: 8, end: 40 } };
  assert.equal(captionAt(p, 1), null);
  const c = captionAt(p, 2.1);
  assert.equal(c.text, 'every light turns amber');
  assert.equal(c.active, 0);
  assert.equal(captionAt(p, 5.5).active, 3);
  assert.equal(captionAt(p, 6.2).text, 'second line');
  assert.equal(captionAt(p, 30), null);
});

test('captions fall back to each slot lyric when not synced', () => {
  const p = demoProject();
  const c = captionAt(p, 0.2);
  assert.equal(c.text, p.shots[0].lyric);
  assert.equal(captionAt(p, 18.5), null, 'S05 (18s–20s) has no lyric');
});

test('bpm detection on a synthetic click track', () => {
  const rate = 100;
  for (const bpm of [90, 120, 140]) {
    const env = new Array(rate * 20).fill(0);
    for (let t = 0; t < 20; t += 60 / bpm) env[Math.round(t * rate)] = 1;
    const got = detectBpm(env, rate);
    assert.ok(Math.abs(got - bpm) <= 1, `${bpm} -> ${got}`);
  }
});

test('loudest window, formatTime, and new asset references', () => {
  const peaks = Array.from({ length: 100 }, (_, i) => (i >= 60 && i < 80 ? 90 : 10));
  assert.equal(loudestWindow(peaks, 100, 20), 60);
  assert.equal(formatTime(69.25), '01:09.3');
  const p = demoProject();
  p.shots[0].takes.push({ assetId: 'tk', thumbId: 'th' });
  p.track = { assetId: 'song', duration: 10 };
  const ids = referencedAssetIds(createProject(p));
  for (const id of ['tk', 'th', 'song']) assert.ok(ids.has(id));
  assert.equal(duplicateProject(p).track.assetId, 'song');
});
