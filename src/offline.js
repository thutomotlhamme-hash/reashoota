// Offline / on-location support: service worker registration, "Make available offline",
// and session restore after a refresh or accidental close.

import { getAsset, putAsset, getKV, setKV } from './store.js';
import { referencedAssetIds } from './project.js';
import { toJpeg } from './images.js';

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('./sw.js', { scope: './' });
  } catch (err) {
    console.warn('Service worker registration failed', err);
    return null;
  }
}

// Ask the service worker to (re)cache the full app shell and wait for it to confirm.
async function cacheAppShell() {
  if (!('serviceWorker' in navigator)) return false;
  const reg = await navigator.serviceWorker.ready;
  const sw = reg.active;
  if (!sw) return false;
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve(false), 15000);
    ch.port1.onmessage = (e) => { clearTimeout(timer); resolve(!!e.data?.ok); };
    sw.postMessage({ type: 'CACHE_SHELL' }, [ch.port2]);
  });
}

export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && await navigator.storage.persisted()) return true;
    return (await navigator.storage?.persist?.()) || false;
  } catch {
    return false;
  }
}

// Make sure every frame/image has a small thumbnail stored next to it so boards render fast
// and cheaply with no connection.
export async function ensureThumbnails(project, onProgress) {
  const ids = [...referencedAssetIds(project)];
  let bytes = 0;
  for (let i = 0; i < ids.length; i += 1) {
    const a = await getAsset(ids[i]);
    if (!a) continue;
    if (!a.thumb && a.mime?.startsWith('image/')) {
      try {
        a.thumb = (await toJpeg(a.blob, 480, 0.75)).blob;
        await putAsset(a);
      } catch { /* unsupported format — keep original only */ }
    }
    bytes += (a.blob?.size || 0) + (a.thumb?.size || 0);
    onProgress?.((i + 1) / ids.length);
  }
  return bytes;
}

export async function makeAvailableOffline(project, onProgress) {
  const [persisted, shellCached, bytes] = await Promise.all([
    requestPersistence(),
    cacheAppShell(),
    ensureThumbnails(project, onProgress),
  ]);
  project.offline = { at: new Date().toISOString(), bytes, persisted, shellCached };
  return project.offline;
}

export async function storageEstimate() {
  try { return await navigator.storage.estimate(); } catch { return null; }
}

// Session: which project/tab was open, scroll position, running countdown, etc.
const SESSION_KEY = 'session';
export const loadSession = () => getKV(SESSION_KEY, {});
export const saveSession = (s) => setKV(SESSION_KEY, s).catch(() => {});
