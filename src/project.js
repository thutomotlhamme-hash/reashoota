// Project model: factories, normalisation, duplication and safe regeneration.
// Pure module — no DOM, no storage — so it runs in the browser and in node tests.

export const SCHEMA_VERSION = 1;

export function uid(prefix = 'id') {
  const rand = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    : Math.random().toString(36).slice(2, 14);
  return `${prefix}_${rand}`;
}

const now = () => new Date().toISOString();

export const DEFAULT_SHOOT_SETTINGS = {
  countdownSec: 3,
  aspect: '9:16',
  resolution: '4K',
  fps: 24,
  shutter: '1/50',
  lens: '1x (26mm)',
  stabilization: 'Action mode off',
  notes: '',
};

export function createShot(partial = {}) {
  return {
    id: partial.id || uid('shot'),
    title: partial.title || 'Untitled shot',
    description: partial.description || '',
    lyric: partial.lyric || '',
    camera: {
      lens: '', move: '', angle: '', fps: '', notes: '',
      ...(partial.camera || {}),
    },
    location: partial.location || '',
    props: Array.isArray(partial.props) ? [...partial.props] : [],
    durationSec: Number(partial.durationSec) || 3,
    frameAssetId: partial.frameAssetId || null,
    status: partial.status === 'done' ? 'done' : 'todo',
    completedAt: partial.completedAt || null,
    notes: partial.notes || '',
    history: Array.isArray(partial.history) ? partial.history.slice(-5) : [],
  };
}

export function createProject(partial = {}) {
  const t = now();
  const p = {
    schema: SCHEMA_VERSION,
    id: partial.id || uid('proj'),
    name: partial.name || 'Untitled project',
    artist: partial.artist || '',
    song: partial.song || '',
    createdAt: partial.createdAt || t,
    updatedAt: partial.updatedAt || t,
    direction: {
      logline: '', concept: '', mood: '',
      palette: [], visualRules: [], references: [], wardrobe: [],
      ...(partial.direction || {}),
    },
    imageRhymes: (partial.imageRhymes || []).map((r) => ({
      id: r.id || uid('rhyme'), motif: r.motif || '', first: r.first || '',
      echo: r.echo || '', meaning: r.meaning || '',
    })),
    lyrics: Array.isArray(partial.lyrics) ? [...partial.lyrics] : [],
    shots: (partial.shots || []).map(createShot),
    checklist: (partial.checklist || []).map((c) => ({
      id: c.id || uid('chk'), text: c.text || '', category: c.category || 'General', done: !!c.done,
    })),
    locations: (partial.locations || []).map((l) => ({
      id: l.id || uid('loc'), name: l.name || '', address: l.address || '', notes: l.notes || '',
    })),
    props: Array.isArray(partial.props) ? [...partial.props] : [],
    assets: (partial.assets || []).map((a) => ({
      id: a.id, kind: a.kind || 'frame', name: a.name || a.id, mime: a.mime || '',
      size: a.size || 0, createdAt: a.createdAt || t, width: a.width || 0, height: a.height || 0,
    })),
    shootSettings: { ...DEFAULT_SHOOT_SETTINGS, ...(partial.shootSettings || {}) },
    notes: partial.notes || '',
    offline: partial.offline || null, // { at: ISO, bytes } once "Make available offline" ran
    cloud: partial.cloud || null, // { syncedAt, remoteVersion }
  };
  return p;
}

// Accepts anything that looks like a project (older schema, import) and returns a full one.
export const normalizeProject = (raw) => createProject(raw || {});

export function touch(project) {
  project.updatedAt = now();
  return project;
}

export function findShot(project, shotId) {
  return project.shots.find((s) => s.id === shotId) || null;
}

export function shotLabel(project, shot) {
  const i = project.shots.indexOf(shot);
  return `S${String(i + 1).padStart(2, '0')}`;
}

export function setShotDone(project, shotId, done) {
  const shot = findShot(project, shotId);
  if (!shot) return null;
  shot.status = done ? 'done' : 'todo';
  shot.completedAt = done ? now() : null;
  touch(project);
  return shot;
}

export function progress(project) {
  const total = project.shots.length;
  const done = project.shots.filter((s) => s.status === 'done').length;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

// Every asset id referenced anywhere in the project.
export function referencedAssetIds(project) {
  const ids = new Set(project.assets.map((a) => a.id));
  for (const s of project.shots) if (s.frameAssetId) ids.add(s.frameAssetId);
  return ids;
}

// A copy with a new identity. Asset blobs are immutable, so the copy shares them by id.
export function duplicateProject(project, { resetProgress = false, name } = {}) {
  const copy = createProject(JSON.parse(JSON.stringify(project)));
  const t = now();
  copy.id = uid('proj');
  copy.name = name || `${project.name} (copy)`;
  copy.createdAt = t;
  copy.updatedAt = t;
  copy.offline = null;
  copy.cloud = null;
  if (resetProgress) {
    for (const s of copy.shots) { s.status = 'todo'; s.completedAt = null; }
    for (const c of copy.checklist) c.done = false;
  }
  return copy;
}

// Fields an idea generator may replace. Everything else (id, status, notes, frame,
// completion time, order) is production state and is never touched by regeneration.
export const IDEA_FIELDS = ['title', 'description', 'camera', 'location', 'props', 'durationSec'];

function snapshotIdea(shot) {
  const snap = { at: now() };
  for (const f of IDEA_FIELDS) snap[f] = JSON.parse(JSON.stringify(shot[f]));
  return snap;
}

// Regenerate one shot's idea. The previous idea is kept in shot.history so it can be restored.
export function regenerateShot(project, shotId, generator = localIdeaGenerator) {
  const shot = findShot(project, shotId);
  if (!shot) return null;
  const idea = generator(shot, project) || {};
  shot.history = [...shot.history, snapshotIdea(shot)].slice(-5);
  for (const f of IDEA_FIELDS) {
    if (idea[f] === undefined) continue;
    shot[f] = f === 'camera' ? { ...shot.camera, ...idea.camera } : idea[f];
  }
  touch(project);
  return shot;
}

// Regenerate only shots that are not yet shot — completed work is left exactly as it is.
export function regenerateRemaining(project, generator = localIdeaGenerator) {
  const changed = [];
  for (const s of project.shots) {
    if (s.status === 'done') continue;
    regenerateShot(project, s.id, generator);
    changed.push(s.id);
  }
  return changed;
}

export function restorePreviousIdea(project, shotId) {
  const shot = findShot(project, shotId);
  if (!shot || !shot.history.length) return null;
  const prev = shot.history.pop();
  for (const f of IDEA_FIELDS) if (prev[f] !== undefined) shot[f] = prev[f];
  touch(project);
  return shot;
}

// Offline fallback idea generator: remixes camera language so the creator gets a fresh
// take without a network round-trip. An AI generator can be swapped in with the same shape.
const MOVES = ['slow push-in', 'handheld drift', 'locked-off static', 'whip pan reveal', 'orbit 180°', 'pull-out reveal', 'tracking walk-and-talk', 'crash zoom'];
const ANGLES = ['low angle', 'eye level', 'high angle', 'Dutch tilt', 'over-the-shoulder', 'top-down', 'extreme close-up', 'wide establishing'];
const LENSES = ['0.5x ultra-wide', '1x (26mm)', '2x (52mm)', '3x/5x tele'];
const TWISTS = ['silhouette against the brightest light source', 'reflection in glass or a puddle', 'foreground object partly blocking frame', 'shoot through fabric or smoke', 'start out of focus and rack in', 'freeze on the downbeat, move on the snare'];

function pick(list, seed) { return list[Math.abs(seed) % list.length]; }
function hash(str) { let h = 0; for (const ch of str) h = (h * 31 + ch.charCodeAt(0)) | 0; return h; }

export function localIdeaGenerator(shot) {
  const seed = hash(shot.id + shot.history.length + shot.title);
  const move = pick(MOVES, seed);
  const angle = pick(ANGLES, seed >> 3);
  const twist = pick(TWISTS, seed >> 6);
  const base = shot.description.split(' — Alt:')[0];
  return {
    description: `${base} — Alt: ${angle}, ${move}; ${twist}.`,
    camera: { move, angle, lens: pick(LENSES, seed >> 9) },
  };
}

export function allProps(project) {
  const map = new Map();
  for (const p of project.props) map.set(p, []);
  project.shots.forEach((s) => {
    for (const p of s.props) {
      if (!map.has(p)) map.set(p, []);
      map.get(p).push(shotLabel(project, s));
    }
  });
  return [...map.entries()].map(([name, shots]) => ({ name, shots }));
}

export function allLocations(project) {
  const byName = new Map(project.locations.map((l) => [l.name, { ...l, shots: [] }]));
  project.shots.forEach((s) => {
    if (!s.location) return;
    if (!byName.has(s.location)) byName.set(s.location, { name: s.location, address: '', notes: '', shots: [] });
    byName.get(s.location).shots.push(shotLabel(project, s));
  });
  return [...byName.values()];
}

const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

// Lyric line -> shots that cover it (matched on the shot's lyric snippet).
export function lyricMap(project) {
  return project.lyrics.map((line) => {
    const n = norm(line);
    const shots = n
      ? project.shots.filter((s) => {
        const l = norm(s.lyric || '');
        return l && (n.includes(l) || l.includes(n));
      })
      : [];
    return { line, shots };
  });
}

export function slugify(str) {
  return (str || 'reashoota').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '')
    .trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 60) || 'reashoota';
}

export function demoProject() {
  return createProject({
    name: 'Golden Hour Ghost',
    artist: 'Nala Vee',
    song: 'Ghost in the Taxi Rank',
    direction: {
      logline: 'A girl chases her own reflection through the city at dusk until they finally meet.',
      concept: 'Every scene rhymes a reflection with a real moment. The city is warm and blurred; she is sharp. By the last chorus the reflection steps out of the glass and the two walk off together.',
      mood: 'Warm, nostalgic, restless. Amber streetlight, soft haze, handheld intimacy with a few locked-off wide frames for breath.',
      palette: ['#1b1a2e', '#ff7a3d', '#ffcf70', '#3fa7a3', '#f4efe6'],
      visualRules: ['Always keep one reflective surface in frame', 'Artist in sharp focus, city soft', 'Shoot choruses at 60fps for slow-motion options', 'No cool white light — warm only'],
      references: ['Wong Kar-wai step-printing', 'Solange — "Cranes in the Sky" framing', 'Late-afternoon taxi rank chaos'],
      wardrobe: ['Mustard coat', 'Silver hoops', 'White sneakers (spare pair for rain)'],
    },
    imageRhymes: [
      { motif: 'Reflection in glass', first: 'S01 taxi window', echo: 'S06 shop window', meaning: 'She is chasing a version of herself' },
      { motif: 'Hand on a cold surface', first: 'S02 bus stop pole', echo: 'S07 palm on mirror', meaning: 'Reaching for connection' },
      { motif: 'Orange light flare', first: 'S03 street lamp', echo: 'S08 sunset finale', meaning: 'Hope arrives at golden hour' },
    ],
    lyrics: [
      'I saw you in the window of a moving car',
      'Holding on to nothing at the bus stop bar',
      'Every light turns amber when you call my name',
      'Ghost in the taxi rank, we are the same',
      'Step out of the glass, walk me home',
    ],
    shots: [
      { title: 'Taxi window reflection', description: 'Artist\'s face reflected over passing city lights in a taxi window.', lyric: 'I saw you in the window of a moving car', camera: { lens: '2x (52mm)', move: 'locked-off', angle: 'eye level', fps: '24' }, location: 'Bree St Taxi Rank', props: ['Taxi (arranged)'], durationSec: 4, status: 'done' },
      { title: 'Bus stop hold', description: 'Wide: artist alone gripping the bus stop pole while crowds blur past.', lyric: 'Holding on to nothing at the bus stop bar', camera: { lens: '0.5x ultra-wide', move: 'handheld drift', angle: 'low angle', fps: '24' }, location: 'Bree St Taxi Rank', props: ['Mustard coat'], durationSec: 5, status: 'done' },
      { title: 'Amber flare turn', description: 'Artist turns toward camera as a street lamp flares behind her head.', lyric: 'Every light turns amber when you call my name', camera: { lens: '1x (26mm)', move: 'slow push-in', angle: 'eye level', fps: '60' }, location: 'Juta St', props: [], durationSec: 3 },
      { title: 'Chorus crowd sprint', description: 'Tracking alongside artist running through the rank, reflection visible in bus windows.', lyric: 'Ghost in the taxi rank, we are the same', camera: { lens: '0.5x ultra-wide', move: 'tracking run', angle: 'eye level', fps: '60', notes: 'Action mode ON' }, location: 'Bree St Taxi Rank', props: ['White sneakers'], durationSec: 6 },
      { title: 'Silver hoop macro', description: 'Extreme close-up of hoop earring catching amber light.', lyric: '', camera: { lens: '3x/5x tele', move: 'static', angle: 'extreme close-up', fps: '24' }, location: 'Juta St', props: ['Silver hoops'], durationSec: 2 },
      { title: 'Shop window double', description: 'Artist stops at a shop window; reflection is a beat behind her movements.', lyric: '', camera: { lens: '1x (26mm)', move: 'locked-off', angle: 'over-the-shoulder', fps: '24' }, location: 'Juta St', props: ['Mirror board'], durationSec: 5 },
      { title: 'Palm to mirror', description: 'Artist presses palm to mirror; reflection mirrors a fraction late.', lyric: 'Step out of the glass, walk me home', camera: { lens: '2x (52mm)', move: 'slow push-in', angle: 'eye level', fps: '24' }, location: 'Rooftop', props: ['Mirror board'], durationSec: 4 },
      { title: 'Sunset walk-off', description: 'Wide silhouette: artist and her reflection-double walk away into the sunset.', lyric: 'Step out of the glass, walk me home', camera: { lens: '0.5x ultra-wide', move: 'pull-out reveal', angle: 'wide establishing', fps: '24' }, location: 'Rooftop', props: ['Double in matching coat'], durationSec: 6 },
    ],
    checklist: [
      { category: 'Gear', text: 'iPhone charged + power bank', done: true },
      { category: 'Gear', text: 'Gimbal / grip', done: true },
      { category: 'Gear', text: 'Lens wipes', done: false },
      { category: 'Gear', text: 'Clip-on ND filter', done: false },
      { category: 'Admin', text: 'Rooftop access confirmed', done: false },
      { category: 'Admin', text: 'Playback speaker + song file offline', done: false },
      { category: 'Wardrobe', text: 'Mustard coat steamed', done: false },
    ],
    locations: [
      { name: 'Bree St Taxi Rank', address: 'Bree St, Johannesburg CBD', notes: 'Busy 16:00–18:00. Ask marshal before filming.' },
      { name: 'Juta St', address: 'Braamfontein', notes: 'Shop windows face west — best at 17:30.' },
      { name: 'Rooftop', address: 'Access via friend\'s building', notes: 'Sunset ~18:05.' },
    ],
    props: ['Mirror board', 'Taxi (arranged)'],
  });
}
