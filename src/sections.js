// Turns a project into format-neutral document blocks, then renders them as plain text or
// Markdown. The PDF renderer (pdf-packs.js) consumes the same blocks, so every export format
// says the same thing.

import { allLocations, allProps, lyricMap, progress, shotLabel } from './project.js';

// Block types: title, h, p, ul, check, kv, shot, palette, break
const title = (text, sub) => ({ t: 'title', text, sub });
const h = (text) => ({ t: 'h', text });
const p = (text) => ({ t: 'p', text });
const ul = (items) => ({ t: 'ul', items });
const kv = (rows) => ({ t: 'kv', rows: rows.filter(([, v]) => v !== '' && v != null) });
const brk = () => ({ t: 'break' });

const byline = (pr) => [pr.artist, pr.song && `“${pr.song}”`].filter(Boolean).join(' — ');

export function cameraLine(shot) {
  const c = shot.camera || {};
  return [c.lens, c.move, c.angle, c.fps && `${c.fps}fps`, c.notes].filter(Boolean).join(' · ');
}

function shotBlocks(pr) {
  return pr.shots.map((s) => ({ t: 'shot', label: shotLabel(pr, s), shot: s }));
}

const SECTIONS = {
  summary(pr) {
    const pg = progress(pr);
    return [
      title(pr.name, byline(pr)),
      kv([
        ['Artist', pr.artist], ['Song', pr.song],
        ['Shots', `${pg.done}/${pg.total} complete`],
        ['Locations', String(allLocations(pr).length)],
        ['Updated', new Date(pr.updatedAt).toLocaleString()],
      ]),
      ...(pr.direction.logline ? [p(pr.direction.logline)] : []),
      ...(pr.notes ? [h('Notes'), p(pr.notes)] : []),
    ];
  },

  direction(pr) {
    const d = pr.direction;
    const out = [title('Creative Direction', `${pr.name}${byline(pr) ? ' — ' + byline(pr) : ''}`)];
    if (d.logline) out.push(h('Logline'), p(d.logline));
    if (d.concept) out.push(h('Concept'), p(d.concept));
    if (d.mood) out.push(h('Mood & tone'), p(d.mood));
    if (d.palette.length) out.push(h('Palette'), { t: 'palette', colors: d.palette });
    if (d.visualRules.length) out.push(h('Visual rules'), ul(d.visualRules));
    if (d.wardrobe.length) out.push(h('Wardrobe'), ul(d.wardrobe));
    if (d.references.length) out.push(h('References'), ul(d.references));
    return out;
  },

  rhymes(pr) {
    const out = [title('Image-Rhyme Breakdown', pr.name)];
    if (!pr.imageRhymes.length) out.push(p('No image rhymes yet.'));
    for (const r of pr.imageRhymes) {
      out.push(h(r.motif || 'Motif'), kv([['First appears', r.first], ['Echo', r.echo], ['Meaning', r.meaning]]));
    }
    return out;
  },

  lyrics(pr) {
    const out = [title('Lyrics → Shots', pr.name)];
    if (!pr.lyrics.length) out.push(p('No lyrics added yet.'));
    for (const { line, shots } of lyricMap(pr)) {
      if (!line.trim()) continue;
      const labels = shots.map((s) => `${shotLabel(pr, s)} ${s.title}`);
      out.push(kv([[line, labels.length ? labels.join('; ') : '— no shot yet']]));
    }
    return out;
  },

  shotlist(pr) {
    const pg = progress(pr);
    return [title('Shot List', `${pr.name} · ${pg.done}/${pg.total} done`), ...shotBlocks(pr)];
  },

  storyboard(pr) {
    return [title('Storyboard', pr.name), ...shotBlocks(pr)];
  },

  camera(pr) {
    const st = pr.shootSettings;
    return [
      title('Camera Instructions', pr.name),
      h('Default settings'),
      kv([['Aspect', st.aspect], ['Resolution', st.resolution], ['Frame rate', `${st.fps}fps`],
        ['Shutter', st.shutter], ['Lens', st.lens], ['Stabilisation', st.stabilization],
        ['Countdown', `${st.countdownSec}s`], ['Notes', st.notes]]),
      h('Per shot'),
      kv(pr.shots.map((s) => [`${shotLabel(pr, s)} ${s.title}`, cameraLine(s) || 'Default settings'])),
    ];
  },

  locations(pr) {
    const out = [title('Locations & Props', pr.name), h('Locations')];
    const locs = allLocations(pr);
    if (!locs.length) out.push(p('No locations yet.'));
    for (const l of locs) {
      out.push(kv([[l.name, [l.address, l.notes, l.shots.length && `Shots: ${l.shots.join(', ')}`].filter(Boolean).join(' — ')]]));
    }
    out.push(h('Props'));
    const props = allProps(pr);
    out.push(props.length
      ? ul(props.map((x) => (x.shots.length ? `${x.name} (${x.shots.join(', ')})` : x.name)))
      : p('No props yet.'));
    return out;
  },

  checklist(pr) {
    const out = [title('Shoot Checklist', pr.name)];
    const groups = new Map();
    for (const c of pr.checklist) {
      if (!groups.has(c.category)) groups.set(c.category, []);
      groups.get(c.category).push(c);
    }
    if (!groups.size) out.push(p('Checklist is empty.'));
    for (const [cat, items] of groups) {
      out.push(h(cat), { t: 'check', items: items.map((i) => ({ text: i.text, done: i.done })) });
    }
    out.push(h('Shots'), { t: 'check', items: pr.shots.map((s) => ({ text: `${shotLabel(pr, s)} ${s.title}`, done: s.status === 'done' })) });
    return out;
  },

  // On-location pack: what you need with the phone in your hand.
  shoot(pr) {
    return [
      ...SECTIONS.shotlist(pr), brk(),
      ...SECTIONS.camera(pr), brk(),
      ...SECTIONS.locations(pr), brk(),
      ...SECTIONS.checklist(pr),
    ];
  },

  full(pr) {
    const parts = ['summary', 'direction', 'rhymes', 'lyrics', 'shotlist', 'camera', 'locations', 'checklist'];
    return parts.flatMap((k, i) => (i ? [brk(), ...SECTIONS[k](pr)] : SECTIONS[k](pr)));
  },
};

export const SECTION_KINDS = Object.keys(SECTIONS);

export function buildBlocks(kind, project) {
  const fn = SECTIONS[kind];
  if (!fn) throw new Error(`Unknown export section: ${kind}`);
  return fn(project);
}

function shotTextLines(b) {
  const s = b.shot;
  const lines = [`${b.label} · ${s.title}${s.status === 'done' ? '  [DONE]' : ''}`];
  const add = (k, v) => { if (v) lines.push(`   ${k}: ${v}`); };
  add('What', s.description);
  add('Lyric', s.lyric && `“${s.lyric}”`);
  add('Camera', cameraLine(s));
  add('Location', s.location);
  add('Props', s.props.join(', '));
  add('Duration', s.durationSec ? `${s.durationSec}s` : '');
  add('Why', s.echo?.why);
  add('Light', s.echo?.light);
  add('Do this', s.echo?.howTo?.join(' → '));
  add('AI', s.echo?.ai);
  add('Cut', s.echo?.cut);
  add('Notes', s.notes);
  return lines;
}

export function blocksToText(blocks) {
  const out = [];
  for (const b of blocks) {
    switch (b.t) {
      case 'title':
        out.push(b.text.toUpperCase(), ...(b.sub ? [b.sub] : []), '='.repeat(Math.min(40, Math.max(b.text.length, 12))), '');
        break;
      case 'h': out.push(b.text.toUpperCase(), '-'.repeat(Math.min(40, b.text.length))); break;
      case 'p': out.push(b.text, ''); break;
      case 'ul': out.push(...b.items.map((i) => `• ${i}`), ''); break;
      case 'check': out.push(...b.items.map((i) => `${i.done ? '[x]' : '[ ]'} ${i.text}`), ''); break;
      case 'kv': out.push(...b.rows.map(([k, v]) => `${k}: ${v}`), ''); break;
      case 'palette': out.push(b.colors.join('  '), ''); break;
      case 'shot': out.push(...shotTextLines(b), ''); break;
      case 'break': out.push(''); break;
      default: break;
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

const mdEsc = (s) => String(s).replace(/([\\`*_[\]<>|])/g, '\\$1');

export function blocksToMarkdown(blocks) {
  const out = [];
  let first = true;
  for (const b of blocks) {
    switch (b.t) {
      case 'title':
        out.push(`${first ? '#' : '##'} ${mdEsc(b.text)}`, ...(b.sub ? [`_${mdEsc(b.sub)}_`] : []), '');
        first = false;
        break;
      case 'h': out.push(`### ${mdEsc(b.text)}`, ''); break;
      case 'p': out.push(mdEsc(b.text), ''); break;
      case 'ul': out.push(...b.items.map((i) => `- ${mdEsc(i)}`), ''); break;
      case 'check': out.push(...b.items.map((i) => `- [${i.done ? 'x' : ' '}] ${mdEsc(i.text)}`), ''); break;
      case 'kv': out.push(...b.rows.map(([k, v]) => `- **${mdEsc(k)}:** ${mdEsc(v)}`), ''); break;
      case 'palette': out.push(b.colors.map((c) => `\`${c}\``).join(' '), ''); break;
      case 'shot': {
        const [head, ...rest] = shotTextLines(b);
        out.push(`#### ${mdEsc(head)}`, ...rest.map((l) => `- ${mdEsc(l.trim())}`), '');
        break;
      }
      case 'break': out.push('---', ''); break;
      default: break;
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export function exportText(kind, project, format = 'txt') {
  const blocks = buildBlocks(kind, project);
  return format === 'md' ? blocksToMarkdown(blocks) : blocksToText(blocks);
}
