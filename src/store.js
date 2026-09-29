// On-device persistence in IndexedDB. Every edit lands here first, so projects open and read
// with no connection, and survive refreshes and accidental closes.

import { normalizeProject, referencedAssetIds } from './project.js';

const DB_NAME = 'reashoota';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Close other ReaShoota tabs to finish updating.'));
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage transaction aborted'));
  });
}

const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

export async function listProjects() {
  const all = await tx('projects', 'readonly', (s) => req(s.getAll()));
  return all.map(normalizeProject).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getProject(id) {
  const p = await tx('projects', 'readonly', (s) => req(s.get(id)));
  return p ? normalizeProject(p) : null;
}

export function putProject(project) {
  // Structured clone keeps the stored copy independent of the live, mutable object.
  return tx('projects', 'readwrite', (s) => { s.put(JSON.parse(JSON.stringify(project))); });
}

export async function deleteProject(id) {
  await tx('projects', 'readwrite', (s) => { s.delete(id); });
  await collectGarbage();
}

// Asset record: { id, kind, name, mime, blob, thumb?: Blob, width, height, createdAt }
export function putAsset(asset) {
  return tx('assets', 'readwrite', (s) => { s.put(asset); });
}

export function getAsset(id) {
  return tx('assets', 'readonly', (s) => req(s.get(id)));
}

// Assets are shared between duplicated projects, so only delete ones nothing references.
export async function collectGarbage() {
  const projects = await listProjects();
  const live = new Set();
  for (const p of projects) for (const id of referencedAssetIds(p)) live.add(id);
  const keys = await tx('assets', 'readonly', (s) => req(s.getAllKeys()));
  const dead = keys.filter((k) => !live.has(k));
  if (dead.length) await tx('assets', 'readwrite', (s) => { dead.forEach((k) => s.delete(k)); });
  return dead.length;
}

export async function getKV(key, fallback = null) {
  try {
    const v = await tx('kv', 'readonly', (s) => req(s.get(key)));
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

export function setKV(key, value) {
  return tx('kv', 'readwrite', (s) => { s.put(value, key); });
}
