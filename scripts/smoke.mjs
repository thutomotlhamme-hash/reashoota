// End-to-end smoke test in Chromium with iPhone emulation and a fake camera.
// Usage: node scripts/smoke.mjs [outDir]   (needs Playwright + Chromium)
//        SMOKE_ROOT=dist node scripts/smoke.mjs   tests the build instead of the source.
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium, devices } from 'playwright';

const root = join(new URL('..', import.meta.url).pathname, process.env.SMOKE_ROOT || '');
const out = process.argv[2] || join(root, 'test-results');
await mkdir(out, { recursive: true });

const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.woff2': 'font/woff2',
};
const server = http.createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
  try {
    const body = await readFile(join(root, path));
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
}).listen(0);
const base = `http://localhost:${server.address().port}/`;

// 40s 120 BPM click track as a WAV file.
function clickTrack(bpm = 120, seconds = 40, rate = 22050) {
  const n = seconds * rate;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  const beat = (60 / bpm) * rate;
  for (let i = 0; i < n; i += 1) {
    const inBeat = i % beat;
    const loud = i > n * 0.5 && i < n * 0.8 ? 1 : 0.45; // a "chorus"
    const v = inBeat < rate * 0.03 ? Math.sin(i * 0.3) * (1 - inBeat / (rate * 0.03)) * loud : Math.sin(i * 0.05) * 0.03;
    buf.writeInt16LE(Math.round(v * 30000), 44 + i * 2);
  }
  return buf;
}

const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ ...devices['iPhone 13'], acceptDownloads: true, permissions: ['camera', 'microphone'] });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('dialog', (d) => d.accept());

const step = (name) => console.log(`• ${name}`);
const shot = (name) => page.screenshot({ path: join(out, `${name}.png`) });
const check = (cond, msg) => { if (!cond) throw new Error(`FAILED: ${msg}`); };

async function choose(trigger, files) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), trigger()]);
  await chooser.setFiles(files);
}

async function exportAndDownload(trigger, exts, timeout = 90000) {
  await trigger();
  await page.waitForSelector('[data-action="ready-download"]', { timeout });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="ready-download"]')]);
  const name = dl.suggestedFilename();
  check([].concat(exts).some((e) => name.endsWith(e)), `${name} should end with ${exts}`);
  const path = join(out, name);
  await dl.saveAs(path);
  await page.click('[data-action="close-sheet"]');
  return path;
}

try {
  step('home + demo opens the timeline');
  await page.goto(base);
  await page.waitForSelector('.cta');
  await shot('01-home-empty');
  await page.click('[data-action="demo"]');
  await page.waitForSelector('.slot');
  await page.waitForTimeout(400);
  await shot('02-timeline');

  step('make test clips (recorded in the page)');
  const clip = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 360; c.height = 640;
    const x = c.getContext('2d');
    const rec = new MediaRecorder(c.captureStream(30), { mimeType: 'video/webm' });
    const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
    const done = new Promise((r) => { rec.onstop = r; });
    rec.start();
    const t0 = performance.now();
    await new Promise((r) => {
      const f = () => {
        const t = (performance.now() - t0) / 1000;
        x.fillStyle = `hsl(${(t * 90) % 360} 70% 55%)`; x.fillRect(0, 0, 360, 640);
        x.fillStyle = '#fff'; x.font = 'bold 60px sans-serif'; x.fillText(t.toFixed(1), 110, 330);
        if (t > 2.2) r(); else requestAnimationFrame(f);
      };
      f();
    });
    rec.stop(); await done;
    const b = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let s = ''; for (const v of b) s += String.fromCharCode(v);
    return btoa(s);
  });
  const clipPaths = [];
  for (let i = 0; i < 3; i += 1) {
    const p = join(out, `clip${i}.webm`);
    await writeFile(p, Buffer.from(clip, 'base64'));
    clipPaths.push(p);
  }
  await writeFile(join(out, 'song.wav'), clickTrack());

  step('add song → BPM + beat slots');
  await page.click('.tool >> text=Add song');
  await choose(() => page.click('[data-action="add-song"]'), join(out, 'song.wav'));
  await page.waitForSelector('.song-wave');
  const meta = await page.textContent('.song-card');
  check(/1[12]\d BPM|120 BPM/.test(meta), `BPM found: ${meta}`);
  await shot('03-song');
  await page.click('[data-action="beat-slots"]');
  await page.waitForSelector('.slot');
  check(await page.isVisible('.wave i'), 'waveform under slots');

  step('templates + auto-fill from Photos');
  await page.click('.tool >> text=Templates');
  await page.click('[data-action="pick-tpl"][data-id="hook15"]');
  await shot('04-templates');
  await page.click('[data-action="use-tpl"]');
  await page.waitForSelector('.slot');
  check((await page.$$('.slot')).length === 9, 'hook template has 9 slots');
  await page.click('.tool >> text=Templates');
  await choose(() => page.click('[data-action="auto-fill"]'), clipPaths);
  await page.waitForSelector('.slot.filled >> nth=2', { timeout: 30000 });
  check((await page.$$('.slot.filled')).length === 3, '3 slots filled');

  step('shoot into a slot with the camera');
  await page.click('.slot >> nth=3');
  await page.click('[data-action="open-camera"]');
  await page.waitForSelector('.cam-feed');
  await page.waitForTimeout(800);
  await shot('05-camera');
  await page.click('#rec-btn');
  await page.waitForFunction(() => document.querySelectorAll('.cam-progress i.done').length >= 4, null, { timeout: 30000 });
  await page.click('[data-action="cam-close"]');
  await page.waitForSelector('.slot.filled >> nth=3');

  step('captions: style + font');
  await page.click('.tool >> text=Captions');
  await page.click('[data-action="cap-style"][data-v="karaoke"]');
  await page.click('[data-action="cap-font"][data-v="Permanent Marker"]');
  await page.waitForTimeout(500);
  await shot('06-captions');
  await page.click('.topbar >> text=Done');
  await page.waitForSelector('.slot');
  await shot('07-timeline-filled');

  step('make the final video');
  await page.click('[data-action="open-save"]');
  await page.waitForSelector('[data-action="make-video"]');
  await shot('08-save-sheet');
  const video = await exportAndDownload(() => page.click('[data-action="make-video"]'), ['.mp4', '.webm'], 120000);
  const size = (await readFile(video)).length;
  check(size > 50000, `final video has content (${size} bytes)`);
  console.log(`  final video: ${video} (${Math.round(size / 1024)} KB)`);

  step('plan → shoot pack PDF still works');
  await page.click('[data-action="go"][data-view="plan"]');
  await page.waitForSelector('.tabs');
  const pdf = await exportAndDownload(() => page.click('[data-action="bar-save"]'), '.pdf');
  check((await readFile(pdf)).subarray(0, 8).toString() === '%PDF-1.4', 'shoot pack is a PDF');

  step('reload restores view + state; offline reload works');
  await page.click('[data-action="go"][data-view="timeline"]');
  await page.click('.slot >> nth=1');
  await page.waitForTimeout(500);
  await page.reload();
  await page.waitForSelector('.slot.on');
  check((await page.getAttribute('.slot.on', 'data-i')) === '1', 'selected slot restored');
  check((await page.$$('.slot.filled')).length === 4, 'takes restored');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector('.slot.filled');
  await context.setOffline(false);

  step('home');
  await page.click('[data-action="home"]');
  await page.waitForSelector('.pcard');
  await shot('09-home');

  const real = errors.filter((e) => !/Failed to load resource/.test(e));
  check(!real.length, `console errors:\n${real.join('\n')}`);
  console.log('SMOKE OK');
} catch (err) {
  console.error(err.message);
  if (errors.length) console.error('console errors:', errors);
  await shot('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
