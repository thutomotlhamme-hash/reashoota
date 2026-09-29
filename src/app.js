// ReaShoota UI. Plain DOM + event delegation: every interactive element carries
// data-action, handled in one place. State is saved to IndexedDB on every change.

import {
  createProject, createShot, demoProject, duplicateProject, findShot, lyricMap, progress,
  regenerateRemaining, regenerateShot, restorePreviousIdea, setShotDone, shotLabel, touch, uid,
  allLocations, allProps,
} from './project.js';
import { cameraLine, exportText } from './sections.js';
import * as store from './store.js';
import {
  copyText, downloadFile, formatBytes, isIOS, saveToPhone, shareFiles, makeFile,
} from './share.js';
import { EXPORTS, FORMAT_LABEL, assetFile, bestVideoAsset, exportLabel, produce, shotCardFile, bundleAsset } from './exports.js';
import { buildBundle, parseBundle } from './backup.js';
import { loadSession, makeAvailableOffline, registerServiceWorker, saveSession, storageEstimate } from './offline.js';
import * as cloud from './cloud.js';
import { toJpeg } from './images.js';
import { canRenderVideo } from './video.js';
import {
  TEMPLATES, FX_LABELS, PX_PER_SEC, applyTemplate, autoFillTargets, buildBeatSlots, filledCount, formatTime,
  loudestWindow, slotTimes, songOffset, totalDuration, captionAt,
} from './timeline.js';
import { analyse, decodeSong, playSong, unlockAudio, releaseAudio, audioContext } from './audio.js';
import { TimelinePlayer, loadMedia } from './render.js';
import { cameraSupported, closeCamera, openCamera, recordTake, videoThumb } from './camera.js';
import { CAPTION_FONTS, CAPTION_STYLES, loadCaptionFont } from './captions.js';
import { currentTake } from './project.js';
import {
  MODIFIERS, MOTIFS, WEIRDNESS, applyIdea, fillSlotIdeas, buildMoments, getIdea, markerFor, moreLike, strongest, suggest,
} from './echo/engine.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lines = (s) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean);

const state = {
  projects: [],
  project: null,
  tab: 'shoot',
  online: navigator.onLine,
  cloud: null,
  pending: 0,
  busy: null, // { label, progress, abort }
  settingsOpen: false,
  view: 'timeline', // timeline | plan | song | captions | templates (home when no project)
  sel: 0, // selected slot
  tpl: 'hook15',
  echo: null, // open Young-D-Guide moment: { mid, seed, mods, exclude, more }
  allIdeas: false, // show every idea marker, not just the strongest
};

const TABS = [
  ['shoot', 'Shots'], ['board', 'Board'], ['direction', 'Direction'],
  ['checklist', 'Checklist'], ['media', 'Media'], ['export', 'All exports'],
];

// Tab-specific SAVE / SHARE / COPY bar — the most useful output for what's on screen.
const TAB_ACTIONS = {
  shoot: { save: ['shoot', 'pdf', 'Save shoot pack'], share: ['shotlist', 'pdf'], copy: ['shotlist', 'Copy shot list'] },
  board: { save: ['storyboard', 'sheet', 'Save storyboard'], share: ['storyboard', 'pdf'], copy: ['storyboard', 'Copy storyboard'] },
  direction: { save: ['direction', 'pdf', 'Save direction'], share: ['deck', 'pdf'], copy: ['direction', 'Copy direction'] },
  checklist: { save: ['checklist', 'pdf', 'Save checklist'], share: ['checklist', 'txt'], copy: ['checklist', 'Copy checklist'] },
  media: { save: ['video', null, 'Save video'], share: ['moodboard', 'jpg'], copy: null },
};

// ---------------------------------------------------------------- persistence

let saveTimer = null;
function commit({ render: doRender = true } = {}) {
  if (state.project) touch(state.project);
  if (doRender) render();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 250);
}

async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const p = state.project;
  if (!p) return;
  try {
    await store.putProject(p);
    if (state.cloud) {
      await cloud.queueProject(p.id);
      syncSoon();
    }
  } catch (err) {
    toast(`Couldn't save on this phone: ${err.message}`, 'error');
  }
}

function persistSession() {
  saveSession({ projectId: state.project?.id || null, tab: state.tab, view: state.view, sel: state.sel, scrollY: window.scrollY });
}

let syncTimer = null;
function syncSoon() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 1500);
}

async function syncNow() {
  if (!state.cloud) return;
  const res = await cloud.flushQueue(async (id) => {
    const p = id === state.project?.id ? state.project : await store.getProject(id);
    return p ? buildBundle(p, bundleAsset) : null;
  });
  state.pending = res.pending;
  if (res.pushed && state.project) {
    state.project.cloud = { syncedAt: new Date().toISOString() };
    await store.putProject(state.project);
  }
  renderStatus();
}

// ---------------------------------------------------------------- media helpers

const urlCache = new Map();
async function assetUrl(id, thumb = true) {
  const key = `${id}:${thumb}`;
  if (urlCache.has(key)) return urlCache.get(key);
  const a = await store.getAsset(id);
  if (!a) return null;
  const url = URL.createObjectURL((thumb && a.thumb) || a.blob);
  urlCache.set(key, url);
  return url;
}

async function hydrateMedia(root = document) {
  for (const el of root.querySelectorAll('[data-asset]')) {
    if (el.dataset.hydrated) continue;
    el.dataset.hydrated = '1';
    const url = await assetUrl(el.dataset.asset, el.tagName !== 'VIDEO');
    if (url) el.src = url;
  }
}

function pickFile(accept, { capture, multiple } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    if (capture) input.setAttribute('capture', capture);
    if (multiple) input.multiple = true;
    input.onchange = () => resolve([...(input.files || [])]);
    input.click();
  });
}

async function storeMedia(file, kind) {
  const id = uid('asset');
  const rec = { id, kind, name: file.name || `${kind}-${id}`, mime: file.type || 'application/octet-stream', blob: file, createdAt: new Date().toISOString() };
  if (rec.mime.startsWith('image/')) {
    try {
      const t = await toJpeg(file, 480, 0.75);
      rec.thumb = t.blob;
    } catch { /* keep original only */ }
  }
  await store.putAsset(rec);
  state.project.assets.push({ id, kind, name: rec.name, mime: rec.mime, size: file.size, createdAt: rec.createdAt });
  return id;
}

// ---------------------------------------------------------------- rendering

function render() {
  const app = $('#app');
  stopPlayback();
  let html;
  if (!state.project) html = homeView();
  else if (state.view === 'plan') html = projectView();
  else html = ({ timeline: timelineView, song: songView, captions: captionsView, templates: templatesView }[state.view] || timelineView)();
  app.innerHTML = html;
  document.body.dataset.view = state.project ? state.view : 'home';
  renderStatus();
  hydrateMedia(app);
  if (state.project && (state.view === 'timeline' || state.view === 'captions')) refreshMonitor();
  if (state.project?.track && (state.view === 'song' || state.view === 'timeline')) prepareSongEl();
  if (state.view === 'timeline') scrollSlotIntoView();
}

function renderStatus() {
  const el = $('#status');
  if (!el) return;
  const net = state.online ? '' : '<span class="pill warn">Offline — everything still works</span>';
  let acct = '';
  if (state.cloud) acct = `<span class="pill ok">${state.pending ? `${state.pending} to back up` : 'Backed up'}</span>`;
  el.innerHTML = net + acct;
}

function miniBars(p, filledOnly = true) {
  const shades = ['#4b32d6', '#6c4dff', '#8f78ff', '#a996ff', '#cfc5ff'];
  if (!p.shots.length) return '<div class="mini-bars"><span style="flex-grow:1" class="empty"></span></div>';
  return `<div class="mini-bars">${p.shots.map((s, i) => {
    const filled = filledOnly ? !!currentTake(s) || s.status === 'done' : true;
    return `<span style="flex-grow:${Number(s.durationSec) || 1};${filled ? `background:${shades[i % shades.length]}` : ''}" class="${filled ? '' : 'empty'}"></span>`;
  }).join('')}</div>`;
}

function homeView() {
  const cards = state.projects.map((p) => {
    const filled = filledCount(p);
    const badge = filled && filled === p.shots.length ? '<span class="badge">READY</span>'
      : p.offline ? '<span class="badge">OFFLINE ✓</span>'
        : !filled ? '<span class="badge dim">DRAFT</span>' : '';
    return `<article class="pcard">
      <button class="pcard-open" data-action="open" data-id="${p.id}">
        <span class="pcard-head"><span><span class="display pcard-title">${esc(p.name)}</span>
          <span class="pcard-sub">${esc([p.artist, p.song].filter(Boolean).join(' — ') || 'No artist yet')}</span></span>${badge}</span>
        ${miniBars(p)}
        <span class="mono-sub">${filled} OF ${p.shots.length} SHOT · ${formatTime(totalDuration(p), { tenths: false })} · ${esc(timeAgo(p.updatedAt).toUpperCase())}</span>
      </button>
      <div class="pcard-actions">
        <button class="link-btn" data-action="duplicate" data-id="${p.id}">Duplicate</button>
        <button class="link-btn" data-action="home-export" data-id="${p.id}" data-export="backup" data-format="json">Download</button>
        <button class="link-btn" data-action="home-export" data-id="${p.id}" data-export="full" data-format="pdf">Share</button>
        <button class="link-btn danger" data-action="delete-project" data-id="${p.id}">Delete</button>
      </div>
    </article>`;
  }).join('');
  return `<div class="screen home">
    <header class="home-head">
      <div class="wordmark"><span class="rec-dot"></span><span class="display">REASHOOTA</span></div>
      <span class="outline-pill">ON THIS PHONE</span>
    </header>
    <div id="status" class="status"></div>
    <button class="cta" data-action="new-project">${icon('plus')} NEW VIDEO</button>
    ${state.projects.length ? '<p class="eyebrow">RECENT</p>' : ''}
    ${cards || `<div class="empty-card"><p>No videos yet. Start one, or open the demo to see how the timeline, captions and exports work.</p><button class="btn" data-action="demo">Open the demo</button></div>`}
    <div class="home-foot">
      <button class="btn ghost" data-action="import">Import backup</button>
      <button class="btn ghost" data-action="backup-info">Back up</button>
    </div>
    ${state.cloud ? accountCard() : ''}
  </div>`;
}

function accountCard() {
  if (state.cloud) {
    return `<section class="card">
      <h3>Account backup</h3>
      <p class="muted">Signed in${state.cloud.email ? ` as ${esc(state.cloud.email)}` : ''}. Projects back up to your account automatically; this phone keeps its own copy too.</p>
      <div class="row wrap">
        <button class="btn sm" data-action="sync-now">Back up now</button>
        <button class="btn sm ghost" data-action="restore-remote">Restore from account</button>
        <button class="btn sm ghost" data-action="sign-out">Sign out</button>
      </div></section>`;
  }
  return `<section class="card">
    <h3>Account backup</h3>
    <p class="muted">Projects are saved on this phone. Sign in to also keep them in your account and open them on other devices.</p>
    <button class="btn sm" data-action="sign-in">Sign in</button></section>`;
}

function projectView() {
  const p = state.project;
  const pg = progress(p);
  const tabs = TABS.map(([id, label]) => `<button role="tab" class="tab ${state.tab === id ? 'on' : ''}" aria-selected="${state.tab === id}" data-action="tab" data-tab="${id}">${label}</button>`).join('');
  const body = { shoot: shootTab, board: boardTab, direction: directionTab, checklist: checklistTab, media: mediaTab, export: exportTab }[state.tab]();
  return `<div class="sticky-head"><header class="top">
      <button class="icon-btn" data-action="go" data-view="timeline" aria-label="Back to timeline">${icon('back')}</button>
      <div class="title-block">
        <h1 class="display">PLAN</h1>
        <p class="mono-sub">${esc(p.name.toUpperCase())} · ${pg.done}/${pg.total} SHOTS${p.offline ? ' · OFFLINE READY' : ''}</p>
      </div>
      <button class="icon-btn" data-action="edit-project" aria-label="Edit project">${icon('edit')}</button>
    </header>
    <div id="status" class="status"></div>
    <nav class="tabs" role="tablist">${tabs}</nav></div>
    <main class="page">${body}</main>
    ${actionBar()}`;
}

function actionBar() {
  const a = TAB_ACTIONS[state.tab];
  if (!a) return '';
  return `<footer class="action-bar">
    <button class="btn primary" data-action="bar-save">${esc(a.save[2]).toUpperCase()}</button>
    <button class="btn" data-action="bar-share">SHARE</button>
    ${a.copy ? '<button class="btn" data-action="bar-copy">COPY</button>' : ''}
  </footer>`;
}

function shootTab() {
  const p = state.project;
  const st = p.shootSettings;
  const opt = (name, values, cur) => `<select data-setting="${name}">${values.map((v) => `<option ${String(v) === String(cur) ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
  const shots = p.shots.map((s) => {
    const label = shotLabel(p, s);
    const done = s.status === 'done';
    return `<article class="card shot ${done ? 'done' : ''}" id="shot-${s.id}">
      <div class="shot-head">
        <label class="check big"><input type="checkbox" data-action="toggle-shot" data-id="${s.id}" ${done ? 'checked' : ''}><span></span></label>
        <div class="grow">
          <p class="label">${label}${s.durationSec ? ` · ${s.durationSec}s` : ''}${done ? ' · DONE' : ''}</p>
          <h3>${esc(s.title)}</h3>
        </div>
        ${s.frameAssetId ? `<img class="mini" data-asset="${s.frameAssetId}" alt="">` : ''}
      </div>
      <p>${esc(s.description)}</p>
      ${cameraLine(s) ? `<p class="kv"><b>Camera</b> ${esc(cameraLine(s))}</p>` : ''}
      ${s.lyric ? `<p class="kv"><b>Lyric</b> “${esc(s.lyric)}”</p>` : ''}
      ${s.location ? `<p class="kv"><b>Where</b> ${esc(s.location)}</p>` : ''}
      ${s.props.length ? `<p class="kv"><b>Props</b> ${esc(s.props.join(', '))}</p>` : ''}
      <textarea class="notes" rows="1" placeholder="Notes / best take…" data-input="shot-notes" data-id="${s.id}">${esc(s.notes)}</textarea>
      <div class="row wrap">
        <button class="btn sm" data-action="countdown" data-id="${s.id}">▶ Countdown</button>
        <button class="btn sm ghost" data-action="edit-shot" data-id="${s.id}">Edit</button>
        <button class="btn sm ghost" data-action="regen-shot" data-id="${s.id}">New idea</button>
        ${s.history.length ? `<button class="btn sm ghost" data-action="undo-idea" data-id="${s.id}">Undo idea</button>` : ''}
        <button class="btn sm ghost" data-action="save-card" data-id="${s.id}">Save card</button>
      </div>
    </article>`;
  }).join('');
  return `<details class="card settings" data-details="settings" ${state.settingsOpen ? 'open' : ''}>
      <summary><b>Camera & countdown</b> <span class="muted small">${esc(`${st.aspect} · ${st.resolution} · ${st.fps}fps · ${st.lens} · ${st.countdownSec}s countdown`)}</span></summary>
      <div class="grid2">
        <label>Countdown ${opt('countdownSec', [0, 3, 5, 10], st.countdownSec)}</label>
        <label>Aspect ${opt('aspect', ['9:16', '16:9', '1:1', '4:5'], st.aspect)}</label>
        <label>Resolution ${opt('resolution', ['4K', '1080p', '720p'], st.resolution)}</label>
        <label>Frame rate ${opt('fps', [24, 25, 30, 60, 120, 240], st.fps)}</label>
        <label>Shutter ${opt('shutter', ['1/50', '1/60', '1/100', '1/120', '1/250', 'Auto'], st.shutter)}</label>
        <label>Lens ${opt('lens', ['0.5x ultra-wide', '1x (26mm)', '2x (52mm)', '3x/5x tele'], st.lens)}</label>
      </div>
      <label class="block">Setup notes <input data-input="setting-notes" value="${esc(st.notes)}" placeholder="e.g. lock exposure on face, AE/AF lock"></label>
    </details>
    <div class="row wrap">
      <button class="btn" data-action="add-shot">+ Add shot</button>
      ${p.shots.some((s) => s.status !== 'done') ? '<button class="btn ghost" data-action="regen-remaining">New ideas for unshot</button>' : ''}
    </div>
    ${shots || '<p class="empty">No shots yet.</p>'}`;
}

function boardTab() {
  const p = state.project;
  const panels = p.shots.map((s) => `<figure class="panel ${s.status === 'done' ? 'done' : ''}">
      <button class="panel-img" data-action="panel-menu" data-id="${s.id}" aria-label="Frame options for ${esc(s.title)}">
        ${s.frameAssetId ? `<img data-asset="${s.frameAssetId}" alt="">` : `<span class="ph">${esc(s.description || 'Tap to add a reference frame')}</span>`}
      </button>
      <figcaption><b>${shotLabel(p, s)}${s.status === 'done' ? ' ✓' : ''}</b> ${esc(s.title)}</figcaption>
    </figure>`).join('');
  return `<p class="muted small">Tap a panel to add a reference frame from Photos or the camera, or to save it to your phone.</p>
    <div class="board">${panels || '<p class="empty">Add shots on the Shoot tab first.</p>'}</div>`;
}

function directionTab() {
  const p = state.project;
  const d = p.direction;
  const list = (items) => (items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '<p class="muted">—</p>');
  const rhymes = p.imageRhymes.map((r) => `<div class="rhyme"><b>${esc(r.motif)}</b><p class="small">${esc(r.first)} → ${esc(r.echo)}</p><p class="small muted">${esc(r.meaning)}</p></div>`).join('');
  const lmap = lyricMap(p).map(({ line, shots }) => `<li><span>${esc(line)}</span> <span class="tag">${shots.length ? shots.map((s) => shotLabel(p, s)).join(' ') : '—'}</span></li>`).join('');
  const locs = allLocations(p).map((l) => `<li><b>${esc(l.name)}</b>${l.address ? ` — ${esc(l.address)}` : ''}${l.notes ? `<br><span class="small muted">${esc(l.notes)}</span>` : ''}${l.shots.length ? ` <span class="tag">${l.shots.join(' ')}</span>` : ''}</li>`).join('');
  const props = allProps(p).map((x) => `<li>${esc(x.name)} ${x.shots.length ? `<span class="tag">${x.shots.join(' ')}</span>` : ''}</li>`).join('');
  return `<section class="card">
      ${d.logline ? `<p class="lead">${esc(d.logline)}</p>` : ''}
      <h3>Concept</h3><p>${esc(d.concept) || '<span class="muted">—</span>'}</p>
      <h3>Mood & tone</h3><p>${esc(d.mood) || '<span class="muted">—</span>'}</p>
      ${d.palette.length ? `<div class="palette">${d.palette.map((c) => `<span style="background:${esc(c)}" title="${esc(c)}"></span>`).join('')}</div>` : ''}
      <h3>Visual rules</h3>${list(d.visualRules)}
      <h3>Wardrobe</h3>${list(d.wardrobe)}
      <h3>References</h3>${list(d.references)}
    </section>
    <section class="card"><h3>Image rhymes</h3>${rhymes || '<p class="muted">—</p>'}
      <button class="btn sm ghost" data-action="quick-export" data-export="rhymes" data-format="pdf">Save breakdown</button></section>
    <section class="card"><h3>Lyrics → shots</h3><ul class="lyric-map">${lmap || '<li class="muted">No lyrics yet</li>'}</ul>
      <button class="btn sm ghost" data-action="quick-export" data-export="lyrics" data-format="pdf">Save lyric map</button></section>
    <section class="card"><h3>Locations</h3><ul>${locs || '<li class="muted">—</li>'}</ul><h3>Props</h3><ul>${props || '<li class="muted">—</li>'}</ul>
      <button class="btn sm ghost" data-action="quick-export" data-export="locations" data-format="pdf">Save locations & props</button></section>
    <button class="btn" data-action="edit-project">Edit direction, lyrics & locations</button>`;
}

function checklistTab() {
  const p = state.project;
  const groups = new Map();
  for (const c of p.checklist) {
    if (!groups.has(c.category)) groups.set(c.category, []);
    groups.get(c.category).push(c);
  }
  const html = [...groups].map(([cat, items]) => `<section class="card"><h3>${esc(cat)}</h3>
    ${items.map((c) => `<div class="check-row"><label class="check"><input type="checkbox" data-action="toggle-check" data-id="${c.id}" ${c.done ? 'checked' : ''}><span></span>${esc(c.text)}</label>
      <button class="icon-btn sm" data-action="remove-check" data-id="${c.id}" aria-label="Remove">×</button></div>`).join('')}
    </section>`).join('');
  return `${html || '<p class="empty">Nothing on the checklist yet.</p>'}
    <form class="card row" data-form="add-check">
      <input name="text" placeholder="Add item… (e.g. spare batteries)" required>
      <input name="category" placeholder="Group" list="check-cats" class="narrow" value="Gear">
      <datalist id="check-cats">${[...groups.keys()].map((g) => `<option>${esc(g)}</option>`).join('')}</datalist>
      <button class="btn">Add</button>
    </form>`;
}

const KIND_LABEL = { concept: 'Concept image', clip: 'AI video clip', edit: 'Edited video', frame: 'Reference frame' };

function mediaTab() {
  const p = state.project;
  const items = [...p.assets].reverse().map((a) => {
    const isVideo = a.mime?.startsWith('video/');
    const preview = isVideo
      ? `<video data-asset="${a.id}" playsinline muted controls preload="metadata"></video>`
      : `<img data-asset="${a.id}" alt="">`;
    return `<article class="card media-item">${preview}
      <p class="small"><b>${esc(KIND_LABEL[a.kind] || a.kind)}</b> · ${esc(a.name)} · ${formatBytes(a.size)}</p>
      <div class="row wrap">
        <button class="btn sm primary" data-action="asset-save" data-id="${a.id}">${isVideo ? 'Save video' : 'Save to phone'}</button>
        <button class="btn sm" data-action="asset-share" data-id="${a.id}">Share</button>
        <button class="btn sm ghost danger" data-action="asset-remove" data-id="${a.id}">Remove</button>
      </div></article>`;
  }).join('');
  return `<div class="row wrap">
      <button class="btn" data-action="add-media" data-kind="concept">+ Concept image</button>
      <button class="btn" data-action="add-media" data-kind="clip">+ AI video clip</button>
      <button class="btn" data-action="add-media" data-kind="edit">+ Edited video</button>
    </div>
    <div class="media-grid">${items || '<p class="empty">Concept images, AI clips and final edits you add here can be saved straight to Photos.</p>'}</div>`;
}

function exportTab() {
  const p = state.project;
  const video = bestVideoAsset(p);
  const rows = EXPORTS.map((e) => `<li class="export-row">
      <div class="grow"><b>${esc(e.label)}</b>${e.hint ? `<p class="small muted">${esc(e.hint)}</p>` : ''}</div>
      <div class="chips">${e.formats.map((f) => `<button class="chip" data-action="quick-export" data-export="${e.id}" data-format="${f}">${FORMAT_LABEL[f]}</button>`).join('')}
      ${e.formats.some((f) => f === 'txt' || f === 'md') ? `<button class="chip" data-action="copy" data-kind="${e.id}">Copy</button>` : ''}</div>
    </li>`).join('');
  return `<section class="hero-actions">
      <button class="hero primary" data-action="quick-export" data-export="shoot" data-format="pdf"><b>DOWNLOAD SHOOT PACK</b><span>PDF · shot list, camera, locations, checklist</span></button>
      <button class="hero" data-action="quick-export" data-export="storyboard" data-format="pdf"><b>SAVE STORYBOARD</b><span>PDF, image or frames to Photos</span></button>
      <button class="hero" data-action="save-video"><b>SAVE VIDEO</b><span>${video ? esc(`${KIND_LABEL[video.kind]}: ${video.name}`) : 'Render a 9:16 storyboard animatic'}</span></button>
      <button class="hero" data-action="copy" data-kind="shotlist"><b>COPY SHOT LIST</b><span>Paste into Notes, WhatsApp, email</span></button>
      <button class="hero" data-action="quick-export" data-export="full" data-format="pdf" data-share="1"><b>SHARE PROJECT</b><span>Full production pack PDF</span></button>
      <button class="hero ${p.offline ? 'ok' : ''}" data-action="make-offline"><b>${p.offline ? 'AVAILABLE OFFLINE ✓' : 'MAKE AVAILABLE OFFLINE'}</b><span>${p.offline ? `Saved ${timeAgo(p.offline.at)} · ${formatBytes(p.offline.bytes)} · tap to refresh` : 'Keep the shoot plan on this phone for no-signal locations'}</span></button>
    </section>
    <h2 class="section-title">Everything else</h2>
    <ul class="export-list card">${rows}</ul>
    <section class="card">
      <h3>This project</h3>
      <div class="row wrap">
        <button class="btn sm" data-action="duplicate" data-id="${p.id}">Duplicate project</button>
        <button class="btn sm" data-action="quick-export" data-export="backup" data-format="json">Download backup</button>
        <button class="btn sm ghost" data-action="import">Import backup</button>
      </div>
      <p class="small muted">${state.cloud ? 'Also backed up to your account.' : 'Saved on this phone. Sign in on the projects screen to back up to your account too.'}</p>
    </section>`;
}

// ---------------------------------------------------------------- sheets

function openSheet(html, { onClose } = {}) {
  closeSheet();
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  wrap.addEventListener('click', (e) => { if (e.target === wrap) closeSheet(); });
  wrap._onClose = onClose;
  document.body.appendChild(wrap);
  document.body.classList.add('sheet-open');
  hydrateMedia(wrap);
  return wrap;
}

function closeSheet() {
  const w = $('.sheet-wrap');
  if (!w) return;
  w._onClose?.();
  w.remove();
  document.body.classList.remove('sheet-open');
}

let readyFiles = null;
let readyUrls = [];

function openReadySheet(result, { exportId, format, shareFirst } = {}) {
  readyFiles = result;
  readyUrls.forEach((u) => URL.revokeObjectURL(u));
  readyUrls = [];
  const { files } = result;
  const total = files.reduce((n, f) => n + f.size, 0);
  const first = files[0];
  let preview = '';
  if (first.type.startsWith('image/')) {
    preview = `<div class="preview-strip">${files.slice(0, 6).map((f) => { const u = URL.createObjectURL(f); readyUrls.push(u); return `<img src="${u}" alt="">`; }).join('')}</div>`;
  } else if (first.type.startsWith('video/')) {
    const u = URL.createObjectURL(first); readyUrls.push(u);
    preview = `<video src="${u}" playsinline controls muted class="preview-video"></video>`;
  } else {
    preview = `<div class="file-icon">${esc(first.name.split('.').pop().toUpperCase())}</div>`;
  }
  const alt = exportId ? EXPORTS.find((e) => e.id === exportId)?.formats.filter((f) => f !== format) : [];
  const isMedia = /^(image|video)\//.test(first.type);
  openSheet(`<h2>${esc(result.title)}</h2>
    ${preview}
    <p class="small muted">${files.length > 1 ? `${files.length} files` : esc(first.name)} · ${formatBytes(total)}</p>
    <div class="stack">
      ${shareFirst ? '<button class="btn primary big" data-action="ready-share">SHARE</button>' : `<button class="btn primary big" data-action="ready-save">SAVE TO PHONE</button>`}
      ${shareFirst ? '<button class="btn big" data-action="ready-save">SAVE TO PHONE</button>' : '<button class="btn big" data-action="ready-share">SHARE</button>'}
      <button class="btn big" data-action="ready-download">DOWNLOAD</button>
      ${result.text ? '<button class="btn big" data-action="ready-copy">COPY TEXT</button>' : ''}
    </div>
    <p class="hint">${isIOS()
    ? (isMedia ? 'Save to Phone opens the share sheet — choose <b>Save Image</b> / <b>Save Video</b> for Photos, or <b>Save to Files</b>.' : 'Save to Phone opens the share sheet — choose <b>Save to Files</b> (iCloud Drive or On My iPhone), or send it with AirDrop, Messages, WhatsApp or Mail.')
    : 'Save to Phone uses your device share sheet where available; Download saves a copy to your Downloads.'}</p>
    ${alt?.length ? `<p class="small muted">Also as: ${alt.map((f) => `<button class="chip" data-action="quick-export" data-export="${exportId}" data-format="${f}">${FORMAT_LABEL[f]}</button>`).join(' ')}</p>` : ''}
    <button class="btn ghost" data-action="close-sheet">Done</button>`, {
    onClose: () => { readyUrls.forEach((u) => URL.revokeObjectURL(u)); readyUrls = []; },
  });
}

async function readyAction(kind) {
  const r = readyFiles;
  if (!r) return;
  try {
    if (kind === 'copy') {
      const ok = await copyText(r.text);
      toast(ok ? 'Copied — paste it anywhere' : 'Copy failed', ok ? 'ok' : 'error');
      return;
    }
    if (kind === 'download') {
      r.files.forEach((f, i) => setTimeout(() => downloadFile(f), i * 400));
      toast(isIOS() ? 'Saved to Files › Downloads' : 'Download started', 'ok');
      return;
    }
    const outcome = kind === 'save' ? await saveToPhone(r.files) : await shareFiles(r.files, { title: r.title, text: r.message });
    if (outcome === 'unsupported') {
      // No file sharing in this browser (e.g. desktop Firefox) — fall back to downloads.
      r.files.forEach((f, i) => setTimeout(() => downloadFile(f), i * 400));
      toast('Sharing isn’t available here — downloading instead', 'ok');
    } else if (outcome === 'shared') toast('Done', 'ok');
  } catch (err) {
    toast(err.name === 'NotAllowedError' ? 'Tap again to open the share sheet' : `Couldn’t share: ${err.message}`, 'error');
  }
}

function busySheet(label) {
  const ctl = new AbortController();
  state.busy = { ctl };
  openSheet(`<h2>${esc(label)}</h2><div id="busy-preview"></div><div class="bar big"><span id="busy-bar" style="width:4%"></span></div>
    <p class="small muted" id="busy-note">Preparing…</p>
    <button class="btn ghost" data-action="cancel-busy">Cancel</button>`, { onClose: () => ctl.abort() });
  return {
    signal: ctl.signal,
    progress: (f) => { const b = $('#busy-bar'); if (b) b.style.width = `${Math.max(4, Math.round(f * 100))}%`; },
    note: (t) => { const n = $('#busy-note'); if (n) n.textContent = t; },
  };
}

async function runExport(project, exportId, format, opts = {}) {
  const busy = busySheet(exportId === 'final' ? 'Making your video…' : `Preparing ${exportLabel(exportId)}…`);
  if (exportId === 'animatic' || exportId === 'final') busy.note('Rendering in real time at 1080×1920 — keep the screen on.');
  const onCanvas = (canvas) => {
    const slot = $('#busy-preview');
    if (!slot) return;
    canvas.className = 'render-preview';
    slot.replaceChildren(canvas);
  };
  try {
    const result = await produce(project, exportId, format, { onProgress: busy.progress, onCanvas, signal: busy.signal });
    if (busy.signal.aborted) return;
    openReadySheet(result, { exportId, format, shareFirst: opts.shareFirst });
  } catch (err) {
    closeSheet();
    if (err.name !== 'AbortError') toast(err.message, 'error');
  }
}

async function saveVideo() {
  const p = state.project;
  const v = bestVideoAsset(p);
  if (v) {
    const file = await assetFile(p, v.id);
    openReadySheet({ files: [file], title: `${p.name} — ${KIND_LABEL[v.kind]}`, message: `${p.name} — ${KIND_LABEL[v.kind]}` });
    return;
  }
  if (!canRenderVideo()) { toast('This browser can’t record video. Add a clip on the Media tab to save it.', 'error'); return; }
  runExport(p, 'animatic', 'video');
}

function doCopy(kind) {
  // Built synchronously so the clipboard write stays inside the tap (required on iOS).
  const text = exportText(kind, state.project, 'txt');
  copyText(text).then((ok) => toast(ok ? `${exportLabel(kind)} copied — paste it anywhere` : 'Copy failed', ok ? 'ok' : 'error'));
}

// ---------------------------------------------------------------- forms

function shotForm(shot) {
  const p = state.project;
  const c = shot.camera;
  return `<form data-form="shot" data-id="${shot.id}">
    <h2>${shot._new ? 'New shot' : `Edit ${shotLabel(p, shot)}`}</h2>
    <label class="block">Title <input name="title" value="${esc(shot.title)}" required></label>
    <label class="block">What happens <textarea name="description" rows="3">${esc(shot.description)}</textarea></label>
    <label class="block">Lyric <input name="lyric" list="lyric-list" value="${esc(shot.lyric)}"></label>
    <datalist id="lyric-list">${p.lyrics.map((l) => `<option>${esc(l)}</option>`).join('')}</datalist>
    <div class="grid2">
      <label>Lens <input name="lens" value="${esc(c.lens)}" placeholder="1x (26mm)"></label>
      <label>Move <input name="move" value="${esc(c.move)}" placeholder="slow push-in"></label>
      <label>Angle <input name="angle" value="${esc(c.angle)}" placeholder="low angle"></label>
      <label>FPS <input name="fps" value="${esc(c.fps)}" inputmode="numeric"></label>
    </div>
    <label class="block">Camera notes <input name="cnotes" value="${esc(c.notes)}"></label>
    <label class="block">Location <input name="location" list="loc-list" value="${esc(shot.location)}"></label>
    <datalist id="loc-list">${allLocations(p).map((l) => `<option>${esc(l.name)}</option>`).join('')}</datalist>
    <label class="block">Props (comma separated) <input name="props" value="${esc(shot.props.join(', '))}"></label>
    <label class="block">Duration (seconds) <input name="durationSec" type="number" min="1" max="120" value="${shot.durationSec}"></label>
    <div class="row wrap">
      <button class="btn primary">Save shot</button>
      ${shot._new ? '' : `<button type="button" class="btn ghost" data-action="move-shot" data-id="${shot.id}" data-dir="-1">Move up</button>
      <button type="button" class="btn ghost" data-action="move-shot" data-id="${shot.id}" data-dir="1">Move down</button>
      <button type="button" class="btn ghost danger" data-action="delete-shot" data-id="${shot.id}">Delete</button>`}
    </div></form>`;
}

function projectForm(p, isNew) {
  const d = p.direction;
  const ta = (name, label, value, rows = 3, ph = '') => `<label class="block">${label}<textarea name="${name}" rows="${rows}" placeholder="${esc(ph)}">${esc(value)}</textarea></label>`;
  return `<form data-form="project" data-new="${isNew ? 1 : ''}">
    <h2>${isNew ? 'New project' : 'Edit project'}</h2>
    <label class="block">Project name <input name="name" value="${esc(isNew ? '' : p.name)}" required placeholder="e.g. Golden Hour video"></label>
    <div class="grid2">
      <label>Artist <input name="artist" value="${esc(p.artist)}"></label>
      <label>Song <input name="song" value="${esc(p.song)}"></label>
    </div>
    <label class="block">Logline <input name="logline" value="${esc(d.logline)}"></label>
    ${ta('concept', 'Concept', d.concept)}
    ${ta('mood', 'Mood & tone', d.mood, 2)}
    <label class="block">Palette (hex, comma separated) <input name="palette" value="${esc(d.palette.join(', '))}" placeholder="#1b1a2e, #ff7a3d"></label>
    ${ta('visualRules', 'Visual rules (one per line)', d.visualRules.join('\n'))}
    ${ta('wardrobe', 'Wardrobe (one per line)', d.wardrobe.join('\n'), 2)}
    ${ta('references', 'References (one per line)', d.references.join('\n'), 2)}
    ${ta('lyrics', 'Lyrics (one line per line)', p.lyrics.join('\n'), 5)}
    ${ta('rhymes', 'Image rhymes — motif | first appears | echo | meaning', p.imageRhymes.map((r) => [r.motif, r.first, r.echo, r.meaning].join(' | ')).join('\n'), 3, 'Reflection | S01 taxi window | S06 shop window | chasing herself')}
    ${ta('locations', 'Locations — name | address | notes', p.locations.map((l) => [l.name, l.address, l.notes].join(' | ')).join('\n'), 3)}
    ${ta('props', 'Props (one per line)', p.props.join('\n'), 2)}
    ${ta('notes', 'Project notes', p.notes, 2)}
    <button class="btn primary">${isNew ? 'Create project' : 'Save'}</button>
  </form>`;
}

function applyProjectForm(p, f) {
  const g = (k) => (f.get(k) || '').toString().trim();
  p.name = g('name') || p.name;
  p.artist = g('artist');
  p.song = g('song');
  Object.assign(p.direction, {
    logline: g('logline'), concept: g('concept'), mood: g('mood'),
    palette: g('palette').split(/[\s,]+/).filter((c) => /^#?[0-9a-f]{3,6}$/i.test(c)).map((c) => (c.startsWith('#') ? c : `#${c}`)),
    visualRules: lines(g('visualRules')), wardrobe: lines(g('wardrobe')), references: lines(g('references')),
  });
  p.lyrics = lines(g('lyrics'));
  const split = (l) => l.split('|').map((x) => x.trim());
  const oldRhymes = p.imageRhymes;
  p.imageRhymes = lines(g('rhymes')).map((l, i) => { const [motif, first = '', echo = '', meaning = ''] = split(l); return { id: oldRhymes[i]?.id || uid('rhyme'), motif, first, echo, meaning }; });
  const oldLocs = p.locations;
  p.locations = lines(g('locations')).map((l, i) => { const [name, address = '', notes = ''] = split(l); return { id: oldLocs[i]?.id || uid('loc'), name, address, notes }; });
  p.props = lines(g('props'));
  p.notes = g('notes');
}

// ---------------------------------------------------------------- countdown

let countdownTimer = null;
function startCountdown(shotId) {
  const p = state.project;
  const s = findShot(p, shotId);
  let n = Number(p.shootSettings.countdownSec) || 0;
  const st = p.shootSettings;
  const overlay = document.createElement('div');
  overlay.className = 'countdown';
  overlay.innerHTML = `<p class="label">${shotLabel(p, s)} · ${esc(s.title)}</p>
    <div class="count" id="count">${n || 'ACTION'}</div>
    <p class="small">${esc(cameraLine(s) || `${st.lens} · ${st.fps}fps`)} · ${esc(st.aspect)} · ${esc(st.resolution)}</p>
    ${s.lyric ? `<p class="lyric">“${esc(s.lyric)}”</p>` : ''}
    <div class="row"><button class="btn primary" data-action="countdown-done" data-id="${s.id}">Mark shot done</button><button class="btn" data-action="countdown-close">Close</button></div>`;
  document.body.appendChild(overlay);
  clearInterval(countdownTimer);
  if (!n) { navigator.vibrate?.(200); return; }
  countdownTimer = setInterval(() => {
    n -= 1;
    const el = $('#count');
    if (!el) { clearInterval(countdownTimer); return; }
    el.textContent = n > 0 ? n : 'ACTION';
    navigator.vibrate?.(n > 0 ? 40 : 250);
    if (n <= 0) clearInterval(countdownTimer);
  }, 1000);
}

function closeCountdown() {
  clearInterval(countdownTimer);
  document.querySelector('.countdown')?.remove();
}

// ---------------------------------------------------------------- actions

async function openProject(id, tab, view = 'timeline', sel = 0) {
  await flushSave();
  const p = await store.getProject(id);
  if (!p) return;
  state.project = p;
  state.tab = tab || 'shoot';
  state.view = view || 'timeline';
  state.sel = Math.min(sel || 0, Math.max(0, p.shots.length - 1));
  media = null;
  render();
  window.scrollTo(0, 0);
  persistSession();
}

async function goHome() {
  await flushSave();
  state.project = null;
  state.projects = await store.listProjects();
  render();
  persistSession();
}

async function importBackup() {
  const [file] = await pickFile('.json,application/json');
  if (!file) return;
  try {
    const exists = async (id) => !!(await store.getProject(id));
    const text = await file.text();
    let { project, assets } = parseBundle(text);
    if (await exists(project.id)) ({ project, assets } = parseBundle(text, { asCopy: true }));
    for (const a of assets) {
      const blob = new Blob([a.bytes], { type: a.mime });
      const rec = { id: a.id, kind: a.kind, name: a.name, mime: a.mime, blob, createdAt: new Date().toISOString() };
      if (a.mime?.startsWith('image/')) { try { rec.thumb = (await toJpeg(blob, 480, 0.75)).blob; } catch { /* ignore */ } }
      await store.putAsset(rec);
    }
    await store.putProject(project);
    toast(`Imported “${project.name}”`, 'ok');
    openProject(project.id);
  } catch (err) {
    toast(err.message, 'error');
  }
}

const handlers = {
  async open(el) { openProject(el.dataset.id); },
  home: goHome,
  tab(el) { state.tab = el.dataset.tab; render(); window.scrollTo(0, 0); persistSession(); },
  async demo() {
    const p = demoProject();
    await store.putProject(p);
    openProject(p.id);
  },
  'new-project'() {
    openSheet(`<form data-form="quick-new"><h2 class="display">NEW VIDEO</h2>
      <label class="block">Song title <input name="song" placeholder="e.g. Ghost in the Taxi Rank" required></label>
      <label class="block">Artist <input name="artist" placeholder="Who’s performing"></label>
      <button class="btn primary big">NEXT: PICK A TEMPLATE</button></form>`);
  },
  'edit-project'() { openSheet(projectForm(state.project, false)); },
  async duplicate(el) {
    const src = state.project?.id === el.dataset.id ? state.project : await store.getProject(el.dataset.id);
    if (state.project) await flushSave();
    const copy = duplicateProject(src);
    await store.putProject(copy);
    toast(`Duplicated as “${copy.name}”`, 'ok');
    if (state.project) openProject(copy.id); else goHome();
  },
  async 'delete-project'(el) {
    const p = state.projects.find((x) => x.id === el.dataset.id);
    if (!p || !window.confirm(`Delete “${p.name}” from this phone? This can’t be undone.${state.cloud ? ' Your account copy is kept.' : ''}`)) return;
    await store.deleteProject(p.id);
    goHome();
  },
  async 'home-export'(el) {
    const p = await store.getProject(el.dataset.id);
    runExport(p, el.dataset.export, el.dataset.format, { shareFirst: el.dataset.export !== 'backup' });
  },
  import: importBackup,
  'quick-export'(el) { runExport(state.project, el.dataset.export, el.dataset.format, { shareFirst: !!el.dataset.share }); },
  copy(el) { doCopy(el.dataset.kind); },
  'save-video': saveVideo,
  'bar-save'() {
    const [id, fmt] = TAB_ACTIONS[state.tab].save;
    if (id === 'video') saveVideo(); else runExport(state.project, id, fmt);
  },
  'bar-share'() { const [id, fmt] = TAB_ACTIONS[state.tab].share; runExport(state.project, id, fmt, { shareFirst: true }); },
  'bar-copy'() { doCopy(TAB_ACTIONS[state.tab].copy[0]); },
  'ready-save'() { readyAction('save'); },
  'ready-share'() { readyAction('share'); },
  'ready-download'() { readyAction('download'); },
  'ready-copy'() { readyAction('copy'); },
  'close-sheet': closeSheet,
  'cancel-busy'() { state.busy?.ctl.abort(); closeSheet(); },
  async 'make-offline'() {
    const busy = busySheet('Making available offline…');
    busy.note('Saving shot list, storyboard thumbnails, notes and settings on this phone.');
    try {
      const info = await makeAvailableOffline(state.project, busy.progress);
      commit();
      closeSheet();
      toast(`Available offline${info.persisted ? '' : ' (storage may be cleared if the phone runs very low on space — keep a PDF too)'}`, 'ok');
      const est = await storageEstimate();
      if (est && est.quota && est.usage / est.quota > 0.8) toast('Phone storage for ReaShoota is nearly full', 'error');
    } catch (err) {
      closeSheet();
      toast(err.message, 'error');
    }
  },
  'toggle-shot'(el) { setShotDone(state.project, el.dataset.id, el.checked); commit(); },
  'add-shot'() { const s = createShot({ title: '' }); s._new = true; openSheet(shotForm(s)); },
  'edit-shot'(el) { openSheet(shotForm(findShot(state.project, el.dataset.id))); },
  'move-shot'(el) {
    const arr = state.project.shots;
    const i = arr.findIndex((s) => s.id === el.dataset.id);
    const j = i + Number(el.dataset.dir);
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    closeSheet();
    commit();
  },
  'delete-shot'(el) {
    if (!window.confirm('Delete this shot?')) return;
    state.project.shots = state.project.shots.filter((s) => s.id !== el.dataset.id);
    closeSheet();
    commit();
  },
  'regen-shot'(el) {
    const s = findShot(state.project, el.dataset.id);
    regenerateShot(state.project, s.id);
    commit();
    toast(s.status === 'done' ? 'New idea — shot stays marked done. Undo idea restores the old one.' : 'New idea generated — Undo idea restores the old one', 'ok');
  },
  'undo-idea'(el) { restorePreviousIdea(state.project, el.dataset.id); commit(); },
  'regen-remaining'() {
    const n = regenerateRemaining(state.project).length;
    commit();
    toast(`${n} unshot ${n === 1 ? 'idea' : 'ideas'} refreshed — completed shots untouched`, 'ok');
  },
  countdown(el) { startCountdown(el.dataset.id); },
  'countdown-done'(el) { setShotDone(state.project, el.dataset.id, true); closeCountdown(); commit(); },
  'countdown-close': closeCountdown,
  async 'save-card'(el) {
    try {
      const file = await shotCardFile(state.project, el.dataset.id);
      openReadySheet({ files: [file], title: 'Shot card', message: state.project.name });
    } catch (err) { toast(err.message, 'error'); }
  },
  'panel-menu'(el) {
    const s = findShot(state.project, el.dataset.id);
    openSheet(`<h2>${shotLabel(state.project, s)} · ${esc(s.title)}</h2>
      ${s.frameAssetId ? `<img class="sheet-frame" data-asset="${s.frameAssetId}" alt="">` : ''}
      <div class="stack">
        ${s.frameAssetId ? `<button class="btn primary big" data-action="frame-save" data-id="${s.id}">SAVE FRAME TO PHONE</button>` : ''}
        <button class="btn big ${s.frameAssetId ? '' : 'primary'}" data-action="frame-add" data-id="${s.id}">${s.frameAssetId ? 'Replace frame' : 'Add reference frame'}</button>
        <button class="btn big" data-action="frame-add" data-id="${s.id}" data-capture="1">Take photo</button>
        <button class="btn big" data-action="save-card" data-id="${s.id}">Save shot card</button>
        ${s.frameAssetId ? `<button class="btn ghost danger" data-action="frame-remove" data-id="${s.id}">Remove frame</button>` : ''}
      </div>
      <button class="btn ghost" data-action="close-sheet">Close</button>`);
  },
  async 'frame-add'(el) {
    const [file] = await pickFile('image/*', { capture: el.dataset.capture ? 'environment' : undefined });
    if (!file) return;
    const s = findShot(state.project, el.dataset.id);
    s.frameAssetId = await storeMedia(file, 'frame');
    closeSheet();
    commit();
  },
  async 'frame-save'(el) {
    const s = findShot(state.project, el.dataset.id);
    const file = await assetFile(state.project, s.frameAssetId);
    openReadySheet({ files: [file], title: `${shotLabel(state.project, s)} reference frame`, message: s.title });
  },
  'frame-remove'(el) {
    const s = findShot(state.project, el.dataset.id);
    const id = s.frameAssetId;
    s.frameAssetId = null;
    state.project.assets = state.project.assets.filter((a) => a.id !== id || a.kind !== 'frame');
    closeSheet();
    commit();
  },
  async 'add-media'(el) {
    const kind = el.dataset.kind;
    const files = await pickFile(kind === 'concept' ? 'image/*' : 'video/*', { multiple: true });
    for (const f of files) await storeMedia(f, kind);
    if (files.length) { commit(); toast(`${files.length} added`, 'ok'); }
  },
  async 'asset-save'(el) {
    const file = await assetFile(state.project, el.dataset.id);
    openReadySheet({ files: [file], title: file.name, message: state.project.name });
  },
  async 'asset-share'(el) {
    const file = await assetFile(state.project, el.dataset.id);
    openReadySheet({ files: [file], title: file.name, message: state.project.name }, { shareFirst: true });
  },
  'asset-remove'(el) {
    if (!window.confirm('Remove this from the project?')) return;
    const id = el.dataset.id;
    state.project.assets = state.project.assets.filter((a) => a.id !== id);
    for (const s of state.project.shots) if (s.frameAssetId === id) s.frameAssetId = null;
    commit();
  },
  'toggle-check'(el) {
    const c = state.project.checklist.find((x) => x.id === el.dataset.id);
    c.done = el.checked;
    commit();
  },
  'remove-check'(el) { state.project.checklist = state.project.checklist.filter((x) => x.id !== el.dataset.id); commit(); },
  'sign-in'() {
    openSheet(`<form data-form="sign-in"><h2>Sign in to back up</h2>
      <p class="small muted">Your projects stay on this phone and are also copied to your ReaShoota account.</p>
      <label class="block">Email <input name="email" type="email" autocomplete="email"></label>
      <label class="block">Server <input name="endpoint" type="url" placeholder="https://api.example.com" required></label>
      <label class="block">Access token <input name="token" type="password" autocomplete="current-password" required></label>
      <button class="btn primary">Sign in</button></form>`);
  },
  async 'sign-out'() { await cloud.signOut(); state.cloud = null; render(); },
  async 'sync-now'() { await syncNow(); toast(state.pending ? `${state.pending} still waiting for signal` : 'Backed up', state.pending ? 'error' : 'ok'); },
  async 'restore-remote'() {
    try {
      const list = await cloud.listRemote();
      openSheet(`<h2>Restore from account</h2><div class="stack">${list.map((r) => `<button class="btn" data-action="pull-remote" data-id="${esc(r.id)}">${esc(r.name)} <span class="small muted">${timeAgo(r.updatedAt)}</span></button>`).join('') || '<p class="muted">No projects in your account yet.</p>'}</div>`);
    } catch (err) { toast(err.message, 'error'); }
  },
  async 'pull-remote'(el) {
    try {
      const bundle = await cloud.fetchRemote(el.dataset.id);
      const local = await store.getProject(bundle.project?.id);
      const { project, assets } = parseBundle(bundle, { asCopy: !!local && local.updatedAt > bundle.project.updatedAt });
      for (const a of assets) await store.putAsset({ id: a.id, kind: a.kind, name: a.name, mime: a.mime, blob: new Blob([a.bytes], { type: a.mime }), createdAt: new Date().toISOString() });
      await store.putProject(project);
      closeSheet();
      openProject(project.id);
    } catch (err) { toast(err.message, 'error'); }
  },
};

const forms = {
  async project(form) {
    const isNew = !!form.dataset.new;
    const p = isNew ? createProject() : state.project;
    applyProjectForm(p, new FormData(form));
    closeSheet();
    if (isNew) { await store.putProject(p); openProject(p.id, 'shoot'); } else commit();
  },
  shot(form) {
    const f = new FormData(form);
    const g = (k) => (f.get(k) || '').toString().trim();
    const p = state.project;
    let s = findShot(p, form.dataset.id);
    if (!s) { s = createShot({ id: form.dataset.id }); p.shots.push(s); }
    Object.assign(s, {
      title: g('title'), description: g('description'), lyric: g('lyric'), location: g('location'),
      props: g('props').split(',').map((x) => x.trim()).filter(Boolean),
      durationSec: Number(g('durationSec')) || 3,
    });
    s.camera = { lens: g('lens'), move: g('move'), angle: g('angle'), fps: g('fps'), notes: g('cnotes') };
    closeSheet();
    commit();
  },
  'add-check'(form) {
    const f = new FormData(form);
    state.project.checklist.push({ id: uid('chk'), text: f.get('text').toString().trim(), category: f.get('category').toString().trim() || 'General', done: false });
    commit();
    $('[data-form="add-check"] input[name="text"]')?.focus();
  },
  async 'sign-in'(form) {
    const f = new FormData(form);
    try {
      state.cloud = await cloud.signIn({ endpoint: f.get('endpoint'), token: f.get('token'), email: f.get('email') });
      for (const p of await store.listProjects()) await cloud.queueProject(p.id);
      closeSheet();
      render();
      syncNow();
      toast('Signed in — backing up your projects', 'ok');
    } catch (err) { toast(`Sign-in failed: ${err.message}`, 'error'); }
  },
};

// ---------------------------------------------------------------- misc UI

function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.setAttribute('role', 'status');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('out'), 2800);
  setTimeout(() => t.remove(), 3300);
}

function timeAgo(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

// ---------------------------------------------------------------- studio (timeline, camera, song, captions)

const ICONS = {
  back: '<path d="M15 18l-6-6 6-6"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  save: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/>',
  play: '<path d="M7 4l13 8-13 8z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  photos: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M21 16l-5-5-9 8"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  captions: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M7 15h4"/><path d="M15 15h2"/><path d="M7 11h2"/><path d="M13 11h4"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
  close: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
  flip: '<path d="M3 7h13l-3-3"/><path d="M21 17H8l3 3"/>',
  camera: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
};
function icon(name, size = 20) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

const SLOT_SHADES = ['#4b32d6', '#6c4dff', '#8f78ff', '#a996ff'];
const label = (i) => `S${String(i + 1).padStart(2, '0')}`;

// Media (take videos, frames, decoded song) is loaded once and reused until it changes.
let media = null;
let mediaKey = '';
let player = null;
function keyOf(p) {
  return JSON.stringify([p.track?.assetId, p.shots.map((s) => [currentTake(s)?.assetId, s.frameAssetId])]);
}
async function ensureMedia() {
  const p = state.project;
  const k = keyOf(p);
  if (!media || k !== mediaKey) {
    media = await loadMedia(p);
    mediaKey = k;
  } else {
    await loadCaptionFont(p.captions.font);
  }
  return media;
}

function stopPlayback() {
  if (player?.playing) player.stop();
  songPreview?.pause();
  songPreview = null;
  releaseAudio();
}

async function refreshMonitor() {
  const canvas = $('#monitor');
  if (!canvas) return;
  const p = state.project;
  await ensureMedia();
  if (!$('#monitor') || state.project !== p) return;
  player = new TimelinePlayer(p, media, {
    canvas,
    onTime: (t) => updatePlayhead(t),
    onEnd: () => { setPlayIcon(false); updatePlayhead(selStart()); },
  });
  const slot = slotTimes(p)[state.sel];
  if (!slot) { player.draw(0); return; }
  // Show the moment in the slot where its caption is visible, if any.
  let t = slot.start + Math.min(0.6, (slot.end - slot.start) / 2);
  for (let x = slot.start; x < slot.end; x += 0.25) { if (captionAt(p, x)) { t = x + 0.2; break; } }
  if (state.view === 'captions' && !captionAt(p, t)) t = slot.start;
  player.draw(Math.min(t, slot.end - 0.01));
}

const selStart = () => slotTimes(state.project)[state.sel]?.start || 0;

function updatePlayhead(t) {
  const ph = $('#playhead');
  if (ph) ph.style.transform = `translateX(${t * PX_PER_SEC}px)`;
  const tc = $('#tc');
  if (tc) tc.textContent = formatTime(t);
  // While scrubbing/playing, the echo card follows the song moment under the playhead.
  const m = momentAt(t);
  const card = $('#echo-now');
  if (card && m && card.dataset.m !== m.id) card.outerHTML = echoNowHtml(m);
}
function setPlayIcon(on) {
  const b = $('#play-btn');
  if (b) { b.innerHTML = `<span>${icon(on ? 'pause' : 'play', 22)}</span>${on ? 'Pause' : 'Play'}`; b.setAttribute('aria-label', on ? 'Pause' : 'Play timeline'); }
  if (!on) releaseAudio();
}
// Scroll only the timeline strip (never the page) so the selected slot is centred.
function scrollSlotIntoView() {
  const wrap = $('#strip');
  const el = $(`.slot[data-i="${state.sel}"]`);
  if (!wrap || !el) return;
  wrap.scrollLeft = Math.max(0, el.offsetLeft - wrap.clientWidth / 2 + el.offsetWidth / 2);
}

function waveBars(p, total) {
  if (!p.track?.peaks?.length || !total) return '';
  const count = Math.floor((total * PX_PER_SEC) / 5);
  const off = songOffset(p);
  const perSec = p.track.peaks.length / p.track.duration;
  let out = '';
  for (let i = 0; i < count; i += 1) {
    const t = (i / count) * total;
    const v = p.track.peaks[Math.min(p.track.peaks.length - 1, Math.floor((off + t) * perSec))] || 0;
    out += `<i style="height:${4 + Math.round(v * 0.22)}px"></i>`;
  }
  return out;
}

function timelineView() {
  const p = state.project;
  const slots = slotTimes(p);
  const total = totalDuration(p);
  const filled = filledCount(p);
  if (state.sel >= slots.length) state.sel = Math.max(0, slots.length - 1);
  const cur = slots[state.sel];
  const shot = cur?.shot;
  const take = shot && currentTake(shot);
  const c = shot?.camera || {};
  const chips = shot ? [c.lens, c.move, c.fps && `${c.fps} fps`, shot.location].filter(Boolean) : [];

  // Section labels: consecutive shots sharing a section name.
  const groups = [];
  for (const s of slots) {
    const name = s.shot.section || '';
    if (groups.length && groups.at(-1).name === name) groups.at(-1).dur += s.end - s.start;
    else groups.push({ name, dur: s.end - s.start });
  }
  const hasSections = groups.some((g) => g.name);

  // Young-D-Guide: creative markers riding above the slots.
  const moments = momentsFor(p);
  // Short-form edits get denser markers: roughly eight key ideas per video by default.
  const shownMoments = state.allIdeas ? moments : strongest(moments, Math.max(1.5, Math.min(4, total / 8)));
  const markers = shownMoments.filter((m) => m.videoT >= -0.01 && m.videoT < total).map((m) => {
    const mk = markerFor(m, headlineFor(m));
    return `<button class="echo-mark ${m.hero ? 'hero' : ''} ${state.echo?.mid === m.id ? 'on' : ''}" style="left:${m.videoT * PX_PER_SEC}px" data-action="echo-open" data-m="${m.id}" aria-label="${mk.label}${m.lyric ? `: ${esc(m.lyric)}` : ''}">${mk.icon}</button>`;
  }).join('');
  const nowMoment = cur ? (moments.find((m) => m.videoT >= cur.start - 0.01 && m.videoT < cur.end) || null) : null;

  const slotHtml = slots.map((s) => {
    const t = currentTake(s.shot);
    const on = s.index === state.sel;
    const w = Math.max(28, (s.end - s.start) * PX_PER_SEC - 4);
    return `<button class="slot ${t ? 'filled' : 'empty'} ${on ? 'on' : ''}" data-action="select-slot" data-i="${s.index}" style="width:${w}px;${t ? `background:${SLOT_SHADES[s.index % SLOT_SHADES.length]}` : ''}" aria-label="${label(s.index)} ${esc(s.shot.title)}${t ? ', filmed' : ', not filmed'}">
      ${t?.thumbId ? `<img data-asset="${t.thumbId}" alt="">` : ''}
      <span class="slot-l">${label(s.index)}${t ? ' ✓' : ''}</span><span class="slot-d">${(s.end - s.start).toFixed(1).replace(/\.0$/, '')}s</span>
    </button>`;
  }).join('');

  const noShots = !slots.length;
  return `<div class="screen tl">
    <header class="topbar">
      <button class="icon-btn" data-action="home" aria-label="All projects">${icon('back')}</button>
      <div class="grow">
        <h1 class="display title-1">${esc(p.name)}</h1>
        <p class="mono-sub nowrap">${filled}/${slots.length} SHOT${p.artist ? ` · ${esc(p.artist.toUpperCase())}` : ''}${p.offline ? ' · OFFLINE ✓' : ''}</p>
      </div>
      <button class="icon-btn" data-action="go" data-view="plan" aria-label="Plan: shot list, board, direction, checklist">${icon('list')}</button>
      <button class="btn primary sm" data-action="open-save">${icon('save', 18)} Save</button>
    </header>
    <div id="status" class="status"></div>

    <section class="monitor">
      <canvas id="monitor" width="540" height="960" aria-label="Preview"></canvas>
      ${cur ? `<span class="tag ${take ? 'dark' : ''}">${label(cur.index)} · ${take ? `TAKE ${shot.take + 1} OF ${shot.takes.length}` : 'NEXT UP'}</span>
      <span class="tc-chip">${formatTime(cur.start)}</span>` : ''}
    </section>

    ${shot ? `<section class="shot-info">
      <div class="shot-title-row"><h2>${esc(shot.title)}</h2><span class="mono-sub">${shot.durationSec}s</span></div>
      ${shot.description ? `<p class="shot-desc">${esc(shot.description)}</p>` : ''}
      ${shot.echo?.why ? `<p class="shot-why"><b>WHY IT CONNECTS</b> ${esc(shot.echo.why)}</p>` : ''}
      ${nowMoment ? echoNowHtml(nowMoment) : ''}
      <div class="chips">${chips.map((x, i) => `<span class="chip t${i % 4}">${esc(x)}</span>`).join('')}
        <button class="chip ghost" data-action="edit-shot" data-id="${shot.id}">${icon('edit', 14)} Edit</button>
        ${shot.takes.length > 1 ? `<button class="chip ghost" data-action="next-take" data-id="${shot.id}">Use take ${(shot.take + 1) % shot.takes.length + 1}</button>` : ''}
        <button class="chip ghost" data-action="regen-shot" data-id="${shot.id}">${icon('spark', 14)} New idea</button>
      </div>
    </section>` : `<section class="shot-info"><h2>Start with a template</h2><p class="shot-desc">Pick a layout of timed slots, add your song, then shoot straight into each slot.</p></section>`}

    <nav class="tools" aria-label="Edit tools">
      <button class="tool" data-action="go" data-view="song">${icon('music', 16)} ${p.track ? `${p.track.bpm ? `${p.track.bpm} BPM` : 'Song'}` : 'Add song'}</button>
      <button class="tool" data-action="go" data-view="captions">${icon('captions', 16)} ${p.captions.enabled ? 'Captions on' : 'Captions'}</button>
      <button class="tool" data-action="go" data-view="templates">${icon('grid', 16)} Templates</button>
    </nav>

    <section class="dock">
      <div class="transport">
        <span class="mono"><span id="tc">${formatTime(cur?.start || 0)}</span> <span class="muted">/ ${formatTime(total)}</span></span>
        ${moments.length ? `<button class="idea-toggle" data-action="toggle-ideas" aria-pressed="${state.allIdeas}">✦ ${state.allIdeas ? `All ${moments.length} ideas` : `${shownMoments.length} key ideas`}</button>` : ''}
      </div>
      ${noShots ? '<button class="cta small" data-action="go" data-view="templates">PICK A TEMPLATE</button>' : `
      <div class="strip-wrap" id="strip">
        <div class="strip" style="width:${total * PX_PER_SEC + 24}px">
          ${hasSections ? `<div class="sections">${groups.map((g) => `<span style="width:${g.dur * PX_PER_SEC}px">${esc(g.name.toUpperCase())}</span>`).join('')}</div>` : ''}
          ${markers ? `<div class="echo-lane" aria-label="Visual ideas along the song">${markers}</div>` : ''}
          <div class="slots">${slotHtml}</div>
          <div class="wave">${waveBars(p, total) || `<button class="wave-add" data-action="go" data-view="song">${icon('music', 14)} Add your song to cut on the beat</button>`}</div>
          <div class="playhead" id="playhead" style="transform:translateX(${(cur?.start || 0) * PX_PER_SEC}px)"></div>
        </div>
      </div>`}
      <div class="shoot-row">
        <button class="side" id="play-btn" data-action="play" aria-label="Play timeline" ${noShots ? 'disabled' : ''}><span>${icon('play', 22)}</span>Play</button>
        <button class="shoot" data-action="open-camera" ${noShots ? 'disabled' : ''} aria-label="Shoot ${cur ? label(cur.index) : ''}"><span>SHOOT</span></button>
        <button class="side" data-action="slot-from-photos" ${noShots ? 'disabled' : ''}><span>${icon('photos', 22)}</span>From Photos</button>
      </div>
    </section>
  </div>`;
}

function subHeader(title, right = '') {
  return `<header class="topbar">
    <button class="icon-btn" data-action="go" data-view="timeline" aria-label="Back to timeline">${icon('back')}</button>
    <h1 class="display grow title-2">${title}</h1>${right}
  </header>`;
}

function songView() {
  const p = state.project;
  const song = p.track;
  if (!song) {
    return `<div class="screen sub">${subHeader('THE SONG')}
      <div class="empty-card big">
        <span class="empty-icon">${icon('music', 30)}</span>
        <h2>Add your song</h2>
        <p>ReaShoota finds the beat so every cut lands on it, plays the track while you film for lip-sync, and puts the song on your finished video.</p>
        <button class="btn primary big" data-action="add-song">CHOOSE SONG FILE</button>
        <p class="hint">MP3, M4A or WAV — from Files, iCloud Drive or a voice memo.</p>
      </div>
      ${lyricsBlock(p)}
    </div>`;
  }
  const { start, end } = song.range;
  const bars = song.peaks.filter((_, i) => i % Math.ceil(song.peaks.length / 110) === 0);
  const wave = bars.map((v, i) => {
    const t = (i / bars.length) * song.duration;
    return `<i class="${t >= start && t < end ? 'in' : ''}" style="height:${5 + Math.round(v * 0.34)}px"></i>`;
  }).join('');
  const len = end - start;
  const modes = [
    ['full', 'Full', formatTime(song.duration, { tenths: false })],
    ['best30', 'Best 30s', '0:30'],
    ['hook15', 'Hook', '0:15'],
    ['custom', 'Custom', formatTime(len, { tenths: false })],
  ];
  const mode = song.mode || 'full';
  return `<div class="screen sub">${subHeader('THE SONG', '<button class="btn ghost sm" data-action="add-song">Replace</button>')}
    <section class="card song-card">
      <div class="row">
        <button class="round big" id="song-play" data-action="song-preview" aria-label="Play song">${icon('play', 18)}</button>
        <div class="grow"><b class="song-name">${esc(song.name)}</b>
          <p class="mono-sub">${esc((p.artist || '').toUpperCase())}${p.artist ? ' · ' : ''}${formatTime(song.duration, { tenths: false })}${song.bpm ? ` · ${song.bpm} BPM FOUND` : ''}</p></div>
      </div>
      <div class="song-wave">${wave}</div>
      <p class="mono-sub">USING ${formatTime(start)} – ${formatTime(end)} (${len.toFixed(1)}s)</p>
    </section>
    <p class="eyebrow">USE FOR THIS VIDEO</p>
    <div class="grid4">${modes.map(([id, l, d]) => `<button class="pick ${mode === id ? 'on' : ''}" data-action="song-range" data-mode="${id}">${l}<br><small>${d}</small></button>`).join('')}</div>
    ${mode === 'custom' ? `<div class="card range">
      <label>Start <input type="range" min="0" max="${song.duration.toFixed(1)}" step="0.5" value="${start}" data-range="start"> <span class="mono" id="r-start">${formatTime(start)}</span></label>
      <label>End <input type="range" min="0" max="${song.duration.toFixed(1)}" step="0.5" value="${end}" data-range="end"> <span class="mono" id="r-end">${formatTime(end)}</span></label>
    </div>` : ''}
    ${lyricsBlock(p)}
    <div class="bottom-actions">
      <button class="btn" data-action="lyric-sync" ${p.lyrics.length ? '' : 'disabled'}>Tap to sync</button>
      <button class="btn primary big grow" data-action="beat-slots" ${song.bpm ? '' : 'disabled'}>BUILD SLOTS ON THE BEAT</button>
    </div>
  </div>`;
}

function lyricsBlock(p) {
  const times = p.lyricTimes || [];
  const timed = p.lyrics.filter((_, i) => Number.isFinite(times[i])).length;
  return `<div class="row between"><p class="eyebrow">LYRICS${p.lyrics.length ? ` · ${timed} OF ${p.lyrics.length} TIMED` : ''}</p>
      <button class="link-btn" data-action="edit-lyrics">${p.lyrics.length ? 'Edit' : 'Paste lyrics'}</button></div>
    ${p.lyrics.length ? `<div class="card lyric-list">${p.lyrics.map((l, i) => `<div class="lyric"><span class="mono">${Number.isFinite(times[i]) ? formatTime(times[i], { tenths: false }) : '--:--'}</span><span>${esc(l)}</span></div>`).join('')}</div>`
    : `<form class="card lyric-paste" data-form="lyrics">
        <label class="sr" for="lyrics-inline">Lyrics</label>
        <textarea id="lyrics-inline" name="lyrics" rows="6" placeholder="Tap here and paste your lyrics — one line per line. They become captions and give every shot its idea."></textarea>
        <button class="btn primary">Save lyrics</button>
      </form>`}`;
}

function captionsView() {
  const p = state.project;
  const cs = p.captions;
  return `<div class="screen sub">${subHeader('CAPTIONS', '<button class="btn primary sm" data-action="go" data-view="timeline">Done</button>')}
    <section class="monitor cap-monitor"><canvas id="monitor" width="540" height="960" aria-label="Caption preview"></canvas>
      <span class="tc-chip">${label(state.sel)}</span></section>
    <div class="seg">
      <button class="${cs.source !== 'speech' ? 'on' : ''}" data-action="cap-source" data-v="lyrics">Song lyrics</button>
      <button class="${cs.source === 'speech' ? 'on' : ''}" data-action="cap-source" data-v="speech">Speech in clips</button>
    </div>
    <p class="hint-line">${cs.source === 'speech'
    ? 'Transcribing speech needs the ReaShoota server, which isn’t set up yet — lyrics captions work now.'
    : p.lyrics.length ? `From your lyrics, ${(p.lyricTimes || []).some(Number.isFinite) ? 'timed to the song' : 'timed to each slot (tap-to-sync on the Song screen for exact timing)'}. Works offline.` : 'Add lyrics on the Song screen, or a lyric to each shot.'}</p>
    <p class="eyebrow">STYLE</p>
    <div class="grid4">${CAPTION_STYLES.map((st, i) => `<button class="pick style-pick s${i} ${cs.style === st.id ? 'on' : ''}" data-action="cap-style" data-v="${st.id}"><b>Aa</b><small>${st.label}</small></button>`).join('')}</div>
    <p class="eyebrow">FONT</p>
    <div class="grid3">${CAPTION_FONTS.map((f) => `<button class="pick font-pick ${cs.font === f.id ? 'on' : ''}" data-action="cap-font" data-v="${esc(f.id)}" style="font-family:${esc(f.css)}">${f.label}</button>`).join('')}</div>
    <div class="bottom-actions">
      <button class="btn" data-action="edit-lyrics">Edit words</button>
      <button class="btn primary big grow" data-action="cap-toggle">${cs.enabled ? 'TURN CAPTIONS OFF' : `CAPTION ALL ${p.shots.length} SLOTS`}</button>
    </div>
  </div>`;
}

function templatesView() {
  const p = state.project;
  const pastel = ['#8f78ff', '#b6a8ff', '#cfc5ff', '#a996ff', '#dcd4ff'];
  const cards = TEMPLATES.map((t) => {
    const on = state.tpl === t.id;
    return `<button class="tpl ${on ? 'on' : ''}" data-action="pick-tpl" data-id="${t.id}">
      <span class="tpl-head"><b>${t.name}</b><span class="mono-sub">${t.meta.toUpperCase()}</span></span>
      <span class="fx-row">${(t.fx || []).map((x) => `<span class="fx">${FX_LABELS[x]}</span>`).join('')}</span>
      <span class="tpl-bars">${t.slots.map((d, i) => `<i style="flex-grow:${d};background:${on ? (i % 2 ? '#a996ff' : '#6c4dff') : pastel[i % pastel.length]}"></i>`).join('')}</span>
    </button>`;
  }).join('');
  const tpl = TEMPLATES.find((t) => t.id === state.tpl);
  return `<div class="screen sub">${subHeader('PICK A<br>TEMPLATE')}
    <p class="lead-sm">Slots are timed to the song${p.track?.bpm ? ` (${p.track.bpm} BPM)` : ''}. Shoot into each one, or drop in clips you already have.</p>
    <div class="stack">${cards}</div>
    <button class="card info-row" data-action="auto-fill">
      <span class="info-icon">${icon('plus', 22)}</span>
      <span><b>Already filmed?</b> Pick clips from Photos — they fill the empty slots in order, trimmed to fit.</span>
    </button>
    <div class="bottom-actions"><button class="btn primary big grow" data-action="use-tpl">USE “${esc(tpl.name.toUpperCase())}”</button></div>
  </div>`;
}

// ---- save sheet (the "Your cut is ready" design) ----

function openSaveSheet() {
  const p = state.project;
  const filled = filledCount(p);
  const firstThumb = p.shots.map((s) => currentTake(s)?.thumbId).find(Boolean);
  openSheet(`<div class="cut-head">
      <div class="cut-thumb">${firstThumb ? `<img data-asset="${firstThumb}" alt="">` : ''}${icon('play', 26)}</div>
      <div><h2 class="display">${filled ? 'YOUR CUT' : 'NOTHING<br>FILMED YET'}</h2>
        <p class="mono-sub">${formatTime(totalDuration(p), { tenths: false })} · 1080×1920 · ${filled}/${p.shots.length} SLOTS</p>
        <p class="small muted">${p.track ? 'Song synced' : 'No song yet'} · captions ${p.captions.enabled ? 'on' : 'off'}</p></div>
    </div>
    <button class="btn primary big" data-action="make-video" ${filled ? '' : 'disabled'}>${icon('save', 18)} MAKE VIDEO & SAVE TO PHOTOS</button>
    <p class="hint">Rendering plays your cut once in real time — keep the screen on. Then choose <b>Save Video</b> in the share sheet.${filled && filled < p.shots.length ? ` <b>${p.shots.length - filled} unfilmed slot${p.shots.length - filled === 1 ? '' : 's'}</b> will reuse your nearest clip.` : ''}</p>
    <p class="eyebrow">ALSO SAVE</p>
    <div class="card rows">
      ${[
    ['Shoot pack', 'PDF · shots, camera, locations, checklist', 'Save', 'quick-export', 'shoot', 'pdf'],
    ['Storyboard', 'PDF or images to Photos', 'Save', 'quick-export', 'storyboard', 'pdf'],
    ['Shot list', 'Text for WhatsApp or Notes', 'Copy', 'copy', 'shotlist', ''],
    ['Every clip', `${p.shots.reduce((n, s) => n + s.takes.length, 0)} takes, original quality`, 'Save', 'quick-export', 'clips', 'video'],
    ['Storyboard animatic', '9:16 video of your frames', 'Make', 'quick-export', 'animatic', 'video'],
    ['Everything else', 'Deck, direction, lyrics map, backup…', 'Open', 'all-exports', '', ''],
  ].map(([n, m, a, act, id, fmt]) => `<div class="row-item"><div class="grow"><b>${n}</b><small>${m}</small></div>
        <button class="btn sm ghost" data-action="${act}" data-export="${id}" data-kind="${id}" data-format="${fmt}">${a}</button></div>`).join('')}
    </div>
    <button class="btn ghost" data-action="close-sheet">Close</button>`);
}

// ---- takes ----

async function storeTake(shot, blob, { mime, name, dur } = {}) {
  const id = uid('take');
  const type = mime || blob.type || 'video/mp4';
  let thumbId = null;
  let duration = dur || 0;
  try {
    const th = await videoThumb(blob);
    thumbId = uid('thumb');
    duration = duration || th.duration;
    await store.putAsset({ id: thumbId, kind: 'thumb', name: `${id}.jpg`, mime: 'image/jpeg', blob: th.blob, createdAt: new Date().toISOString() });
  } catch { thumbId = null; }
  await store.putAsset({ id, kind: 'take', name: name || `${id}.${type.includes('mp4') ? 'mp4' : type.includes('quicktime') ? 'mov' : 'webm'}`, mime: type, blob, createdAt: new Date().toISOString() });
  shot.takes.push({ assetId: id, thumbId, at: new Date().toISOString(), dur: duration });
  shot.take = shot.takes.length - 1;
  shot.status = 'done';
  shot.completedAt = new Date().toISOString();
  return id;
}

function nextEmptySlot(from = 0) {
  const shots = state.project.shots;
  for (let k = 1; k <= shots.length; k += 1) {
    const i = (from + k) % shots.length;
    if (!shots[i].takes.length) return i;
  }
  return Math.min(from + 1, shots.length - 1);
}

// ---- Young-D-Guide: the timeline as creative director ----

let momentsCache = { key: '', list: [], heads: new Map() };
function momentsFor(p) {
  const key = JSON.stringify([p.lyrics, p.lyricTimes, p.track?.range, p.track?.assetId, p.shots.map((s) => [s.durationSec, s.lyric])]);
  if (momentsCache.key !== key) momentsCache = { key, list: buildMoments(p), heads: new Map() };
  return momentsCache.list;
}
function echoOpts(extra = {}) {
  const p = state.project;
  return { weirdness: p.echoSettings.weirdness, world: p.direction.motifs || [], ...extra };
}
function headlineFor(m) {
  const k = `${m.id}|${state.project.echoSettings.weirdness}|${(state.project.direction.motifs || []).join()}`;
  if (!momentsCache.heads.has(k)) momentsCache.heads.set(k, suggest(m, echoOpts()).headline);
  return momentsCache.heads.get(k);
}
function momentAt(t) {
  const list = momentsFor(state.project);
  let best = null;
  for (const m of list) if (m.videoT <= t + 0.05) best = m;
  return best;
}

function echoNowHtml(m) {
  const idea = headlineFor(m);
  if (!idea) return '';
  const mk = markerFor(m, idea);
  return `<button class="echo-now" id="echo-now" data-m="${m.id}" data-action="echo-open">
    <span class="echo-ic" aria-hidden="true">${mk.icon}</span>
    <span class="grow"><small>VISUAL ECHO · ${formatTime(m.t, { tenths: false })}${m.lyric ? ` · “${esc(m.lyric.length > 38 ? `${m.lyric.slice(0, 36)}…` : m.lyric)}”` : ` · ${esc(mk.label.toUpperCase())}`}</small>
      <b>${esc(idea.text)}</b></span>
    <span class="echo-go" aria-hidden="true">›</span>
  </button>`;
}

const LEVEL_LABEL = ['SAFE', 'STRANGE', 'UNHINGED'];
const KIND_LABEL_ECHO = { lyric: 'LYRIC', bass: 'BASS HIT', pause: 'BEAT PAUSE', switch: 'BEAT SWITCH', chorus: 'CHORUS', adlib: 'AD-LIB' };

function ideaCard(idea, { dirLabel, icon: ic, hero = false, canSpin = true } = {}) {
  const st = state.echo;
  const tagLine = [idea.tags.includes('cheap') && 'cheap', idea.tags.includes('solo') && 'solo', idea.tags.includes('crew') && 'needs crew', (idea.dir === 'hybrid' || idea.tags.includes('ai')) && 'AI / compositing'].filter(Boolean);
  const more = st.more === idea.id ? moreLike(idea, { exclude: [idea.id], world: state.project.direction.motifs || [], seed: st.seed }) : null;
  return `<article class="idea ${hero ? 'idea-hero' : ''}">
    <p class="idea-kicker">${hero ? `<span class="spark">${ic}</span> VISUAL ECHO` : `<span class="spark">${ic}</span> ${esc(dirLabel.toUpperCase())}`}<span class="lvl l${idea.level}">${LEVEL_LABEL[idea.level]}</span></p>
    <h3>${esc(idea.text)}</h3>
    <p class="why"><b>Why it connects</b> ${esc(idea.why)}</p>
    ${tagLine.length ? `<p class="idea-tags">${tagLine.map((t) => `<span>${esc(t)}</span>`).join('')}</p>` : ''}
    <div class="idea-actions">
      <button class="btn primary sm" data-action="echo-use" data-id="${idea.id}">USE THIS</button>
      <button class="btn sm ghost" data-action="echo-more" data-id="${idea.id}">${more ? 'Less' : 'More like this'}</button>
      ${canSpin ? `<button class="btn sm ghost" data-action="echo-respin" data-id="${idea.id}" aria-label="Spin again">↻ Spin</button>` : ''}
    </div>
    ${more ? `<div class="more-list">${more.map((o) => `<div class="more-item"><p>${esc(o.text)}</p><small>${esc(o.why)}</small>
      <button class="btn sm" data-action="echo-use" data-id="${o.id}">USE THIS</button></div>`).join('')}</div>` : ''}
  </article>`;
}

function echoSheetHtml() {
  const p = state.project;
  const st = state.echo;
  const list = momentsFor(p);
  const i = list.findIndex((m) => m.id === st.mid);
  const m = list[i];
  if (!m) return '<p>That moment is no longer on the timeline.</p>';
  const r = suggest(m, echoOpts({ modifiers: st.mods, seed: st.seed, exclude: st.exclude }));
  // Remember everything shown for this moment so SPIN never serves it again.
  for (const d of r.directions) if (!st.seen.includes(d.idea.id)) st.seen.push(d.idea.id);
  const mk = markerFor(m, r.headline);
  const w = p.echoSettings.weirdness;
  const world = p.direction.motifs || [];
  const others = r.directions.filter((d) => d.idea.id !== r.headline?.id);
  return `<div class="echo">
    <div class="echo-head">
      <button class="icon-btn" data-action="echo-nav" data-dir="-1" ${i <= 0 ? 'disabled' : ''} aria-label="Previous moment">${icon('back')}</button>
      <div class="grow">
        <p class="eyebrow">YOUNG-D-GUIDE · ${mk.icon} ${KIND_LABEL_ECHO[m.kind] || 'MOMENT'}${m.sonic ? ` + ${KIND_LABEL_ECHO[m.sonic]}` : ''}${m.hero ? ' · HERO' : ''}</p>
        <p class="echo-time mono">${formatTime(m.t)} ─── ${formatTime(m.end)}</p>
      </div>
      <button class="icon-btn flip-x" data-action="echo-nav" data-dir="1" ${i >= list.length - 1 ? 'disabled' : ''} aria-label="Next moment">${icon('back')}</button>
    </div>
    ${m.lyric ? `<p class="echo-lyric">“${esc(r.bridge.says)}”</p>` : `<p class="echo-lyric sonic">${esc(r.bridge.says)}</p>`}
    <div class="chain" aria-label="Association chain">
      <span><small>MEANS</small>${esc(r.bridge.means)}</span>
      <span><small>FEELS</small>${esc(r.bridge.feels)}</span>
      <span><small>WORLD</small>${esc((world.length ? world : r.bridge.motifs).join(' · '))}</span>
    </div>
    <div class="weird-seg" role="radiogroup" aria-label="Creative weirdness">
      ${WEIRDNESS.map((lab, k) => `<button role="radio" aria-checked="${w === k}" class="${w === k ? 'on' : ''}" data-action="echo-weird" data-v="${k}">${lab.toUpperCase()}</button>`).join('<i></i>')}
    </div>
    ${r.headline ? ideaCard(r.headline, { hero: true, icon: mk.icon }) : ''}
    <p class="eyebrow">MORE WAYS TO SHOOT THIS MOMENT</p>
    ${others.map((d) => ideaCard(d.idea, { dirLabel: d.label, icon: d.icon })).join('')}
    <section class="spin-box">
      <p class="eyebrow">SPIN THIS MOMENT</p>
      <div class="mod-chips">${MODIFIERS.map((mo) => `<button class="mod ${st.mods.includes(mo.id) ? 'on' : ''}" aria-pressed="${st.mods.includes(mo.id)}" data-action="echo-mod" data-v="${mo.id}">${mo.label}</button>`).join('')}</div>
      <button class="btn primary big" data-action="echo-spin">↻ SPIN THIS MOMENT</button>
    </section>
    <section class="world-box">
      <p class="eyebrow">VISUAL WORLD — IDEAS STAY INSIDE IT</p>
      <div class="mod-chips">${MOTIFS.map((mo) => `<button class="mod ${world.includes(mo) ? 'on' : ''}" aria-pressed="${world.includes(mo)}" data-action="echo-world" data-v="${mo}">${mo}</button>`).join('')}</div>
    </section>
    <button class="btn ghost" data-action="close-sheet">Close</button>
  </div>`;
}

function renderEcho({ keepScroll = true } = {}) {
  const sheet = $('.sheet');
  if (sheet?.dataset.echo) {
    const y = sheet.scrollTop;
    sheet.innerHTML = echoSheetHtml();
    if (keepScroll) sheet.scrollTop = y; else sheet.scrollTop = 0;
    return;
  }
  const wrap = openSheet(echoSheetHtml(), {
    onClose: () => {
      state.echo = null;
      // Markers and the echo card reflect any slider/world change made in the sheet.
      setTimeout(() => { if (state.project && !$('.sheet-wrap')) render(); }, 0);
    },
  });
  wrap.querySelector('.sheet').dataset.echo = '1';
  wrap.querySelector('.sheet').classList.add('tall');
}

function currentEchoMoment() {
  return momentsFor(state.project).find((m) => m.id === state.echo?.mid) || null;
}

// Short, capture-time instructions: never a paragraph while the camera is up.
function directorCard(p, slot, st) {
  const shot = slot.shot;
  const e = shot.echo;
  const lens = (shot.camera.lens || st.lens || '').replace(/x\b/, '×');
  const cam = e
    ? [lens, e.position, e.move].filter(Boolean).join(' · ')
    : [lens, shot.camera.move, `${shot.camera.fps || st.fps} fps`].filter(Boolean).join(' · ');
  const steps = e?.howTo?.slice(0, 3) || (shot.description ? [shot.description] : []);
  return `<div class="glass cam-dir director">
    <p class="mono-tag">SHOT ${String(slot.index + 1).padStart(2, '0')} · ${formatTime(slot.start, { tenths: false })}–${formatTime(slot.end, { tenths: false })}</p>
    ${shot.lyric ? `<p class="cam-lyric">“${esc(shot.lyric)}”</p>` : ''}
    ${steps.length ? `<p class="mono-tag dim">DO THIS</p><ul>${steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    <div class="dir-row"><span><small>CAMERA</small>${esc(cam)}</span><span><small>DURATION</small>${(slot.end - slot.start).toFixed(1).replace(/\.0$/, '')} sec</span></div>
  </div>`;
}

Object.assign(handlers, {
  'echo-open'(el) {
    state.echo = { mid: el.dataset.m, seed: 0, mods: [], exclude: [], seen: [], more: null };
    stopPlayback();
    renderEcho({ keepScroll: false });
  },
  'echo-nav'(el) {
    const list = momentsFor(state.project);
    const i = list.findIndex((m) => m.id === state.echo.mid) + Number(el.dataset.dir);
    if (!list[i]) return;
    state.echo = { ...state.echo, mid: list[i].id, exclude: [], seen: [], more: null };
    renderEcho({ keepScroll: false });
  },
  'echo-weird'(el) {
    state.project.echoSettings.weirdness = Number(el.dataset.v);
    state.echo.exclude = [];
    commit({ render: false });
    renderEcho();
  },
  'echo-mod'(el) {
    const v = el.dataset.v;
    const mods = state.echo.mods;
    state.echo.mods = mods.includes(v) ? mods.filter((x) => x !== v) : [...mods, v];
    state.echo.exclude = [];
    renderEcho();
  },
  'echo-spin'() {
    state.echo.seed += 1;
    state.echo.exclude = state.echo.seen.slice(-60);
    state.echo.more = null;
    renderEcho({ keepScroll: false });
  },
  'echo-respin'(el) {
    state.echo.exclude = [...state.echo.exclude, el.dataset.id];
    state.echo.more = null;
    renderEcho();
  },
  'echo-more'(el) {
    state.echo.more = state.echo.more === el.dataset.id ? null : el.dataset.id;
    renderEcho();
  },
  'echo-world'(el) {
    const d = state.project.direction;
    d.motifs = d.motifs || [];
    d.motifs = d.motifs.includes(el.dataset.v) ? d.motifs.filter((x) => x !== el.dataset.v) : [...d.motifs, el.dataset.v];
    commit({ render: false });
    renderEcho();
  },
  'echo-use'(el) {
    const m = currentEchoMoment();
    const idea = getIdea(el.dataset.id);
    if (!m || !idea) return;
    const idx = applyIdea(state.project, m, idea, createShot);
    state.sel = idx;
    state.echo = null;
    closeSheet();
    commit();
    toast(`${label(idx)} planned ✦ — undo from Plan › Shots`, 'ok');
  },
  'toggle-ideas'() { state.allIdeas = !state.allIdeas; render(); },
  'backup-info'() {
    const list = state.projects;
    openSheet(`<h2>Back up your videos</h2>
      <p class="small muted">Everything is saved on this phone automatically. To keep a copy somewhere else, save a backup file to Files or iCloud Drive — open it on any phone with <b>Import backup</b>. Account sign-in is coming later.</p>
      <div class="stack">${list.map((pr) => `<button class="btn" data-action="home-export" data-id="${pr.id}" data-export="backup" data-format="json">Save “${esc(pr.name)}” backup</button>`).join('') || '<p class="muted">No projects yet.</p>'}</div>
      <button class="btn ghost" data-action="close-sheet">Close</button>`);
  },
});

// ---- camera overlay ----

const cam = { stream: null, facing: 'environment', busy: false, abort: null };

function camOverlayHtml() {
  const p = state.project;
  const slots = slotTimes(p);
  const s = slots[state.sel];
  const shot = s.shot;
  const st = p.shootSettings;
  return `<video class="cam-feed" id="cam-feed" playsinline muted autoplay></video>
    <div class="cam-grid"><i></i><i></i><i></i><i></i></div>
    <div class="cam-top">
      <button class="cam-done glass" data-action="cam-close">${icon('back', 18)} Editor</button>
      <div class="glass cam-info"><span class="mono-tag">${label(s.index)} · SLOT ${(s.end - s.start).toFixed(1)}s · TAKE ${shot.takes.length + 1}</span><b>${esc(shot.title)}</b></div>
    </div>
    <div class="cam-count" id="cam-count" aria-live="assertive"></div>
    ${directorCard(p, s, st)}
    <div class="cam-bottom">
      <div class="cam-progress">${slots.map((x) => `<i style="flex-grow:${x.end - x.start}" class="${x.index === s.index ? 'cur' : currentTake(x.shot) ? 'done' : ''}">${x.index === s.index ? '<b id="cam-fill"></b>' : ''}</i>`).join('')}</div>
      <div class="cam-controls">
        <button class="cam-side" data-action="cam-native">iPhone<br>camera</button>
        <span class="rec-wrap"><button class="rec" id="rec-btn" data-action="cam-record" aria-label="Start countdown and record ${label(s.index)}"><span></span></button><small class="rec-label">START COUNTDOWN</small></span>
        <button class="cam-side" data-action="cam-flip" aria-label="Switch camera">${icon('flip', 22)}</button>
      </div>
    </div>`;
}

async function openCameraView() {
  let el = $('.cam');
  if (!el) {
    el = document.createElement('div');
    el.className = 'cam';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Camera');
    document.body.appendChild(el);
    document.body.classList.add('sheet-open');
  }
  el.innerHTML = camOverlayHtml();
  if (!cameraSupported()) {
    $('#cam-count').innerHTML = '<small>Live camera isn’t available here — use iPhone camera.</small>';
    return;
  }
  try {
    if (!cam.stream) cam.stream = await openCamera(cam.facing);
    const v = $('#cam-feed');
    v.srcObject = cam.stream;
    v.classList.toggle('mirror', cam.facing === 'user');
    await v.play().catch(() => {});
  } catch (err) {
    $('#cam-count').innerHTML = `<small>Camera blocked (${esc(err.name || err.message)}). Allow camera access in Settings › Safari, or use iPhone camera.</small>`;
  }
}

function closeCameraView() {
  cam.abort?.abort();
  closeCamera(cam.stream);
  cam.stream = null;
  $('.cam')?.remove();
  document.body.classList.remove('sheet-open');
  commit();
}

async function camRecord() {
  if (cam.busy) { cam.abort?.abort(); return; }
  if (!cam.stream) { toast('Camera isn’t on — use iPhone camera instead', 'error'); return; }
  const p = state.project;
  const slot = slotTimes(p)[state.sel];
  const shot = slot.shot;
  // Audio must be unlocked inside this tap (iOS).
  unlockAudio();
  cam.busy = true;
  cam.abort = new AbortController();
  const btn = $('#rec-btn');
  btn.classList.add('armed');
  const countEl = $('#cam-count');
  const n = Number(p.shootSettings.countdownSec) || 0;
  // Song plays through the countdown so the artist can come in on time (started in the tap).
  const songEl = p.track && songEls.get(p.track.assetId);
  let song = null;
  if (songEl) {
    songEl.currentTime = Math.max(0, songOffset(p) + slot.start - n);
    songEl.play().catch(() => {});
    song = { stop: () => songEl.pause() };
  } else if (p.track) {
    const m = await ensureMedia();
    if (m.song) song = playSong(m.song, Math.max(0, songOffset(p) + slot.start - n), songOffset(p) + slot.end);
  }
  try {
    for (let i = n; i > 0; i -= 1) {
      if (cam.abort.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      countEl.textContent = i;
      navigator.vibrate?.(40);
      await new Promise((r) => { setTimeout(r, 1000); });
    }
    if (cam.abort.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    countEl.textContent = '';
    btn.classList.add('rolling');
    const dur = slot.end - slot.start;
    const fill = $('#cam-fill');
    const res = await recordTake(cam.stream, dur, {
      signal: cam.abort.signal,
      onTick: (el) => { if (fill) fill.style.width = `${(el / dur) * 100}%`; },
    });
    if (cam.abort.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    countEl.innerHTML = '<small>Saving take…</small>';
    await storeTake(shot, res.blob, { mime: res.type, dur: res.dur });
    commit({ render: false });
    toast(`Take saved to ${label(state.sel)}`, 'ok');
    afterTake();
  } catch (err) {
    if (err.name !== 'AbortError') toast(err.message, 'error');
    else if (countEl) countEl.textContent = '';
    btn?.classList.remove('armed', 'rolling');
  } finally {
    song?.stop();
    cam.busy = false;
  }
}

// Next empty slot, or the wrap screen once every slot has a take.
function afterTake() {
  const p = state.project;
  if (p.shots.every((s) => s.takes.length)) { showWrap(); return; }
  state.sel = nextEmptySlot(state.sel);
  persistSession();
  openCameraView();
}

function showWrap() {
  const p = state.project;
  const el = $('.cam');
  if (!el) return;
  closeCamera(cam.stream);
  cam.stream = null;
  el.innerHTML = `<div class="wrap-screen">
    <span class="wrap-badge" aria-hidden="true">✓</span>
    <p class="eyebrow">ALL ${p.shots.length} SLOTS FILMED</p>
    <h2 class="display">THAT’S A WRAP</h2>
    <p class="wrap-sub">Every slot has a take. Watch the edit, swap any take, or make the final video.</p>
    <button class="btn primary big" data-action="wrap-editor">BACK TO EDITOR</button>
    <button class="btn big" data-action="wrap-make">MAKE VIDEO</button>
  </div>`;
  navigator.vibrate?.([60, 60, 120]);
}

let songPreview = null;
let syncState = null;

// A ready-to-play <audio> for the song, created before the tap (iOS needs play() in the tap).
const songEls = new Map();
async function prepareSongEl() {
  const id = state.project?.track?.assetId;
  if (!id || songEls.has(id)) return;
  const a = await store.getAsset(id);
  if (!a) return;
  const el = new Audio(URL.createObjectURL(a.blob));
  el.preload = 'auto';
  el.setAttribute('playsinline', '');
  songEls.set(id, el);
}

// ---- handlers ----

Object.assign(handlers, {
  go(el) {
    state.view = el.dataset.view;
    render();
    window.scrollTo(0, 0);
    persistSession();
  },
  'select-slot'(el) {
    state.sel = Number(el.dataset.i);
    render();
    persistSession();
  },
  play() {
    if (player?.playing) { player.stop(); setPlayIcon(false); return; }
    unlockAudio();
    setPlayIcon(true);
    // iPhones only allow sound that starts inside the tap, so start now if media is ready.
    if (media && player && keyOf(state.project) === mediaKey) {
      player.media = media;
      player.play(selStart());
      return;
    }
    ensureMedia().then(() => {
      if (!player) return;
      player.media = media;
      player.play(selStart());
    });
  },
  'open-save': openSaveSheet,
  'make-video'() {
    unlockAudio();
    runExport(state.project, 'final', 'video');
  },
  'all-exports'() { closeSheet(); state.view = 'plan'; state.tab = 'export'; render(); },
  'open-camera'() {
    unlockAudio();
    openCameraView();
  },
  'cam-close': closeCameraView,
  'wrap-editor'() { state.sel = 0; closeCameraView(); window.scrollTo(0, 0); },
  'wrap-make'() { unlockAudio(); closeCameraView(); openSaveSheet(); },
  'cam-record': camRecord,
  async 'cam-flip'() {
    if (cam.busy) return;
    cam.facing = cam.facing === 'environment' ? 'user' : 'environment';
    closeCamera(cam.stream);
    cam.stream = null;
    openCameraView();
  },
  async 'cam-native'() {
    if (cam.busy) return;
    const [file] = await pickFile('video/*', { capture: 'environment' });
    if (!file) return;
    const shot = state.project.shots[state.sel];
    await storeTake(shot, file, { name: file.name });
    commit({ render: false });
    toast(`Take saved to ${label(state.sel)}`, 'ok');
    afterTake();
  },
  async 'slot-from-photos'() {
    const [file] = await pickFile('video/*');
    if (!file) return;
    const busy = busySheet('Adding clip…');
    const shot = state.project.shots[state.sel];
    await storeTake(shot, file, { name: file.name });
    closeSheet();
    busy.progress(1);
    commit();
    toast(`Clip added to ${label(state.sel)}`, 'ok');
  },
  'next-take'(el) {
    const s = findShot(state.project, el.dataset.id);
    s.take = (s.take + 1) % s.takes.length;
    commit();
  },
  'pick-tpl'(el) { state.tpl = el.dataset.id; render(); },
  'use-tpl'() {
    const p = state.project;
    const filled = filledCount(p);
    if (filled && !window.confirm(`Replace your ${p.shots.length} slots? The ${filled} filmed take${filled === 1 ? '' : 's'} will be removed from the timeline.`)) return;
    applyTemplate(p, state.tpl);
    fillSlotIdeas(p, { weirdness: p.echoSettings.weirdness });
    state.sel = 0;
    state.view = 'timeline';
    commit();
    toast(`${p.shots.length} slots, each with a shot idea${p.track?.bpm ? ` · snapped to ${p.track.bpm} BPM` : ''}`, 'ok');
  },
  async 'auto-fill'() {
    const files = await pickFile('video/*', { multiple: true });
    if (!files.length) return;
    const p = state.project;
    if (!p.shots.length) applyTemplate(p, state.tpl);
    const busy = busySheet(`Adding ${files.length} clip${files.length === 1 ? '' : 's'}…`);
    const targets = autoFillTargets(p, files.length);
    for (let i = 0; i < files.length; i += 1) {
      await storeTake(p.shots[targets[i]], files[i], { name: files[i].name });
      busy.progress((i + 1) / files.length);
    }
    closeSheet();
    state.sel = targets[0];
    state.view = 'timeline';
    commit();
    toast(`${files.length} clip${files.length === 1 ? '' : 's'} dropped into slots`, 'ok');
  },
  async 'add-song'() {
    const [file] = await pickFile('audio/*,.mp3,.m4a,.wav,.aac');
    if (!file) return;
    const busy = busySheet('Reading your song…');
    busy.note('Finding the beat and drawing the waveform.');
    try {
      const id = uid('song');
      await store.putAsset({ id, kind: 'song', name: file.name, mime: file.type || 'audio/mpeg', blob: file, createdAt: new Date().toISOString() });
      const buf = await decodeSong(file, id);
      busy.progress(0.6);
      const a = analyse(buf);
      const p = state.project;
      p.assets.push({ id, kind: 'song', name: file.name, mime: file.type || 'audio/mpeg', size: file.size, createdAt: new Date().toISOString() });
      const best = a.duration > 45 ? loudestWindow(a.peaks, a.duration, 30) : 0;
      p.track = {
        assetId: id, name: file.name.replace(/\.[^.]+$/, ''), duration: a.duration, bpm: a.bpm, peaks: a.peaks,
        mode: a.duration > 45 ? 'best30' : 'full',
        range: a.duration > 45 ? { start: best, end: Math.min(a.duration, best + 30) } : { start: 0, end: a.duration },
      };
      closeSheet();
      commit();
      toast(a.bpm ? `${a.bpm} BPM found` : 'Song added', 'ok');
    } catch (err) {
      closeSheet();
      toast(`Couldn’t read that file (${err.message}). Try an MP3 or M4A.`, 'error');
    }
  },
  'song-range'(el) {
    const s = state.project.track;
    const mode = el.dataset.mode;
    s.mode = mode;
    if (mode === 'full') s.range = { start: 0, end: s.duration };
    if (mode === 'best30' || mode === 'hook15') {
      const len = mode === 'best30' ? 30 : 15;
      const st = loudestWindow(s.peaks, s.duration, len);
      s.range = { start: st, end: Math.min(s.duration, st + len) };
    }
    commit();
  },
  'song-preview'() {
    const btn = $('#song-play');
    if (songPreview) { songPreview.pause(); songPreview = null; releaseAudio(); btn.innerHTML = icon('play', 18); return; }
    unlockAudio();
    const el = songEls.get(state.project.track.assetId);
    if (!el) { toast('Song is still loading — tap again in a second', 'error'); prepareSongEl(); return; }
    const { start: from, end: to } = state.project.track.range;
    el.currentTime = from;
    el.play().then(() => { btn.innerHTML = icon('pause', 18); }).catch((err) => toast(`Can’t play the song: ${err.message}`, 'error'));
    songPreview = el;
    el.ontimeupdate = () => {
      if (el.currentTime >= to) { el.pause(); songPreview = null; releaseAudio(); const b = $('#song-play'); if (b) b.innerHTML = icon('play', 18); }
    };
  },
  'beat-slots'() {
    const hadShots = state.project.shots.length;
    buildBeatSlots(state.project);
    if (!hadShots) fillSlotIdeas(state.project, { weirdness: state.project.echoSettings.weirdness });
    state.view = 'timeline';
    commit();
    toast(`${state.project.shots.length} slots cut on the beat`, 'ok');
  },
  'edit-lyrics'() {
    const p = state.project;
    openSheet(`<form data-form="lyrics"><h2 class="display">LYRICS</h2>
      <p class="small muted">One line per line. Timing and shot links update automatically.</p>
      <textarea name="lyrics" rows="12">${esc(p.lyrics.join('\n'))}</textarea>
      <button class="btn primary big">SAVE LYRICS</button></form>`);
  },
  async 'lyric-sync'() {
    const p = state.project;
    unlockAudio();
    const a = p.track && await store.getAsset(p.track.assetId);
    if (!a) { toast('Add the song first', 'error'); return; }
    const buf = await decodeSong(a.blob, a.id);
    // Start a little before the used range so the first line can be caught.
    const from = Math.max(0, p.track.range.start - 4);
    syncState = { i: 0, times: [], from, handle: playSong(buf, from, p.track.duration) };
    const ac = audioContext();
    syncState.clock = () => from + (ac.currentTime - syncState.handle.startAt);
    openSheet(`<div class="sync"><p class="eyebrow">TAP WHEN EACH LINE STARTS</p>
      <p class="sync-line" id="sync-line">${esc(p.lyrics[0])}</p>
      <p class="small muted" id="sync-next">Next: ${esc(p.lyrics[1] || '—')}</p>
      <button class="sync-tap" data-action="sync-tap">TAP</button>
      <button class="btn ghost" data-action="sync-stop">Stop</button></div>`, { onClose: () => { syncState?.handle.stop(); syncState = null; } });
  },
  'sync-tap'() {
    const p = state.project;
    if (!syncState) return;
    syncState.times[syncState.i] = Math.round(syncState.clock() * 10) / 10;
    syncState.i += 1;
    navigator.vibrate?.(20);
    if (syncState.i >= p.lyrics.length) { handlers['sync-stop'](); return; }
    $('#sync-line').textContent = p.lyrics[syncState.i];
    $('#sync-next').textContent = `Next: ${p.lyrics[syncState.i + 1] || '—'}`;
  },
  'sync-stop'() {
    const p = state.project;
    if (syncState?.times.length) {
      p.lyricTimes = p.lyrics.map((_, i) => (syncState.times[i] ?? p.lyricTimes[i] ?? null));
      toast(`${syncState.times.length} line${syncState.times.length === 1 ? '' : 's'} timed`, 'ok');
    }
    closeSheet();
    commit();
  },
  'cap-source'(el) { state.project.captions.source = el.dataset.v; commit(); },
  'cap-style'(el) { state.project.captions.style = el.dataset.v; commit(); },
  'cap-font'(el) { state.project.captions.font = el.dataset.v; commit(); },
  'cap-toggle'() {
    const c = state.project.captions;
    c.enabled = !c.enabled;
    if (c.enabled) { state.view = 'timeline'; toast('Captions will be burned into your video', 'ok'); }
    commit();
  },
});

Object.assign(forms, {
  async 'quick-new'(form) {
    const f = new FormData(form);
    const song = String(f.get('song') || '').trim();
    const p = createProject({ name: song || 'Untitled video', song, artist: String(f.get('artist') || '').trim() });
    await store.putProject(p);
    closeSheet();
    await openProject(p.id, 'shoot', 'templates');
  },
  lyrics(form) {
    const p = state.project;
    const next = lines(new FormData(form).get('lyrics'));
    // Keep timing for lines that didn't change.
    p.lyricTimes = next.map((l) => {
      const i = p.lyrics.indexOf(l);
      return i >= 0 ? p.lyricTimes[i] ?? null : null;
    });
    p.lyrics = next;
    // Slots without a line get the next lyric; auto-generated ideas follow the new words.
    let k = 0;
    for (const s of p.shots) {
      if (!s.lyric && next[k]) s.lyric = next[k];
      if (next[k]) k += 1;
    }
    fillSlotIdeas(p, { weirdness: p.echoSettings.weirdness, onlyAuto: true });
    closeSheet();
    commit();
    toast(`${next.length} lyric line${next.length === 1 ? '' : 's'} saved — captions and ideas updated`, 'ok');
  },
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (!el.dataset.range || !state.project?.track) return;
  const r = state.project.track.range;
  const v = Number(el.value);
  if (el.dataset.range === 'start') r.start = Math.min(v, r.end - 1);
  else r.end = Math.max(v, r.start + 1);
  const a = $('#r-start');
  const b = $('#r-end');
  if (a) a.textContent = formatTime(r.start);
  if (b) b.textContent = formatTime(r.end);
  commit({ render: false });
});
document.addEventListener('change', (e) => { if (e.target.dataset?.range) render(); });

// ---------------------------------------------------------------- wiring

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'INPUT') return;
  const fn = handlers[el.dataset.action];
  if (!fn) return;
  e.preventDefault();
  Promise.resolve(fn(el)).catch((err) => toast(err.message, 'error'));
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.matches('input[type=checkbox][data-action]')) {
    handlers[el.dataset.action]?.(el);
    return;
  }
  if (el.dataset.setting) {
    const v = el.value;
    state.project.shootSettings[el.dataset.setting] = /^\d+$/.test(v) ? Number(v) : v;
    commit({ render: false });
    const st = state.project.shootSettings;
    const sum = $('[data-details="settings"] summary .muted');
    if (sum) sum.textContent = `${st.aspect} · ${st.resolution} · ${st.fps}fps · ${st.lens} · ${st.countdownSec}s countdown`;
  }
});

// Typing never re-renders (keeps focus and the keyboard up); it just saves.
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.input === 'shot-notes') {
    findShot(state.project, el.dataset.id).notes = el.value;
    commit({ render: false });
  } else if (el.dataset.input === 'setting-notes') {
    state.project.shootSettings.notes = el.value;
    commit({ render: false });
  }
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  Promise.resolve(forms[form.dataset.form]?.(form)).catch((err) => toast(err.message, 'error'));
});

document.addEventListener('toggle', (e) => {
  if (e.target.dataset?.details === 'settings') state.settingsOpen = e.target.open;
}, true);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeSheet(); closeCountdown(); }
  if (e.key === ' ' && state.view === 'timeline' && !e.target.closest('input,textarea,select,button')) { e.preventDefault(); handlers.play(); }
});

// Save immediately whenever the app is backgrounded, closed or the screen locks.
const flushAll = () => { if (saveTimer) flushSave(); persistSession(); };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAll(); });
window.addEventListener('pagehide', flushAll);
let scrollTimer = null;
window.addEventListener('scroll', () => { clearTimeout(scrollTimer); scrollTimer = setTimeout(persistSession, 400); }, { passive: true });

window.addEventListener('online', () => { state.online = true; renderStatus(); syncNow(); });
window.addEventListener('offline', () => { state.online = false; renderStatus(); });

async function boot() {
  registerServiceWorker();
  try {
    state.cloud = await cloud.getCloudConfig();
    state.pending = state.cloud ? await cloud.pendingCount() : 0;
    state.projects = await store.listProjects();
    const session = await loadSession();
    if (session?.projectId && await store.getProject(session.projectId)) {
      await openProject(session.projectId, session.tab, session.view, session.sel);
      if (session.scrollY) requestAnimationFrame(() => window.scrollTo(0, session.scrollY));
    } else {
      render();
    }
    if (state.cloud && state.online) syncNow();
  } catch (err) {
    $('#app').innerHTML = `<main class="page"><h1>ReaShoota</h1><p>Storage is unavailable in this browser mode (${esc(err.message)}). Private browsing can block it — open ReaShoota in a normal Safari tab or from your Home Screen.</p></main>`;
  }
}

// Exposed for debugging/tests.
window.reashoota = { state, store, makeFile };

boot();
