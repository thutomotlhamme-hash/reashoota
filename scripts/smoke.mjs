// End-to-end smoke test in Chromium with iPhone emulation.
// Usage: node scripts/smoke.mjs [outDir]   (needs Playwright + Chromium)
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium, devices } from 'playwright';

const root = new URL('..', import.meta.url).pathname;
const out = process.argv[2] || join(root, 'test-results');
await mkdir(out, { recursive: true });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
  try {
    const body = await readFile(join(root, path));
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
}).listen(0);
const base = `http://localhost:${server.address().port}/`;

const browser = await chromium.launch();
const context = await browser.newContext({ ...devices['iPhone 13'], acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const step = (name) => console.log(`• ${name}`);
const shot = (name) => page.screenshot({ path: join(out, `${name}.png`), fullPage: false });
const check = (cond, msg) => { if (!cond) throw new Error(`FAILED: ${msg}`); };

async function exportAndDownload(trigger, expectExt) {
  await trigger();
  await page.waitForSelector('[data-action="ready-download"]', { timeout: 60000 });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="ready-download"]')]);
  const name = dl.suggestedFilename();
  check([].concat(expectExt).some((e) => name.endsWith(e)), `${name} should end with ${expectExt}`);
  const path = join(out, name);
  await dl.saveAs(path);
  await page.click('[data-action="close-sheet"]');
  return path;
}

try {
  step('load + demo');
  await page.goto(base);
  await page.click('[data-action="demo"]');
  await page.waitForSelector('.shot');
  await shot('01-shoot');

  step('add a reference frame from a generated image');
  const png = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 900; c.height = 1600;
    const x = c.getContext('2d'); const g = x.createLinearGradient(0, 0, 900, 1600);
    g.addColorStop(0, '#ff7a3d'); g.addColorStop(1, '#1b1a2e'); x.fillStyle = g; x.fillRect(0, 0, 900, 1600);
    x.fillStyle = '#fff'; x.font = 'bold 120px sans-serif'; x.fillText('FRAME', 180, 820);
    return c.toDataURL('image/png');
  });
  await writeFile(join(out, 'frame.png'), Buffer.from(png.split(',')[1], 'base64'));
  await page.click('[data-tab="board"]');
  await page.click('.panel-img >> nth=0');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-action="frame-add"] >> nth=0')]);
  await chooser.setFiles(join(out, 'frame.png'));
  await page.waitForSelector('.panel-img img');
  await page.waitForTimeout(300);
  await shot('02-board');

  step('exports');
  await page.click('[data-tab="export"]');
  await shot('03-export');
  const pdf = await exportAndDownload(() => page.click('.hero.primary'), '.pdf');
  check((await readFile(pdf)).subarray(0, 8).toString() === '%PDF-1.4', 'shoot pack is a PDF');
  await exportAndDownload(() => page.click('[data-export="storyboard"][data-format="pdf"].hero'), '.pdf');
  await exportAndDownload(() => page.click('[data-export="deck"][data-format="pdf"]'), '.pdf');
  await exportAndDownload(() => page.click('[data-export="storyboard"][data-format="sheet"]'), '.jpg');
  await exportAndDownload(() => page.click('[data-export="moodboard"][data-format="png"]'), '.png');
  await exportAndDownload(() => page.click('[data-export="full"][data-format="md"]'), '.md');
  await exportAndDownload(() => page.click('[data-export="backup"][data-format="json"]'), '.reashoota.json');
  await page.click('[data-export="cards"][data-format="png"]');
  await page.waitForSelector('[data-action="ready-download"]');
  await shot('04-ready-sheet');
  await page.click('[data-action="close-sheet"]');

  step('copy shot list');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.click('.hero[data-kind="shotlist"]');
  await page.waitForTimeout(200);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check(clip.includes('S01 · Taxi window reflection'), 'clipboard has shot list');

  step('animatic video');
  await exportAndDownload(() => page.click('[data-action="save-video"]'), ['.mp4', '.webm']);

  step('make available offline');
  await page.click('[data-action="make-offline"]');
  await page.waitForSelector('.hero.ok');

  step('complete a shot + notes, then refresh restores state');
  await page.click('[data-tab="shoot"]');
  await page.click('.shot >> nth=2 >> .check');
  await page.fill('.shot >> nth=2 >> textarea', 'Take 4 golden');
  await page.click('[data-details="settings"] summary');
  await page.selectOption('[data-setting="countdownSec"]', '5');
  await page.waitForTimeout(500);
  await page.reload();
  await page.waitForSelector('.shot');
  check(await page.isChecked('.shot >> nth=2 >> input[type=checkbox]'), 'shot 3 stays done');
  check((await page.inputValue('.shot >> nth=2 >> textarea')) === 'Take 4 golden', 'notes restored');
  check((await page.inputValue('[data-setting="countdownSec"]')) === '5', 'countdown setting restored');

  step('offline reload');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector('.shot');
  check(await page.isVisible('text=Offline — everything still works'), 'offline pill');
  await shot('05-offline');
  const offPdf = await exportAndDownload(() => page.click('[data-action="bar-save"]'), '.pdf');
  check((await readFile(offPdf)).length > 1000, 'pdf exported offline');
  await context.setOffline(false);

  step('duplicate + home');
  await page.click('[data-tab="export"]');
  await page.click('[data-action="duplicate"]');
  await page.waitForSelector('text=Golden Hour Ghost (copy)');
  await page.click('[data-action="home"]');
  await page.waitForSelector('.project-card >> nth=1');
  await shot('06-home');

  check(!errors.length, `console errors:\n${errors.join('\n')}`);
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
