// Portable single-file project backup (.reashoota.json): the project plus every asset it
// references, base64-embedded. Used for "Download backup", sharing a project to another
// device, and as the payload for cloud sync.

import { createProject, duplicateProject, referencedAssetIds, slugify } from './project.js';

export const BUNDLE_FORMAT = 'reashoota-project';
export const BUNDLE_VERSION = 1;

export function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

// getAsset(id) -> { id, mime, name, kind, bytes: Uint8Array } | null
export async function buildBundle(project, getAsset, { includeMedia = true } = {}) {
  const assets = [];
  if (includeMedia) {
    for (const id of referencedAssetIds(project)) {
      const a = await getAsset(id);
      if (!a) continue;
      assets.push({ id: a.id, mime: a.mime, name: a.name, kind: a.kind, data: bytesToBase64(a.bytes) });
    }
  }
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    app: 'ReaShoota',
    project,
    assets,
  };
}

export function bundleFileName(project) {
  return `${slugify(project.name)}.reashoota.json`;
}

// Parses a bundle. Returns { project, assets:[{id,mime,name,kind,bytes}] }.
// With asCopy the project gets a fresh id so it never overwrites an existing one.
export function parseBundle(input, { asCopy = false } = {}) {
  const data = typeof input === 'string' ? JSON.parse(input) : input;
  if (!data || data.format !== BUNDLE_FORMAT || !data.project) {
    throw new Error('This file is not a ReaShoota project backup.');
  }
  if (data.version > BUNDLE_VERSION) {
    throw new Error('This backup was made by a newer version of ReaShoota.');
  }
  let project = createProject(data.project);
  if (asCopy) project = duplicateProject(project, { name: project.name });
  const assets = (data.assets || []).map((a) => ({
    id: a.id, mime: a.mime, name: a.name, kind: a.kind, bytes: base64ToBytes(a.data),
  }));
  return { project, assets };
}
