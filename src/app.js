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
};

const TABS = [
  ['shoot', 'Shoot'], ['board', 'Board'], ['direction', 'Direction'],
  ['checklist', 'Checklist'], ['media', 'Media'], ['export', 'Export'],
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
  saveSession({ projectId: state.project?.id || null, tab: state.tab, scrollY: window.scrollY });
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
  app.innerHTML = state.project ? projectView() : homeView();
  renderStatus();
  hydrateMedia(app);
}

function renderStatus() {
  const el = $('#status');
  if (!el) return;
  const net = state.online ? '' : '<span class="pill warn">Offline — everything still works</span>';
  let acct = '';
  if (state.cloud) acct = `<span class="pill ok">${state.pending ? `${state.pending} to back up` : 'Backed up'}</span>`;
  el.innerHTML = net + acct;
}

function homeView() {
  const cards = state.projects.map((p) => {
    const pg = progress(p);
    return `<article class="card project-card">
      <button class="project-open" data-action="open" data-id="${p.id}">
        <h3>${esc(p.name)}</h3>
        <p class="muted">${esc([p.artist, p.song].filter(Boolean).join(' — ') || 'No artist yet')}</p>
        <div class="bar"><span style="width:${pg.pct}%"></span></div>
        <p class="small muted">${pg.done}/${pg.total} shots · updated ${timeAgo(p.updatedAt)}${p.offline ? ' · <b class="ok-text">Offline ready</b>' : ''}</p>
      </button>
      <div class="row wrap">
        <button class="btn sm" data-action="open" data-id="${p.id}">Continue</button>
        <button class="btn sm ghost" data-action="duplicate" data-id="${p.id}">Duplicate</button>
        <button class="btn sm ghost" data-action="home-export" data-id="${p.id}" data-export="backup" data-format="json">Download</button>
        <button class="btn sm ghost" data-action="home-export" data-id="${p.id}" data-export="full" data-format="pdf">Share</button>
        <button class="btn sm ghost danger" data-action="delete-project" data-id="${p.id}">Delete</button>
      </div>
    </article>`;
  }).join('');
  return `<header class="top">
      <div class="brand"><img src="icons/icon.svg" alt="" width="32" height="32"><h1>ReaShoota</h1></div>
      <div id="status" class="status"></div>
    </header>
    <main class="page">
      <div class="row wrap">
        <button class="btn primary" data-action="new-project">+ New project</button>
        <button class="btn" data-action="import">Import backup</button>
        ${state.projects.length ? '' : '<button class="btn ghost" data-action="demo">Try the demo project</button>'}
      </div>
      ${cards || '<p class="empty">No projects yet. Start one, or try the demo to see exports, storyboards and offline mode.</p>'}
      ${accountCard()}
    </main>`;
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
      <button class="icon-btn" data-action="home" aria-label="All projects">‹</button>
      <div class="title-block">
        <h1>${esc(p.name)}</h1>
        <p class="small muted">${pg.done}/${pg.total} shots · ${p.offline ? '<b class="ok-text">Offline ready</b>' : 'Saved on phone'}</p>
      </div>
      <button class="icon-btn" data-action="edit-project" aria-label="Edit project">✎</button>
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
  openSheet(`<h2>${esc(label)}</h2><div class="bar big"><span id="busy-bar" style="width:4%"></span></div>
    <p class="small muted" id="busy-note">Preparing…</p>
    <button class="btn ghost" data-action="cancel-busy">Cancel</button>`, { onClose: () => ctl.abort() });
  return {
    signal: ctl.signal,
    progress: (f) => { const b = $('#busy-bar'); if (b) b.style.width = `${Math.max(4, Math.round(f * 100))}%`; },
    note: (t) => { const n = $('#busy-note'); if (n) n.textContent = t; },
  };
}

async function runExport(project, exportId, format, opts = {}) {
  const busy = busySheet(`Preparing ${exportLabel(exportId)}…`);
  if (exportId === 'animatic') busy.note('Recording in real time — keep the screen on.');
  try {
    const result = await produce(project, exportId, format, { onProgress: busy.progress, signal: busy.signal });
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

async function openProject(id, tab) {
  await flushSave();
  const p = await store.getProject(id);
  if (!p) return;
  state.project = p;
  state.tab = tab || 'shoot';
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
  'new-project'() { openSheet(projectForm(createProject(), true)); },
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
      await openProject(session.projectId, session.tab);
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
