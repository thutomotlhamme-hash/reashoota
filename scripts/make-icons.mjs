// Renders icons/icon.svg to the PNG sizes iOS and Android need.
// Usage: npm run icons   (needs Playwright + Chromium available)
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const svg = await readFile(new URL('../icons/icon.svg', import.meta.url), 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
// iOS draws its own rounded mask, so the touch icon is rendered square (no transparent corners).
const targets = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['apple-touch-icon.png', 180, true],
];
for (const [name, size, square] of targets) {
  const body = square ? svg.replace('rx="112"', 'rx="0"') : svg;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${body}`);
  await page.screenshot({ path: new URL(`../icons/${name}`, import.meta.url).pathname, omitBackground: true });
}
await browser.close();
console.log('icons written');
