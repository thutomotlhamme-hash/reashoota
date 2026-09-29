// Getting files onto the phone. On iPhone the Web Share API opens the native share sheet,
// which offers Save Image / Save Video (Photos), Save to Files, AirDrop, Messages, WhatsApp,
// Mail and any other installed app. Desktop browsers fall back to a normal download.

export const MIME = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  png: 'image/png',
  jpg: 'image/jpeg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  json: 'application/json',
};

export function makeFile(data, name, type) {
  return new File([data], name, { type, lastModified: Date.now() });
}

export const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches
  || navigator.standalone === true;

export function canShareFiles(files) {
  try {
    return !!navigator.canShare && navigator.canShare({ files });
  } catch {
    return false;
  }
}

// Opens the share sheet with the files only — no title/text — because iOS hides
// "Save Image"/"Save Video" when text is attached. Returns 'shared' | 'cancelled' | 'unsupported'.
export async function saveToPhone(files) {
  const list = [].concat(files);
  if (!canShareFiles(list)) return 'unsupported';
  try {
    await navigator.share({ files: list });
    return 'shared';
  } catch (err) {
    if (err?.name === 'AbortError') return 'cancelled';
    throw err;
  }
}

// Share with a message for chat apps / email.
export async function shareFiles(files, { title, text } = {}) {
  const list = [].concat(files);
  if (!canShareFiles(list)) return 'unsupported';
  try {
    await navigator.share({ files: list, title, text });
    return 'shared';
  } catch (err) {
    if (err?.name === 'AbortError') return 'cancelled';
    throw err;
  }
}

export async function shareText({ title, text, url }) {
  if (!navigator.share) return 'unsupported';
  try {
    await navigator.share({ title, text, url });
    return 'shared';
  } catch (err) {
    if (err?.name === 'AbortError') return 'cancelled';
    throw err;
  }
}

// Classic download. iOS Safari saves to Files › Downloads; in the home-screen app (standalone)
// downloads are unreliable, so we open the file in a new view where long-press/share works.
export function downloadFile(file) {
  const url = URL.createObjectURL(file);
  if (isIOS() && isStandalone()) {
    window.open(url, '_blank');
  } else {
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for older iOS / non-secure contexts.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

export function formatBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}
