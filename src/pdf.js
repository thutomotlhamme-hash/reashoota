// Minimal, dependency-free PDF writer: Helvetica text (WinAnsi), rectangles, lines and JPEG
// images. Enough for shot lists, storyboards and decks, and it works fully offline.
// The public API uses top-left coordinates in points (1/72 inch).

const HELVETICA = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const HELVETICA_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

export const PAGE_A4 = { width: 595.28, height: 841.89 };
export const PAGE_A4_LANDSCAPE = { width: 841.89, height: 595.28 };

const WIN_ANSI = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89,
  'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95,
  '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};
const ASCII_FALLBACK = { '→': '->', '←': '<-', '✓': '[x]', '✔': '[x]', '☐': '[ ]', '★': '*' };

// Map a JS string to WinAnsi byte codes. Characters the standard fonts can't draw become '?';
// emoji and variation selectors are dropped silently.
export function encodeWinAnsi(str) {
  const codes = [];
  for (const raw of String(str).normalize('NFC')) {
    const ch = ASCII_FALLBACK[raw] ?? raw;
    for (const c of ch) {
      const cp = c.codePointAt(0);
      if (cp > 0xffff || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x200d) continue;
      if (cp === 9) codes.push(32);
      else if (cp >= 32 && cp <= 126) codes.push(cp);
      else if (WIN_ANSI[c] !== undefined) codes.push(WIN_ANSI[c]);
      else if (cp >= 0xa0 && cp <= 0xff) codes.push(cp);
      else if (cp >= 32) codes.push(63);
    }
  }
  return codes;
}

function charWidth(code, bold) {
  const table = bold ? HELVETICA_BOLD : HELVETICA;
  if (code >= 32 && code <= 126) return table[code - 32];
  if (code === 0x95) return 350; // bullet
  if (code === 0x96) return 556;
  if (code === 0x97) return 1000;
  if (code >= 0x91 && code <= 0x94) return bold ? 278 : 222;
  return 556;
}

export function textWidth(str, size, bold = false) {
  let w = 0;
  for (const c of encodeWinAnsi(str)) w += charWidth(c, bold);
  return (w * size) / 1000;
}

// Greedy word wrap; words longer than the line are broken by character.
export function wrapText(str, maxWidth, size, bold = false) {
  const lines = [];
  for (const para of String(str ?? '').split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, size, bold) <= maxWidth) { line = candidate; continue; }
      if (line) lines.push(line);
      if (textWidth(word, size, bold) <= maxWidth) { line = word; continue; }
      let chunk = '';
      for (const ch of word) {
        if (textWidth(chunk + ch, size, bold) > maxWidth && chunk) { lines.push(chunk); chunk = ''; }
        chunk += ch;
      }
      line = chunk;
    }
    lines.push(line);
  }
  return lines;
}

function pdfString(str) {
  let out = '(';
  for (const c of encodeWinAnsi(str)) {
    if (c === 40 || c === 41 || c === 92) out += `\\${String.fromCharCode(c)}`;
    else if (c < 32 || c > 126) out += `\\${c.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(c);
  }
  return `${out})`;
}

// Document-level strings (title, author) use UTF-16BE so any script shows correctly
// in the PDF viewer's info panel.
function pdfTextString(str) {
  let hex = 'FEFF';
  for (let i = 0; i < String(str).length; i += 1) hex += String(str).charCodeAt(i).toString(16).padStart(4, '0');
  return `<${hex.toUpperCase()}>`;
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return [0, 0, 0];
  let v = m[1];
  if (v.length === 3) v = v.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
}

const num = (n) => (Math.round(n * 100) / 100).toString();
const rgb = (hex) => hexToRgb(hex).map(num).join(' ');

// Reads pixel size from a baseline or progressive JPEG header.
export function jpegSize(bytes) {
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) { i += 1; continue; }
    const marker = bytes[i + 1];
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return {
        height: (bytes[i + 5] << 8) | bytes[i + 6],
        width: (bytes[i + 7] << 8) | bytes[i + 8],
        components: bytes[i + 9],
      };
    }
    i += 2 + len;
  }
  throw new Error('Not a JPEG image');
}

export class PdfDocument {
  constructor({ width = PAGE_A4.width, height = PAGE_A4.height, title = '', author = '' } = {}) {
    this.size = { width, height };
    this.meta = { title, author };
    this.pages = [];
    this.images = [];
    this.page = null;
  }

  get width() { return this.page.width; }

  get height() { return this.page.height; }

  addPage(size = this.size) {
    this.page = { width: size.width, height: size.height, ops: [] };
    this.pages.push(this.page);
    return this.page;
  }

  #op(s) {
    if (!this.page) this.addPage();
    this.page.ops.push(s);
  }

  rect(x, y, w, h, { fill, stroke, lineWidth = 1 } = {}) {
    const Y = this.height - y - h;
    if (fill) this.#op(`${rgb(fill)} rg ${num(x)} ${num(Y)} ${num(w)} ${num(h)} re f`);
    if (stroke) this.#op(`${num(lineWidth)} w ${rgb(stroke)} RG ${num(x)} ${num(Y)} ${num(w)} ${num(h)} re S`);
  }

  line(x1, y1, x2, y2, { color = '#000000', lineWidth = 1 } = {}) {
    const H = this.height;
    this.#op(`${num(lineWidth)} w ${rgb(color)} RG ${num(x1)} ${num(H - y1)} m ${num(x2)} ${num(H - y2)} l S`);
  }

  // y is the text baseline, measured from the top of the page.
  text(str, x, y, { size = 11, bold = false, color = '#111111' } = {}) {
    if (str === '' || str == null) return;
    this.#op(`BT ${rgb(color)} rg /${bold ? 'F2' : 'F1'} ${num(size)} Tf ${num(x)} ${num(this.height - y)} Td ${pdfString(str)} Tj ET`);
  }

  // Registers a JPEG once; returns a handle usable with image().
  addJpeg(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const { width, height, components } = jpegSize(data);
    const img = { name: `Im${this.images.length + 1}`, data, width, height, components };
    this.images.push(img);
    return img;
  }

  image(img, x, y, w, h) {
    this.#op(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(this.height - y - h)} cm /${img.name} Do Q`);
  }

  // Draws `img` scaled to cover the box (cropping the overflow), like CSS object-fit: cover.
  imageCover(img, x, y, w, h) {
    const scale = Math.max(w / img.width, h / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    const H = this.height;
    this.#op(`q ${num(x)} ${num(H - y - h)} ${num(w)} ${num(h)} re W n`);
    this.#op(`${num(dw)} 0 0 ${num(dh)} ${num(x + (w - dw) / 2)} ${num(H - y - h + (h - dh) / 2)} cm /${img.name} Do Q`);
  }

  save() {
    if (!this.pages.length) this.addPage();
    const enc = new TextEncoder();
    const chunks = [];
    const offsets = [];
    let length = 0;
    const push = (part) => {
      const bytes = typeof part === 'string' ? enc.encode(part) : part;
      chunks.push(bytes);
      length += bytes.length;
    };
    const obj = (id, body) => {
      offsets[id] = length;
      push(`${id} 0 obj\n`);
      for (const b of [].concat(body)) push(b);
      push('\nendobj\n');
    };

    // Object numbering: 1 catalog, 2 pages, 3-4 fonts, 5 info, then images, then pages.
    const firstImage = 6;
    const firstPage = firstImage + this.images.length;
    const pageIds = this.pages.map((_, i) => firstPage + i * 2);

    push('%PDF-1.4\n');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
    obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    obj(5, `<< /Title ${pdfTextString(this.meta.title)} /Author ${pdfTextString(this.meta.author)} /Producer (ReaShoota) >>`);

    this.images.forEach((img, i) => {
      const cs = img.components === 1 ? '/DeviceGray' : img.components === 4 ? '/DeviceCMYK' : '/DeviceRGB';
      obj(firstImage + i, [
        `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.data.length} >>\nstream\n`,
        img.data,
        '\nendstream',
      ]);
    });

    const xobjects = this.images.map((img, i) => `/${img.name} ${firstImage + i} 0 R`).join(' ');
    this.pages.forEach((page, i) => {
      const pageId = pageIds[i];
      const content = enc.encode(page.ops.join('\n'));
      obj(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobjects ? ` /XObject << ${xobjects} >>` : ''} >> /Contents ${pageId + 1} 0 R >>`);
      obj(pageId + 1, [`<< /Length ${content.length} >>\nstream\n`, content, '\nendstream']);
    });

    const count = firstPage + this.pages.length * 2;
    const xref = length;
    let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (let id = 1; id < count; id += 1) table += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    push(table);
    push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

    const out = new Uint8Array(length);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }
}
