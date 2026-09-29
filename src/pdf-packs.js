// PDF layouts: flowing documents (shot list, shoot pack, full pack…), a storyboard grid,
// and a landscape concept deck for clients/artists. Pure: callers pass JPEG bytes for frames.

import { PAGE_A4, PAGE_A4_LANDSCAPE, PdfDocument, wrapText } from './pdf.js';
import { buildBlocks, cameraLine } from './sections.js';
import { progress, shotLabel } from './project.js';

const INK = '#15131f';
const MUTED = '#6b6778';
const ACCENT = '#ff5a36';
const RULE = '#dddae3';

// frames: Map<assetId, Uint8Array(jpeg)>. Registers each once per document.
function frameLookup(doc, frames) {
  const cache = new Map();
  return (assetId) => {
    if (!assetId || !frames?.has(assetId)) return null;
    if (!cache.has(assetId)) {
      try { cache.set(assetId, doc.addJpeg(frames.get(assetId))); } catch { cache.set(assetId, null); }
    }
    return cache.get(assetId);
  };
}

function footer(doc, label) {
  doc.pages.forEach((page, i) => {
    doc.page = page;
    doc.line(40, page.height - 34, page.width - 40, page.height - 34, { color: RULE, lineWidth: 0.5 });
    doc.text(`ReaShoota · ${label}`, 40, page.height - 20, { size: 8, color: MUTED });
    const n = `${i + 1} / ${doc.pages.length}`;
    doc.text(n, page.width - 40 - n.length * 4.4, page.height - 20, { size: 8, color: MUTED });
  });
}

export function renderFlowPdf(kind, project, { frames } = {}) {
  const blocks = buildBlocks(kind, project);
  const doc = new PdfDocument({ ...PAGE_A4, title: `${project.name} — ${kind}`, author: project.artist });
  const M = 40;
  const W = PAGE_A4.width - M * 2;
  const bottom = PAGE_A4.height - 50;
  const frame = frameLookup(doc, frames);
  let y = 0;

  const newPage = () => { doc.addPage(); y = M + 10; };
  const ensure = (h) => { if (y + h > bottom) newPage(); };
  const para = (text, { size = 10.5, bold = false, color = INK, indent = 0, gap = 4 } = {}) => {
    const lh = size * 1.35;
    for (const line of wrapText(text, W - indent, size, bold)) {
      ensure(lh);
      doc.text(line, M + indent, y + size, { size, bold, color });
      y += lh;
    }
    y += gap;
  };

  newPage();
  for (const b of blocks) {
    switch (b.t) {
      case 'title':
        if (y > M + 40) { ensure(120); }
        doc.rect(M, y, 4, 34, { fill: ACCENT });
        para(b.text, { size: 22, bold: true, indent: 14, gap: 0 });
        if (b.sub) para(b.sub, { size: 11, color: MUTED, indent: 14, gap: 0 });
        y += 14;
        break;
      case 'h':
        ensure(40);
        y += 6;
        para(b.text.toUpperCase(), { size: 10, bold: true, color: ACCENT, gap: 2 });
        break;
      case 'p': para(b.text); break;
      case 'ul': for (const i of b.items) para(`•  ${i}`, { indent: 6, gap: 1 }); y += 4; break;
      case 'check':
        for (const i of b.items) {
          ensure(16);
          doc.rect(M + 4, y + 2, 9, 9, { stroke: INK, lineWidth: 0.8 });
          if (i.done) doc.rect(M + 6, y + 4, 5, 5, { fill: ACCENT });
          para(i.text, { indent: 22, gap: 2, color: i.done ? MUTED : INK });
        }
        y += 4;
        break;
      case 'kv':
        for (const [k, v] of b.rows) {
          const kLines = wrapText(k, 150, 10, true);
          const vLines = wrapText(v, W - 160, 10);
          const h = Math.max(kLines.length, vLines.length) * 13.5;
          ensure(h + 4);
          kLines.forEach((l, i) => doc.text(l, M, y + 10 + i * 13.5, { size: 10, bold: true }));
          vLines.forEach((l, i) => doc.text(l, M + 160, y + 10 + i * 13.5, { size: 10, color: INK }));
          y += h + 4;
        }
        y += 4;
        break;
      case 'palette': {
        ensure(46);
        b.colors.forEach((c, i) => {
          doc.rect(M + i * 62, y, 54, 30, { fill: c, stroke: RULE, lineWidth: 0.5 });
          doc.text(c, M + i * 62, y + 42, { size: 8, color: MUTED });
        });
        y += 54;
        break;
      }
      case 'shot': {
        const s = b.shot;
        const img = frame(s.frameAssetId);
        const thumbW = img ? 90 : 0;
        const textW = W - (img ? thumbW + 12 : 0) - 8;
        const rows = [
          ['What', s.description], ['Lyric', s.lyric && `“${s.lyric}”`], ['Camera', cameraLine(s)],
          ['Location', s.location], ['Props', s.props.join(', ')],
          ['Duration', s.durationSec ? `${s.durationSec}s` : ''],
          ['Why', s.echo?.why], ['Light', s.echo?.light], ['Do this', s.echo?.howTo?.join(' → ')],
          ['AI', s.echo?.ai], ['Cut', s.echo?.cut], ['Notes', s.notes],
        ].filter(([, v]) => v);
        const wrapped = rows.map(([k, v]) => [k, wrapText(v, textW - 58, 9.5)]);
        const h = Math.max(24 + wrapped.reduce((n, [, l]) => n + l.length * 12.5, 0), img ? thumbW * 16 / 9 + 16 : 0) + 8;
        ensure(Math.min(h, bottom - M));
        const top = y;
        doc.rect(M, top, W, h - 4, { stroke: RULE, lineWidth: 0.6 });
        if (s.status === 'done') doc.rect(M, top, 3, h - 4, { fill: ACCENT });
        const tx = M + 10;
        doc.text(`${b.label}`, tx, top + 16, { size: 11, bold: true, color: ACCENT });
        doc.text(s.title, tx + 34, top + 16, { size: 11, bold: true });
        if (s.status === 'done') doc.text('DONE', M + textW - 20, top + 16, { size: 8, bold: true, color: ACCENT });
        let ry = top + 32;
        for (const [k, lines] of wrapped) {
          doc.text(k, tx, ry, { size: 8.5, bold: true, color: MUTED });
          lines.forEach((l, i) => doc.text(l, tx + 52, ry + i * 12.5, { size: 9.5 }));
          ry += lines.length * 12.5;
        }
        if (img) doc.imageCover(img, M + W - thumbW - 8, top + 8, thumbW, thumbW * 16 / 9);
        y = top + h;
        break;
      }
      case 'break': if (y > M + 20) newPage(); break;
      default: break;
    }
  }
  footer(doc, `${project.name}`);
  return doc.save();
}

// Storyboard: 3×2 grid of 9:16 panels per A4 landscape page with caption under each.
export function renderStoryboardPdf(project, { frames } = {}) {
  const doc = new PdfDocument({ ...PAGE_A4_LANDSCAPE, title: `${project.name} — Storyboard`, author: project.artist });
  const frame = frameLookup(doc, frames);
  const M = 36;
  const cols = 6;
  const caption = 70;
  const top = M + 20;
  // Two rows must fit between the header and the footer rule.
  const rowH = (PAGE_A4_LANDSCAPE.height - top - 44) / 2;
  const panelH = rowH - caption;
  const cellW = Math.min(panelH * 9 / 16, (PAGE_A4_LANDSCAPE.width - M * 2 - 12 * (cols - 1)) / cols);
  const gap = (PAGE_A4_LANDSCAPE.width - M * 2 - cellW * cols) / (cols - 1);
  const shots = project.shots;
  const perPage = cols * 2;
  const pages = Math.max(1, Math.ceil(shots.length / perPage));
  for (let pg = 0; pg < pages; pg += 1) {
    doc.addPage();
    doc.text('STORYBOARD', M, M + 6, { size: 9, bold: true, color: ACCENT });
    doc.text(project.name, M + 80, M + 6, { size: 9, color: MUTED });
    shots.slice(pg * perPage, pg * perPage + perPage).forEach((s, i) => {
      const x = M + (i % cols) * (cellW + gap);
      const y = top + Math.floor(i / cols) * rowH;
      const img = frame(s.frameAssetId);
      if (img) doc.imageCover(img, x, y, cellW, panelH);
      else {
        doc.rect(x, y, cellW, panelH, { fill: '#f1eff5' });
        wrapText(s.description || s.title, cellW - 12, 7.5).slice(0, 12)
          .forEach((l, li) => doc.text(l, x + 6, y + 16 + li * 10, { size: 7.5, color: MUTED }));
      }
      doc.rect(x, y, cellW, panelH, { stroke: s.status === 'done' ? ACCENT : RULE, lineWidth: s.status === 'done' ? 1.5 : 0.6 });
      doc.text(`${shotLabel(project, s)}${s.status === 'done' ? '  DONE' : ''}`, x, y + panelH + 12, { size: 8.5, bold: true, color: ACCENT });
      wrapText(s.title, cellW, 8, true).slice(0, 2).forEach((l, li) => doc.text(l, x, y + panelH + 24 + li * 10, { size: 8, bold: true }));
      wrapText(cameraLine(s), cellW, 7).slice(0, 2).forEach((l, li) => doc.text(l, x, y + panelH + 46 + li * 9, { size: 7, color: MUTED }));
    });
  }
  footer(doc, `${project.name} · Storyboard`);
  return doc.save();
}

// Concept deck: one landscape slide per idea, for pitching to an artist or client.
export function renderDeckPdf(project, { frames } = {}) {
  const S = PAGE_A4_LANDSCAPE;
  const doc = new PdfDocument({ ...S, title: `${project.name} — Concept deck`, author: project.artist });
  const frame = frameLookup(doc, frames);
  const d = project.direction;
  const M = 56;
  const dark = () => doc.rect(0, 0, S.width, S.height, { fill: INK });
  const heading = (kicker, text) => {
    doc.text(kicker.toUpperCase(), M, M + 10, { size: 10, bold: true, color: ACCENT });
    wrapText(text, S.width - M * 2, 28, true).slice(0, 2).forEach((l, i) => doc.text(l, M, M + 46 + i * 34, { size: 28, bold: true, color: '#ffffff' }));
  };
  const body = (text, y, width = S.width - M * 2, size = 14) => {
    const lines = wrapText(text, width, size);
    lines.forEach((l, i) => doc.text(l, M, y + i * size * 1.4, { size, color: '#d9d6e2' }));
    return y + lines.length * size * 1.4;
  };

  // Cover — first available frame as a full-bleed right panel.
  doc.addPage(); dark();
  const hero = project.shots.map((s) => frame(s.frameAssetId)).find(Boolean);
  if (hero) doc.imageCover(hero, S.width * 0.58, 0, S.width * 0.42, S.height);
  doc.text('REASHOOTA · CONCEPT', M, M + 10, { size: 10, bold: true, color: ACCENT });
  wrapText(project.name, S.width * 0.5, 40, true).slice(0, 3).forEach((l, i) => doc.text(l, M, 190 + i * 46, { size: 40, bold: true, color: '#ffffff' }));
  doc.text([project.artist, project.song].filter(Boolean).join(' — '), M, 330, { size: 15, color: '#d9d6e2' });
  if (d.logline) body(d.logline, 380, S.width * 0.48, 13);

  if (d.concept || d.mood) {
    doc.addPage(); dark();
    heading('The idea', d.logline || project.name);
    let y = 150;
    if (d.concept) y = body(d.concept, y) + 18;
    if (d.mood) { doc.text('MOOD', M, y + 4, { size: 9, bold: true, color: ACCENT }); body(d.mood, y + 22, S.width - M * 2, 12); }
  }

  if (d.palette.length || d.visualRules.length) {
    doc.addPage(); dark();
    heading('Look', 'Palette & visual rules');
    const sw = Math.min(120, (S.width - M * 2) / Math.max(1, d.palette.length) - 12);
    d.palette.forEach((c, i) => {
      doc.rect(M + i * (sw + 12), 150, sw, 90, { fill: c });
      doc.text(c, M + i * (sw + 12), 256, { size: 9, color: '#aaa6b8' });
    });
    let y = 300;
    for (const r of d.visualRules) y = body(`•  ${r}`, y, S.width - M * 2, 13) + 4;
  }

  if (project.imageRhymes.length) {
    doc.addPage(); dark();
    heading('Image rhymes', 'Motifs that echo through the video');
    let y = 160;
    for (const r of project.imageRhymes) {
      doc.text(r.motif, M, y, { size: 15, bold: true, color: '#ffffff' });
      body([r.first && `First: ${r.first}`, r.echo && `Echo: ${r.echo}`, r.meaning].filter(Boolean).join('   ·   '), y + 20, S.width - M * 2, 11);
      y += 64;
      if (y > S.height - 80) break;
    }
  }

  // Key frames: up to 4 per slide.
  for (let i = 0; i < project.shots.length; i += 4) {
    doc.addPage(); dark();
    doc.text('KEY FRAMES', M, M + 10, { size: 10, bold: true, color: ACCENT });
    const cw = (S.width - M * 2 - 36) / 4;
    const ph = Math.min(cw * 16 / 9, S.height - 190);
    project.shots.slice(i, i + 4).forEach((s, j) => {
      const x = M + j * (cw + 12);
      const img = frame(s.frameAssetId);
      if (img) doc.imageCover(img, x, 70, cw, ph);
      else {
        doc.rect(x, 70, cw, ph, { fill: '#26233a' });
        wrapText(s.description, cw - 16, 9).slice(0, 14).forEach((l, li) => doc.text(l, x + 8, 92 + li * 12, { size: 9, color: '#aaa6b8' }));
      }
      doc.text(`${shotLabel(project, s)}  ${s.title}`.slice(0, 40), x, 70 + ph + 18, { size: 10, bold: true, color: '#ffffff' });
      if (s.lyric) wrapText(`“${s.lyric}”`, cw, 8.5).slice(0, 2).forEach((l, li) => doc.text(l, x, 70 + ph + 32 + li * 11, { size: 8.5, color: '#aaa6b8' }));
    });
  }

  const pg = progress(project);
  doc.addPage(); dark();
  heading('Production', `${project.shots.length} shots · ${new Set(project.shots.map((s) => s.location).filter(Boolean)).size} locations`);
  body(`${pg.done} of ${pg.total} shots captured so far. Full shot list, camera notes and checklist are in the ReaShoota shoot pack.`, 160);
  return doc.save();
}

export function renderPdf(kind, project, opts) {
  if (kind === 'storyboard') return renderStoryboardPdf(project, opts);
  if (kind === 'deck') return renderDeckPdf(project, opts);
  return renderFlowPdf(kind, project, opts);
}
