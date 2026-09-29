// Export catalogue and producers. Each export turns the current project into one or more
// File objects (plus copyable text where it makes sense), ready for the save/share sheet.

import { exportText } from './sections.js';
import { renderPdf } from './pdf-packs.js';
import { buildBundle, bundleFileName } from './backup.js';
import { slugify, findShot, shotLabel } from './project.js';
import { getAsset } from './store.js';
import { MIME, makeFile } from './share.js';
import {
  canvasToBlob, jpegBytes, loadImage, renderMoodboard, renderShotCard, renderStoryboardSheet, toJpeg,
} from './images.js';
import { renderAnimatic } from './video.js';
import { renderFinal } from './render.js';
import { filledCount } from './timeline.js';

export const FORMAT_LABEL = {
  pdf: 'PDF', txt: 'Text', md: 'Markdown', png: 'PNG', jpg: 'JPG',
  sheet: 'Image', frames: 'Frames', video: 'Video', json: 'Backup file',
};

export const EXPORTS = [
  { id: 'shoot', label: 'Shoot pack', hint: 'Shot list, camera notes, locations and checklist, for on set', formats: ['pdf', 'txt'] },
  { id: 'full', label: 'Full production pack', hint: 'Everything in one document', formats: ['pdf', 'md', 'txt'] },
  { id: 'storyboard', label: 'Storyboard', hint: 'PDF grid, one tall image, or every frame to Photos', formats: ['pdf', 'sheet', 'frames', 'txt'] },
  { id: 'shotlist', label: 'Shot list', formats: ['pdf', 'txt', 'md'] },
  { id: 'deck', label: 'Concept deck', hint: 'Landscape pitch for the artist or client', formats: ['pdf'] },
  { id: 'direction', label: 'Creative direction pack', formats: ['pdf', 'md', 'txt'] },
  { id: 'rhymes', label: 'Image-Rhyme breakdown', formats: ['pdf', 'md', 'txt'] },
  { id: 'lyrics', label: 'Lyrics → shot map', formats: ['pdf', 'md', 'txt'] },
  { id: 'camera', label: 'Camera instructions', formats: ['pdf', 'txt'] },
  { id: 'locations', label: 'Locations & props', formats: ['pdf', 'txt'] },
  { id: 'checklist', label: 'Shoot checklist', formats: ['pdf', 'txt', 'md'] },
  { id: 'summary', label: 'Project summary', formats: ['pdf', 'txt', 'md'] },
  { id: 'cards', label: 'Shot cards', hint: 'One 9:16 image per shot for Photos', formats: ['png', 'jpg'] },
  { id: 'moodboard', label: 'Moodboard', formats: ['png', 'jpg'] },
  { id: 'final', label: 'Your video', hint: 'Every filmed slot, the song and captions, 9:16', formats: ['video'] },
  { id: 'animatic', label: 'Storyboard animatic', hint: 'Vertical video of your frames', formats: ['video'] },
  { id: 'clips', label: 'Every clip', hint: 'All takes, original quality', formats: ['video'] },
  { id: 'backup', label: 'Project backup', hint: 'Re-open on any device with Import', formats: ['json'] },
];

const TEXT_FORMATS = new Set(['txt', 'md']);

export function exportLabel(id) {
  return EXPORTS.find((e) => e.id === id)?.label || id;
}

// Asset blobs for every shot frame, keyed by shot id (full-size) or asset id.
async function assetBlob(id, preferThumb = false) {
  if (!id) return null;
  const a = await getAsset(id);
  if (!a) return null;
  return (preferThumb && a.thumb) || a.blob;
}

async function frameJpegs(project, onProgress) {
  const frames = new Map();
  const ids = [...new Set(project.shots.map((s) => s.frameAssetId).filter(Boolean))];
  for (let i = 0; i < ids.length; i += 1) {
    const blob = await assetBlob(ids[i]);
    if (blob) {
      try { frames.set(ids[i], await jpegBytes(blob, 1000)); } catch { /* skip unreadable */ }
    }
    onProgress?.((i + 1) / ids.length);
  }
  return frames;
}

async function shotImages(project, { thumbs = false } = {}) {
  const images = new Map();
  for (const s of project.shots) {
    const blob = await assetBlob(s.frameAssetId, thumbs);
    if (blob) {
      try { images.set(s.id, await loadImage(blob)); } catch { /* skip */ }
    }
  }
  return images;
}

async function conceptImages(project) {
  const ids = [
    ...project.assets.filter((a) => a.kind === 'concept' && a.mime?.startsWith('image/')).map((a) => a.id),
    ...project.shots.map((s) => s.frameAssetId).filter(Boolean),
  ];
  const out = [];
  for (const id of [...new Set(ids)].slice(0, 6)) {
    const blob = await assetBlob(id);
    if (blob) { try { out.push(await loadImage(blob)); } catch { /* skip */ } }
  }
  return out;
}

const base = (project) => slugify(project.name);

// Returns { files: File[], text?: string, title, message }
export async function produce(project, id, format, { onProgress, onCanvas, signal } = {}) {
  const name = `${base(project)}-${id}`;
  const title = `${project.name} — ${exportLabel(id)}`;
  const message = `${exportLabel(id)} for “${project.name}”${project.artist ? ` (${project.artist})` : ''} — made with ReaShoota`;

  if (TEXT_FORMATS.has(format)) {
    const kind = id === 'storyboard' ? 'storyboard' : id;
    const text = exportText(kind, project, format);
    return { files: [makeFile(text, `${name}.${format}`, `${MIME[format]};charset=utf-8`)], text, title, message };
  }

  if (format === 'pdf') {
    const frames = await frameJpegs(project, onProgress);
    const bytes = renderPdf(id, project, { frames });
    const text = ['deck', 'storyboard'].includes(id) ? undefined : exportText(id, project, 'txt');
    return { files: [makeFile(bytes, `${name}.pdf`, MIME.pdf)], text, title, message };
  }

  if (id === 'storyboard' && format === 'sheet') {
    const canvas = renderStoryboardSheet(project, await shotImages(project));
    return { files: [makeFile(await canvasToBlob(canvas, 'image/jpeg', 0.88), `${name}.jpg`, MIME.jpg)], title, message };
  }

  if (id === 'storyboard' && format === 'frames') {
    const files = [];
    for (const [i, s] of project.shots.entries()) {
      const a = s.frameAssetId && await getAsset(s.frameAssetId);
      if (!a) continue;
      const ext = a.mime === 'image/png' ? 'png' : 'jpg';
      const blob = ['image/png', 'image/jpeg'].includes(a.mime) ? a.blob : (await toJpeg(a.blob, 2400, 0.92)).blob;
      files.push(makeFile(blob, `${base(project)}-${shotLabel(project, s).toLowerCase()}.${ext}`, ext === 'png' ? MIME.png : MIME.jpg));
      onProgress?.((i + 1) / project.shots.length);
    }
    if (!files.length) throw new Error('No frames yet — add a reference frame to a shot on the Board tab.');
    return { files, title, message };
  }

  if (id === 'cards') {
    const images = await shotImages(project);
    const type = format === 'jpg' ? MIME.jpg : MIME.png;
    const files = [];
    for (const [i, s] of project.shots.entries()) {
      const blob = await canvasToBlob(renderShotCard(project, s, images.get(s.id)), type, 0.9);
      files.push(makeFile(blob, `${base(project)}-card-${shotLabel(project, s).toLowerCase()}.${format}`, type));
      onProgress?.((i + 1) / project.shots.length);
    }
    if (!files.length) throw new Error('Add shots first.');
    return { files, title, message };
  }

  if (id === 'moodboard') {
    const type = format === 'jpg' ? MIME.jpg : MIME.png;
    const blob = await canvasToBlob(renderMoodboard(project, await conceptImages(project)), type, 0.9);
    return { files: [makeFile(blob, `${name}.${format}`, type)], title, message };
  }

  if (id === 'final') {
    if (!filledCount(project)) throw new Error('Shoot or add at least one clip first.');
    const { blob, ext, type } = await renderFinal(project, { onProgress, onCanvas, signal });
    return { files: [makeFile(blob, `${base(project)}.${ext}`, type)], title: `${project.name} — your video`, message };
  }

  if (id === 'animatic') {
    if (!project.shots.length) throw new Error('Add shots first.');
    const { blob, ext, type } = await renderAnimatic(project, await shotImages(project), { onProgress, signal });
    return { files: [makeFile(blob, `${name}.${ext}`, type)], title, message };
  }

  if (id === 'clips') {
    const files = [];
    for (const [i, s] of project.shots.entries()) {
      for (const [k, t] of (s.takes || []).entries()) {
        const a = await getAsset(t.assetId);
        if (!a) continue;
        const ext = a.mime?.includes('mp4') ? 'mp4' : a.mime?.includes('quicktime') ? 'mov' : 'webm';
        files.push(makeFile(a.blob, `${base(project)}-${shotLabel(project, s).toLowerCase()}-take${k + 1}.${ext}`, a.mime));
      }
      onProgress?.((i + 1) / project.shots.length);
    }
    if (!files.length) throw new Error('No clips filmed yet.');
    return { files, title: `${project.name} — every clip`, message };
  }

  if (id === 'backup') {
    const bundle = await buildBundle(project, bundleAsset);
    const json = JSON.stringify(bundle);
    return { files: [makeFile(json, bundleFileName(project), MIME.json)], title, message: `ReaShoota project “${project.name}” — open it in ReaShoota with Import.` };
  }

  throw new Error(`Unsupported export: ${id}/${format}`);
}

export async function bundleAsset(id) {
  const a = await getAsset(id);
  if (!a) return null;
  return { id: a.id, mime: a.mime, name: a.name, kind: a.kind, bytes: new Uint8Array(await a.blob.arrayBuffer()) };
}

// A single stored asset (reference frame, concept image, AI clip, edit) as a File.
export async function assetFile(project, assetId) {
  const a = await getAsset(assetId);
  if (!a) throw new Error('That file is no longer on this device.');
  const meta = project.assets.find((x) => x.id === assetId);
  return makeFile(a.blob, meta?.name || a.name || assetId, a.mime || a.blob.type);
}

export async function shotCardFile(project, shotId) {
  const s = findShot(project, shotId);
  const img = s.frameAssetId ? await loadImage(await assetBlob(s.frameAssetId)) : null;
  const blob = await canvasToBlob(renderShotCard(project, s, img), 'image/png');
  return makeFile(blob, `${base(project)}-card-${shotLabel(project, s).toLowerCase()}.png`, MIME.png);
}

// Best video to hand over for "SAVE VIDEO": final edit > AI clip > rendered animatic.
export function bestVideoAsset(project) {
  const vids = project.assets.filter((a) => a.mime?.startsWith('video/'));
  const byNewest = (a, b) => (b.createdAt || '').localeCompare(a.createdAt || '');
  return vids.filter((a) => a.kind === 'edit').sort(byNewest)[0]
    || vids.filter((a) => a.kind === 'clip').sort(byNewest)[0]
    || null;
}
