import test from 'node:test';
import assert from 'node:assert/strict';

import {
  demoProject, duplicateProject, regenerateShot, regenerateRemaining, restorePreviousIdea,
  setShotDone, progress, lyricMap, createProject, slugify,
} from '../src/project.js';
import { exportText, SECTION_KINDS, buildBlocks } from '../src/sections.js';
import { PdfDocument, encodeWinAnsi, wrapText, textWidth, jpegSize } from '../src/pdf.js';
import { renderPdf } from '../src/pdf-packs.js';
import { buildBundle, parseBundle, bytesToBase64, base64ToBytes } from '../src/backup.js';

// Smallest byte sequence jpegSize/addJpeg accept: SOI + SOF0 (16×32, 3 components).
const FAKE_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x10, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);

function checkPdf(bytes) {
  const s = Buffer.from(bytes).toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4'));
  assert.ok(s.trimEnd().endsWith('%%EOF'));
  const startxref = Number(/startxref\n(\d+)/.exec(s)[1]);
  assert.equal(s.slice(startxref, startxref + 4), 'xref');
  const [, , count] = /xref\n(\d+) (\d+)/.exec(s.slice(startxref)).map(Number);
  const entries = s.slice(startxref).split('\n').slice(3, 3 + count - 1);
  entries.forEach((e, i) => {
    const off = Number(e.slice(0, 10));
    assert.equal(s.slice(off, off + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`, `xref entry ${i + 1}`);
  });
  return s;
}

test('regenerating a shot keeps completion, notes and frame, and is undoable', () => {
  const p = demoProject();
  const shot = p.shots[0];
  shot.notes = 'Take 3 was the one';
  shot.frameAssetId = 'asset_x';
  assert.equal(shot.status, 'done');
  const before = shot.description;
  regenerateShot(p, shot.id);
  assert.equal(shot.status, 'done');
  assert.equal(shot.notes, 'Take 3 was the one');
  assert.equal(shot.frameAssetId, 'asset_x');
  assert.notEqual(shot.description, before);
  assert.equal(shot.history.length, 1);
  restorePreviousIdea(p, shot.id);
  assert.equal(shot.description, before);
});

test('regenerateRemaining skips completed shots', () => {
  const p = demoProject();
  const doneDescriptions = p.shots.filter((s) => s.status === 'done').map((s) => s.description);
  const changed = regenerateRemaining(p);
  assert.equal(changed.length, p.shots.length - doneDescriptions.length);
  assert.deepEqual(p.shots.filter((s) => s.status === 'done').map((s) => s.description), doneDescriptions);
});

test('duplicate gets a new identity and can reset progress', () => {
  const p = demoProject();
  const c = duplicateProject(p, { resetProgress: true });
  assert.notEqual(c.id, p.id);
  assert.match(c.name, /\(copy\)$/);
  assert.equal(progress(c).done, 0);
  assert.ok(progress(p).done > 0, 'original untouched');
  c.shots[0].title = 'changed';
  assert.notEqual(p.shots[0].title, 'changed');
});

test('setShotDone and lyric mapping', () => {
  const p = demoProject();
  setShotDone(p, p.shots[2].id, true);
  assert.ok(p.shots[2].completedAt);
  const map = lyricMap(p);
  assert.equal(map.at(-1).shots.length, 2);
});

test('every text export renders for txt and md', () => {
  const p = demoProject();
  for (const kind of SECTION_KINDS) {
    for (const fmt of ['txt', 'md']) {
      const out = exportText(kind, p, fmt);
      assert.ok(out.length > 20, `${kind}.${fmt}`);
      assert.ok(!out.includes('undefined'), `${kind}.${fmt} has undefined`);
    }
  }
  const list = exportText('shotlist', p, 'txt');
  assert.match(list, /S01 · Taxi window reflection {2}\[DONE\]/);
  assert.match(exportText('checklist', p, 'md'), /- \[x\] iPhone charged/);
});

test('empty project exports without crashing', () => {
  const p = createProject({ name: 'Blank' });
  for (const kind of SECTION_KINDS) {
    assert.ok(buildBlocks(kind, p).length > 0);
    checkPdf(renderPdf(kind, p));
  }
  checkPdf(renderPdf('storyboard', p));
  checkPdf(renderPdf('deck', p));
});

test('pdf writer produces a structurally valid file with images', () => {
  const doc = new PdfDocument({ title: 'T (1)' });
  doc.addPage();
  doc.text('Hello “world” — café ✓ 🎬', 40, 60, { size: 14, bold: true });
  const img = doc.addJpeg(FAKE_JPEG);
  doc.imageCover(img, 40, 80, 100, 100);
  doc.addPage();
  doc.rect(10, 10, 50, 50, { fill: '#ff0000', stroke: '#000' });
  const s = checkPdf(doc.save());
  assert.match(s, /\/Count 2/);
  assert.match(s, /\/Width 16 \/Height 32/);
  assert.match(s, /\(Hello \\223world\\224 \\227 caf\\351 \[x\] \) Tj/);
});

test('winansi encoding, width and wrapping', () => {
  assert.deepEqual(encodeWinAnsi('A’'), [65, 0x92]);
  assert.deepEqual(encodeWinAnsi('😀'), []);
  assert.equal(textWidth('ii', 10), 4.44);
  const lines = wrapText('one two three four five six seven', 60, 10);
  assert.ok(lines.length > 1);
  lines.forEach((l) => assert.ok(textWidth(l, 10) <= 60));
  assert.ok(wrapText('Supercalifragilisticexpialidocious', 30, 10).length > 2);
  assert.deepEqual(jpegSize(FAKE_JPEG), { width: 16, height: 32, components: 3 });
});

test('all pdf packs render for the demo project with frames', () => {
  const p = demoProject();
  p.shots[0].frameAssetId = 'f1';
  const frames = new Map([['f1', FAKE_JPEG]]);
  for (const kind of ['full', 'shoot', 'shotlist', 'storyboard', 'deck', 'direction', 'rhymes', 'lyrics', 'camera', 'locations', 'checklist', 'summary']) {
    const s = checkPdf(renderPdf(kind, p, { frames }));
    assert.ok(s.includes('/Type /Page'), kind);
  }
});

test('backup bundle round-trips project and media', async () => {
  const p = demoProject();
  p.assets.push({ id: 'a1', kind: 'concept', name: 'moon.jpg', mime: 'image/jpeg' });
  p.shots[1].frameAssetId = 'a1';
  const bytes = new Uint8Array(70000).map((_, i) => i % 256);
  const bundle = await buildBundle(p, async (id) => (id === 'a1' ? { id, mime: 'image/jpeg', name: 'moon.jpg', kind: 'concept', bytes } : null));
  const json = JSON.stringify(bundle);
  const same = parseBundle(json);
  assert.equal(same.project.id, p.id);
  assert.deepEqual(same.project.shots, p.shots);
  assert.deepEqual(same.assets[0].bytes, bytes);
  const copy = parseBundle(json, { asCopy: true });
  assert.notEqual(copy.project.id, p.id);
  assert.throws(() => parseBundle('{"format":"nope"}'), /not a ReaShoota/);
  assert.deepEqual(base64ToBytes(bytesToBase64(new Uint8Array([0, 255, 7]))), new Uint8Array([0, 255, 7]));
});

test('slugify', () => {
  assert.equal(slugify('Golden Hour Ghost!'), 'golden-hour-ghost');
  assert.equal(slugify(''), 'reashoota');
});
