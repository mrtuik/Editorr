/**
 * "Kallaway" frames: black dot-grid background, a two-font title (bold sans + italic serif), and either
 *   steps   a numbered list: the point being spoken has a red bar and crisp text, the others are blurred
 *   script  a rounded script card (Hook / Body / CTA) where the spoken part has red bars
 * with the talking head in a rounded window at the bottom (or the right on a wide frame).
 *
 * Each frame is drawn ONCE here as a finished picture with the video window cut out (transparent), saved as a PNG and attached to a
 * documentary split beat (DocuBeat.image). The beat already moves the video into the window (docuShift), so the preview and the
 * native export both just show this picture: nothing is drawn twice and the two always match.
 * A step list becomes one beat per point, so the red bar follows what is being said.
 */
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { docuGeometry } from './docuRenderer';
import { docuLayoutFor, type DocuBeat } from './docuTypes';
import { uid } from './speaker';
import { aspectValue, type Aspect } from './types';

export type KallawayKind = 'steps' | 'script' | 'photo';

export interface KallawaySpec {
  kind: KallawayKind;
  /** title: bold part, italic serif part, and an optional second bold line, e.g. "The" + "Desire Hook" + "Method" */
  a: string;
  b: string;
  c: string;
  /** steps list only: one line per point (max 5) */
  steps: string[];
  /** small tag shown above the video window (an @handle). Empty = nothing. */
  handle: string;
  /** photo card only: the picture (data address or file address) shown in the card area */
  photo?: string;
  /** Share of the frame the card / picture takes: 0.5 = 50-50, 0.58 = Kallaway, 0.65 = big picture. Missing = the default for the frame shape. */
  share?: number;
  /** Which side the speaker window sits on: bottom/top on a tall frame, right/left on a wide one. Missing = bottom / right. */
  speaker?: 'bottom' | 'top' | 'right' | 'left';
  /** steps list only: timeline ms at which each point starts being spoken (from the captions). Missing = equal shares. */
  stepStarts?: number[];
}

/** The ratios the sheet offers (card share). */
export const KALLAWAY_SHARES: [number, string][] = [[0.5, '50-50'], [0.6, 'Kallaway'], [0.65, '65-35'], [0.72, '70-30']];

export const KALLAWAY_RED = '#D1121B';
/** Share of the frame the card takes; the video window gets the rest (the default split beat gives the card 45 %). */
const SHARE_TALL = 0.6;
const SHARE_WIDE = 0.52;
const RADIUS = 28;

const SANS = '"Inter","Noto Sans Bengali","Noto Sans Devanagari",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
const SERIF = '"Playfair Display","Georgia","Noto Serif Bengali","Noto Serif",serif';

function rr(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + k, y); g.lineTo(x + w - k, y); g.arcTo(x + w, y, x + w, y + k, k);
  g.lineTo(x + w, y + h - k); g.arcTo(x + w, y + h, x + w - k, y + h, k);
  g.lineTo(x + k, y + h); g.arcTo(x, y + h, x, y + h - k, k);
  g.lineTo(x, y + k); g.arcTo(x, y, x + k, y, k);
  g.closePath();
}

function wrapLines(g: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (cur && g.measureText(t).width > maxW) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const keep = lines.slice(0, maxLines);
    keep[maxLines - 1] = keep[maxLines - 1]!.replace(/[\s,.;:]+$/, '') + '...';
    return keep;
  }
  return lines;
}

/** Size (px) of the picture for this frame shape: short side 1080. */
export function kallawaySize(aspect: Aspect): { w: number; h: number } {
  const a = aspectValue(aspect);
  return a >= 1 ? { w: Math.round(1080 * a), h: 1080 } : { w: 1080, h: Math.round(1080 / a) };
}

function dotGrid(g: CanvasRenderingContext2D, w: number, h: number, k: number) {
  g.fillStyle = '#060607'; g.fillRect(0, 0, w, h);
  const step = Math.round(30 * k), r = Math.max(1.2, 1.6 * k);
  g.fillStyle = 'rgba(255,255,255,0.22)';
  for (let y = step / 2; y < h; y += step) for (let x = step / 2; x < w; x += step) g.fillRect(x - r / 2, y - r / 2, r, r);
  // soft darkening towards the edges so the card stands out
  const v = g.createRadialGradient(w / 2, h * 0.4, Math.min(w, h) * 0.3, w / 2, h * 0.4, Math.hypot(w, h) * 0.62);
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.3)');
  g.fillStyle = v; g.fillRect(0, 0, w, h);
}

/** Title: "The *Desire Hook*" (bold sans + italic serif on one line) and "Method" under it. Returns the y below the title. */
function drawTitle(g: CanvasRenderingContext2D, spec: KallawaySpec, cx: number, top: number, maxW: number, k: number): number {
  let size = Math.round(84 * k);
  const a = spec.a.trim(), b = spec.b.trim(), c = spec.c.trim();
  const sansFont = (px: number) => `900 ${px}px ${SANS}`, serifFont = (px: number) => `italic 500 ${Math.round(px * 1.08)}px ${SERIF}`;
  const lineW = (px: number) => {
    g.font = sansFont(px); const wa = a ? g.measureText(a + ' ').width : 0;
    g.font = serifFont(px); const wb = b ? g.measureText(b).width : 0;
    return wa + wb;
  };
  while (size > 30 * k && lineW(size) > maxW) size -= 3;
  g.textBaseline = 'alphabetic'; g.textAlign = 'left';
  let y = top + size;
  if (a || b) {
    const total = lineW(size);
    let x = cx - total / 2;
    g.fillStyle = '#fff';
    if (a) { g.font = sansFont(size); g.fillText(a + ' ', x, y); x += g.measureText(a + ' ').width; }
    if (b) { g.font = serifFont(size); g.fillText(b, x, y); }
    y += size * 0.2;
  }
  if (c) {
    g.textAlign = 'center'; g.font = sansFont(size); g.fillStyle = '#fff';
    y += size * 0.95;
    g.fillText(c, cx, y);
    y += size * 0.2;
  }
  return y;
}

function blurred(g: CanvasRenderingContext2D, px: number, draw: () => void) {
  const f = g as CanvasRenderingContext2D & { filter?: string };
  g.save();
  if (typeof f.filter === 'string') f.filter = `blur(${px}px)`;
  else g.globalAlpha *= 0.35; // no canvas blur on this phone: fade instead
  draw();
  g.restore();
}

function paintSteps(g: CanvasRenderingContext2D, spec: KallawaySpec, active: number, area: { x: number; y: number; w: number; h: number }, k: number) {
  const steps = spec.steps.filter((s) => s.trim()).slice(0, 5);
  const n = steps.length;
  if (!n) return;
  const gap = 14 * k;
  const rowH = Math.min(132 * k, (area.h - gap * (n - 1)) / n);
  const boxW = Math.min(area.w, 800 * k), boxX = area.x + (area.w - boxW) / 2;
  const font = Math.round(Math.min(46 * k, rowH * 0.36));
  steps.forEach((txt, i) => {
    const y = area.y + i * (rowH + gap);
    const isActive = i === active, card = isActive || active < 0;
    if (card) {
      g.save();
      g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 18 * k; g.shadowOffsetY = 6 * k;
      g.fillStyle = isActive ? '#2a2a2e' : '#222226';
      rr(g, boxX, y, boxW, rowH, 8 * k); g.fill();
      g.restore();
      g.fillStyle = KALLAWAY_RED;
      g.save(); rr(g, boxX, y, boxW, rowH, 8 * k); g.clip(); g.fillRect(boxX, y, 10 * k, rowH); g.restore();
    }
    // number: always crisp
    g.textAlign = 'left'; g.textBaseline = 'middle';
    g.font = `800 ${Math.round(font * 1.05)}px ${SANS}`;
    g.fillStyle = isActive ? '#fff' : card ? '#f0f0f2' : '#a9a9ae';
    g.fillText(String(i + 1).padStart(2, '0'), boxX + 38 * k, y + rowH / 2);
    // text: crisp for the spoken point, blurred for the rest
    const tx = boxX + 38 * k + font * 2.4, maxW = boxW - (tx - boxX) - 24 * k;
    g.font = `800 ${font}px ${SANS}`;
    const lines = wrapLines(g, txt, maxW, 2);
    const drawTxt = () => {
      g.fillStyle = '#fff'; g.textAlign = 'left'; g.textBaseline = 'middle';
      const lh = font * 1.08, y0 = y + rowH / 2 - ((lines.length - 1) * lh) / 2;
      lines.forEach((ln, j) => g.fillText(ln, tx, y0 + j * lh));
    };
    if (isActive) drawTxt(); else blurred(g, 5 * k, drawTxt);
  });
}

/** Deterministic line lengths so the "script" looks like writing. */
const BAR_LEN = [0.84, 0.9, 0.78, 0.6, 0.88, 0.7, 0.8, 0.94, 0.5, 0.82, 0.76, 0.66, 0.9, 0.72, 0.86, 0.58, 0.8];

function paintScript(g: CanvasRenderingContext2D, active: number, area: { x: number; y: number; w: number; h: number }, k: number) {
  const cardW = Math.min(area.w * 0.82, 760 * k), cardH = area.h;
  const x = area.x + (area.w - cardW) / 2, y = area.y;
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.55)'; g.shadowBlur = 36 * k; g.shadowOffsetY = 12 * k;
  g.fillStyle = '#18181C';
  rr(g, x, y, cardW, cardH, 24 * k); g.fill();
  g.restore();
  g.lineWidth = 2 * k; g.strokeStyle = 'rgba(255,255,255,0.28)';
  rr(g, x + k, y + k, cardW - 2 * k, cardH - 2 * k, 23 * k); g.stroke();
  // light reflection on the right edge
  const sp = g.createLinearGradient(0, y, 0, y + cardH);
  sp.addColorStop(0, 'rgba(255,255,255,0)'); sp.addColorStop(0.5, 'rgba(255,255,255,0.75)'); sp.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = sp; g.fillRect(x + cardW - 3 * k, y + cardH * 0.25, 3 * k, cardH * 0.5);

  const pad = 40 * k, innerW = cardW - pad * 2;
  g.textBaseline = 'alphabetic'; g.textAlign = 'center'; g.fillStyle = '#fff';
  g.font = `italic 500 ${Math.round(54 * k)}px ${SERIF}`;
  g.fillText('Script', x + cardW / 2, y + 74 * k);

  // sections share the rest of the card: Hook 4 lines, Body 14, CTA 3
  const sections: [string, number][] = [['Hook', 4], ['Body', 14], ['CTA', 3]];
  const labelH = 46 * k, secGap = 22 * k;
  const free = cardH - 112 * k - pad - labelH * 3 - secGap * 2;
  const lines = sections.reduce((a, s) => a + s[1], 0);
  const barH = Math.max(6 * k, Math.min(12 * k, free / lines * 0.42)), pitch = Math.min(free / lines, barH * 2.4);
  let yy = y + 112 * k;
  let li = 0;
  sections.forEach(([name, count], si) => {
    g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.fillStyle = '#fff';
    g.font = `800 ${Math.round(30 * k)}px ${SANS}`;
    g.fillText(name, x + pad, yy + 30 * k);
    yy += labelH;
    for (let i = 0; i < count; i++) {
      g.fillStyle = si === active ? KALLAWAY_RED : '#4b4b50';
      rr(g, x + pad, yy, innerW * BAR_LEN[li++ % BAR_LEN.length]!, barH, barH / 2); g.fill();
      yy += pitch;
    }
    yy += secGap;
  });
}

/** Photo card: the picture fills the card area (centre crop), rounded, with a soft shadow and a thin light edge. */
function paintPhoto(g: CanvasRenderingContext2D, img: HTMLImageElement | undefined, area: { x: number; y: number; w: number; h: number }, k: number) {
  const r = 22 * k;
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.55)'; g.shadowBlur = 36 * k; g.shadowOffsetY = 12 * k;
  g.fillStyle = '#18181C';
  rr(g, area.x, area.y, area.w, area.h, r); g.fill();
  g.restore();
  if (img && img.width > 0) {
    g.save();
    rr(g, area.x, area.y, area.w, area.h, r); g.clip();
    const sc = Math.max(area.w / img.width, area.h / img.height);
    g.drawImage(img, area.x + (area.w - img.width * sc) / 2, area.y + (area.h - img.height * sc) / 2, img.width * sc, img.height * sc);
    g.restore();
  }
  g.lineWidth = 2 * k; g.strokeStyle = 'rgba(255,255,255,0.22)';
  rr(g, area.x + k, area.y + k, area.w - 2 * k, area.h - 2 * k, r - k); g.stroke();
}

const shareFor = (spec: KallawaySpec, layout: 'side' | 'updown') => spec.share ?? (layout === 'updown' ? SHARE_TALL : SHARE_WIDE);
const posFor = (spec: KallawaySpec, layout: 'side' | 'updown'): 'bottom' | 'top' | 'right' | 'left' => {
  const want = spec.speaker;
  if (layout === 'updown') return want === 'top' ? 'top' : 'bottom';
  return want === 'left' ? 'left' : 'right';
};

/** Draws one finished frame on `g` (w x h), with the video window cut out. `active` = the point / section being spoken (-1 = none). `photo` = the loaded picture (photo card). */
export function paintKallaway(g: CanvasRenderingContext2D, spec: KallawaySpec, active: number, aspect: Aspect, w: number, h: number, photo?: HTMLImageElement) {
  const k = Math.min(w, h) / 1080;
  const layout = docuLayoutFor(aspect);
  const share = shareFor(spec, layout);
  const geo = docuGeometry(layout, posFor(spec, layout), w, h, share);
  dotGrid(g, w, h, k);
  const card = geo.card;
  const cx = card.x + card.w / 2;
  const hasTitle = !!(spec.a.trim() || spec.b.trim() || spec.c.trim());
  const below = hasTitle ? drawTitle(g, spec, cx, card.y + 26 * k, card.w * 0.92, k) : card.y + 6 * k;
  const pad = 18 * k;
  const handleRoom = (spec.handle.trim() ? 44 : 6) * k;
  const area = { x: card.x, y: below + pad, w: card.w, h: card.y + card.h - below - pad - handleRoom };
  if (area.h > 80 * k) {
    if (spec.kind === 'steps') paintSteps(g, spec, active, area, k);
    else if (spec.kind === 'photo') paintPhoto(g, photo, { x: area.x + 6 * k, y: area.y, w: area.w - 12 * k, h: area.h }, k);
    else paintScript(g, active, area, k);
  }
  if (spec.handle.trim()) {
    g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.fillStyle = '#fff';
    g.font = `800 ${Math.round(26 * k)}px ${SANS}`;
    // above the window; when the window is at the top of the frame there is no room above it, so the tag goes under it
    const y = geo.video.y > 60 * k ? geo.video.y - 14 * k : geo.video.y + geo.video.h + 34 * k;
    g.fillText(spec.handle.trim().toUpperCase(), geo.video.x + 8 * k, y);
  }
  // window for the talking head
  g.save();
  g.globalCompositeOperation = 'destination-out';
  rr(g, geo.video.x, geo.video.y, geo.video.w, geo.video.h, RADIUS * k);
  g.fillStyle = '#000'; g.fill();
  g.restore();
}


async function savePng(c: HTMLCanvasElement, id: string): Promise<{ url: string; path?: string }> {
  if (!Capacitor.isNativePlatform()) return { url: c.toDataURL('image/png') };
  const png = c.toDataURL('image/png');
  const rel = `broll/${id}.png`;
  const wr = await Filesystem.writeFile({ path: rel, data: png.slice(png.indexOf(',') + 1), directory: Directory.Data, recursive: true });
  const uri = wr.uri || (await Filesystem.getUri({ path: rel, directory: Directory.Data })).uri;
  return { url: Capacitor.convertFileSrc(uri), path: uri.replace(/^file:\/\//, '') };
}

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'you', 'your', 'are', 'but', 'from', 'have', 'then', 'into', 'will']);
const toks = (t: string) => t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((x) => x.length > 2 && !STOP.has(x));

/**
 * Finds when each point of a step list is spoken, from the captions: for each point it looks (after the previous point)
 * for the first place where at least 2 of its key words (1 if it has only one) come within 8 words of each other.
 * The first point always starts at `start`; a point that is not found is spread evenly between its neighbours.
 * Returns undefined when fewer than 2 points could be matched (then the caller uses equal shares).
 */
export function syncStepStarts(steps: string[], words: { w: string; orig: string; s: number }[] | undefined, start: number, end: number): number[] | undefined {
  if (!words?.length || steps.length < 2) return undefined;
  const ws = words.filter((x) => x.s >= start - 500 && x.s < end).map((x) => ({ t: new Set([...toks(x.w), ...toks(x.orig)]), s: x.s }));
  if (ws.length < 4) return undefined;
  const found: (number | undefined)[] = steps.map(() => undefined);
  let from = 0, matched = 0;
  steps.forEach((st, i) => {
    const keys = [...new Set(toks(st))];
    if (!keys.length) return;
    const need = Math.min(2, keys.length);
    // first try to start on the point's first key word (so a repeated word from the previous point does not match early), then on any key word
    for (const strict of [true, false]) {
      let ok = false;
      for (let j = from; j < ws.length && !ok; j++) {
        const hit = new Set<string>();
        for (let q = j; q < Math.min(ws.length, j + 8); q++) for (const kx of keys) if (ws[q]!.t.has(kx)) hit.add(kx);
        const starts = strict ? ws[j]!.t.has(keys[0]!) : keys.some((kx) => ws[j]!.t.has(kx));
        if (hit.size >= need && starts) { found[i] = ws[j]!.s; from = j + 1; matched++; ok = true; }
      }
      if (ok) break;
    }
  });
  if (matched < 2) return undefined;
  const out: number[] = [];
  for (let i = 0; i < steps.length; i++) {
    if (i === 0) { out.push(start); continue; }
    const f = found[i];
    if (f != null) { out.push(Math.max(out[i - 1]! + 600, Math.round(f - 150))); continue; }
    // spread between the previous start and the next found one (or the end)
    let nx = i + 1; while (nx < steps.length && found[nx] == null) nx++;
    const hi = nx < steps.length ? found[nx]! - 150 : end, lo = out[i - 1]!, gaps = nx - i + 1;
    out.push(Math.round(lo + (hi - lo) / gaps));
  }
  return out.map((v) => Math.min(Math.max(v, start), end - 300));
}

function loadPhoto(src: string): Promise<HTMLImageElement | undefined> {
  return new Promise((res) => {
    const img = new Image();
    const t = window.setTimeout(() => res(undefined), 8000);
    img.onload = () => { window.clearTimeout(t); res(img); };
    img.onerror = () => { window.clearTimeout(t); res(undefined); };
    img.src = src;
  });
}

/**
 * Builds the beats for [start, end): one per step (steps), three (Hook, Body, CTA) or one (photo).
 * Steps start at `spec.stepStarts` when given (synced to the speech), else each gets an equal share.
 * The caller puts them on p.docu (after removing docu beats that overlap).
 */
export async function makeKallawayBeats(aspect: Aspect, spec: KallawaySpec, start: number, end: number): Promise<DocuBeat[]> {
  const steps = spec.steps.filter((s) => s.trim()).slice(0, 5);
  const count = spec.kind === 'steps' ? steps.length : spec.kind === 'photo' ? 1 : 3;
  if (!count) throw new Error('Add at least one point.');
  let photo: HTMLImageElement | undefined;
  if (spec.kind === 'photo') {
    if (!spec.photo) throw new Error('Pick a picture first.');
    photo = await loadPhoto(spec.photo);
    if (!photo) throw new Error('Could not open that picture.');
  }
  // the fonts must be ready before the picture is drawn
  try {
    await Promise.all([
      (document as unknown as { fonts?: { load: (f: string) => Promise<unknown> } }).fonts?.load('900 40px "Inter"'),
      (document as unknown as { fonts?: { load: (f: string) => Promise<unknown> } }).fonts?.load('italic 500 40px "Playfair Display"'),
    ]);
  } catch { /* offline: the fallback fonts are used */ }
  const { w, h } = kallawaySize(aspect);
  const layout = docuLayoutFor(aspect);
  const share = shareFor(spec, layout), pos = posFor(spec, layout);
  const per = (end - start) / count;
  const starts: number[] = [];
  const sync = spec.kind === 'steps' && spec.stepStarts?.length === count ? spec.stepStarts : undefined;
  for (let i = 0; i < count; i++) starts.push(sync ? Math.round(sync[i]!) : Math.round(start + per * i));
  const out: DocuBeat[] = [];
  for (let i = 0; i < count; i++) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    if (!g) throw new Error('Could not draw the card.');
    paintKallaway(g, { ...spec, steps }, i, aspect, w, h, photo);
    const id = uid();
    const image = await savePng(c, `kw_${id}`);
    const label = [spec.a, spec.b, spec.c].map((x) => x.trim()).filter(Boolean).join(' ');
    out.push({
      id, type: 'split_screen', start: starts[i]!, end: i === count - 1 ? Math.round(end) : starts[i + 1]!,
      layout, video_position: pos, card_radius: RADIUS,
      headline: label || (spec.kind === 'photo' ? 'Picture' : 'Kallaway'),
      subtext: spec.kind === 'steps' ? steps[i] : spec.kind === 'photo' ? 'Picture' : ['Hook', 'Body', 'CTA'][i], accent_color: KALLAWAY_RED, theme: 'noir',
      share, image,
    });
  }
  return out;
}
