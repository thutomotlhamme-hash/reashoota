// Produces a deployable dist/ folder. There is no compile step: files are copied as-is,
// and the service worker's cache VERSION is stamped with a hash of the app shell, so
// every deploy that changes a file makes installed phones pick up the new version.
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const dist = join(root, 'dist');
const ENTRIES = ['index.html', 'styles.css', 'manifest.webmanifest', 'sw.js', 'icons', 'src'];

async function files(dir) {
  const out = [];
  for (const e of await readdir(join(root, dir), { withFileTypes: true })) {
    const rel = join(dir, e.name);
    if (e.isDirectory()) out.push(...await files(rel)); else out.push(rel);
  }
  return out;
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const all = [];
for (const entry of ENTRIES) {
  await cp(join(root, entry), join(dist, entry), { recursive: true });
  all.push(...(entry.includes('.') ? [entry] : await files(entry)));
}

// Every file the service worker precaches must exist, or install fails on the phone.
const sw = await readFile(join(root, 'sw.js'), 'utf8');
const shell = [...sw.matchAll(/'\.\/([^']+)'/g)].map((m) => m[1]).filter((p) => p !== 'sw.js');
const missing = shell.filter((p) => !all.includes(p));
if (missing.length) throw new Error(`sw.js precaches missing files: ${missing.join(', ')}`);
const uncached = all.filter((p) => p.startsWith('src/') && !shell.includes(p));
if (uncached.length) throw new Error(`src files not precached by sw.js (app would break offline): ${uncached.join(', ')}`);

const hash = createHash('sha256');
for (const f of all.filter((p) => p !== 'sw.js').sort()) hash.update(f).update(await readFile(join(root, f)));
const version = `reashoota-${hash.digest('hex').slice(0, 10)}`;
const stamped = sw.replace(/const VERSION = '[^']*';/, `const VERSION = '${version}';`);
if (stamped === sw && !sw.includes(version)) throw new Error('Could not stamp VERSION in sw.js');
await writeFile(join(dist, 'sw.js'), stamped);

console.log(`Built dist/ — ${all.length} files, cache ${version}`);
