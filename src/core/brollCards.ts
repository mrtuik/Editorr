/**
 * B-roll cards the app draws itself (no download, no key):
 *   Concept card  a black card with one big number or phrase, a thin accent bar and (when the text says up or down) a faint trend line
 *   Article card a paper clipping of a Wikipedia article: headline, first sentences, the key words marked with a yellow highlighter
 * Both are saved as a PNG in the app's files folder (broll/) so the export reads them like any photo.
 * In the browser (no Android app) the PNG stays a data address inside the beat.
 */
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import type { ArticleItem } from './brollEngine';
import { uid } from './speaker';

export interface CardResult { id: string; url: string; thumb: string; path?: string; width: number; height: number; title: string }

const isNative = () => Capacitor.isNativePlatform();
const SANS = '"Inter","Noto Sans Bengali","Noto Sans Devanagari",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
const SERIF = '"Georgia","Noto Serif Bengali","Noto Serif",serif';

/** Card size for a video of this shape (short side 1080), so a vertical video gets a vertical card. */
export function cardSize(aspect: number): { w: number; h: number } {
  const a = aspect > 0 ? aspect : 16 / 9;
  if (a >= 1) return { w: Math.round(1080 * Math.min(a, 2.4)), h: 1080 };
  return { w: 1080, h: Math.round(1080 / Math.max(a, 0.4)) };
}

function wrapLines(g: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (g.measureText(t).width <= maxW || !line) line = t;
    else { lines.push(line); line = w; if (lines.length >= maxLines) break; }
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (words.length && lines.length === maxLines) {
    const used = lines.join(' ').split(/\s+/).length;
    if (used < words.length) {
      let last = lines[maxLines - 1]!;
      while (last.length > 1 && g.measureText(last + '...').width > maxW) last = last.slice(0, -1);
      lines[maxLines - 1] = last.replace(/[\s,.;:]+$/, '') + '...';
    }
  }
  return lines;
}

/** Biggest font size (px, down to `min`) at which `text` fits on one line of `maxW`. */
function fitFont(g: CanvasRenderingContext2D, text: string, weight: string, family: string, start: number, min: number, maxW: number): number {
  let size = start;
  for (; size > min; size -= 4) { g.font = `${weight} ${size}px ${family}`; if (g.measureText(text).width <= maxW) break; }
  g.font = `${weight} ${size}px ${family}`;
  return size;
}

async function save(c: HTMLCanvasElement, title: string): Promise<CardResult> {
  const id = `card_${uid()}`;
  const small = document.createElement('canvas');
  const k = 200 / Math.max(c.width, c.height);
  small.width = Math.max(1, Math.round(c.width * k)); small.height = Math.max(1, Math.round(c.height * k));
  small.getContext('2d')?.drawImage(c, 0, 0, small.width, small.height);
  const thumbData = small.toDataURL('image/jpeg', 0.7);
  if (!isNative()) {
    const data = c.toDataURL('image/jpeg', 0.88);
    return { id, url: data, thumb: thumbData, width: c.width, height: c.height, title };
  }
  const png = c.toDataURL('image/png');
  const rel = `broll/${id}.png`;
  const wr = await Filesystem.writeFile({ path: rel, data: png.slice(png.indexOf(',') + 1), directory: Directory.Data, recursive: true });
  const uri = wr.uri || (await Filesystem.getUri({ path: rel, directory: Directory.Data })).uri;
  const path = uri.replace(/^file:\/\//, '');
  return { id, url: Capacitor.convertFileSrc(uri), thumb: thumbData, path, width: c.width, height: c.height, title };
}

// ---------------------------------------------------------------- concept card

export interface ConceptSpec {
  /** the big part: a number ("40%") or 1 to 3 words */
  big: string;
  /** the small line under it */
  label?: string;
  trend?: 'up' | 'down';
}

const NUM_RX = /([$€£₹৳¥]\s?)?\d[\d,]*(?:\.\d+)?\s?(?:%|percent|per cent|million|billion|trillion|thousand|crore|lakh|k|x|times)?/i;
const UP_RX = /\b(rise|rises|rose|rising|up|surge|surged|soar|soared|jump|jumped|grow|grew|growth|increase|increased|gain|gained|boom|record high|doubled|tripled)\b|বাড়|ঊর্ধ্ব|বৃদ্ধি/i;
const DOWN_RX = /\b(fall|falls|fell|falling|drop|dropped|crash|crashed|plunge|plunged|collapse|collapsed|decline|declined|lose|lost|slump|slumped|down|halved|bankrupt)\b|কমে|ধস|পতন|পড়ে/i;

/** Works out the big text, the small line and the trend from a beat's words. `fallback` is the search keyword. */
export function conceptFromText(text: string, fallback = ''): ConceptSpec {
  const clean = text.replace(/\s+/g, ' ').trim();
  const m = clean.match(NUM_RX);
  const trend: 'up' | 'down' | undefined = DOWN_RX.test(clean) ? 'down' : UP_RX.test(clean) ? 'up' : undefined;
  if (m && m[0].trim().length >= 1) {
    const big = m[0].trim().replace(/\s?(percent|per cent)$/i, '%').toUpperCase();
    const rest = clean.replace(m[0], ' ').replace(/\s+/g, ' ').trim();
    return { big, label: rest.slice(0, 90), trend };
  }
  const kw = (fallback || clean).split(/\s+/).slice(0, 3).join(' ');
  return { big: kw.toUpperCase(), label: clean.slice(0, 90), trend };
}

export async function makeConceptCard(spec: ConceptSpec, aspect: number): Promise<CardResult> {
  const { w, h } = cardSize(aspect);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  const accent = spec.trend === 'up' ? '#2ee59d' : spec.trend === 'down' ? '#ff4d5e' : '#ffd23f';
  const short = Math.min(w, h), k = short / 1080;

  g.fillStyle = '#08080c'; g.fillRect(0, 0, w, h);
  const rg = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.hypot(w, h) / 2);
  rg.addColorStop(0, 'rgba(255,255,255,0.07)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = rg; g.fillRect(0, 0, w, h);

  if (spec.trend) {
    // faint trend line behind the text
    const pts = spec.trend === 'up' ? [0.78, 0.7, 0.74, 0.58, 0.6, 0.44, 0.46, 0.28, 0.2] : [0.2, 0.3, 0.26, 0.42, 0.4, 0.58, 0.56, 0.74, 0.82];
    g.save();
    g.strokeStyle = accent; g.globalAlpha = 0.28; g.lineWidth = 14 * k; g.lineJoin = 'round'; g.lineCap = 'round';
    g.beginPath();
    pts.forEach((v, i) => { const x = w * (0.06 + 0.88 * (i / (pts.length - 1))), y = h * v; if (i) g.lineTo(x, y); else g.moveTo(x, y); });
    g.stroke();
    g.restore();
  }

  g.textAlign = 'center'; g.textBaseline = 'middle';
  const maxW = w * 0.84;
  const big = spec.big.slice(0, 28);
  fitFont(g, big, '900', SANS, Math.round(300 * k), Math.round(90 * k), maxW);
  const bigSize = parseInt(g.font.match(/(\d+)px/)?.[1] ?? '120', 10);
  const midY = h * (spec.label ? 0.43 : 0.5);
  g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 30 * k;
  g.fillStyle = '#ffffff';
  g.fillText(big, w / 2, midY);
  g.shadowBlur = 0;

  // accent bar
  const barW = Math.min(maxW * 0.28, 220 * k), barY = midY + bigSize * 0.62;
  g.fillStyle = accent;
  g.fillRect(w / 2 - barW / 2, barY, barW, 10 * k);

  if (spec.label) {
    g.font = `600 ${Math.round(54 * k)}px ${SANS}`;
    g.fillStyle = 'rgba(255,255,255,0.78)';
    const lines = wrapLines(g, spec.label, maxW, 3);
    lines.forEach((ln, i) => g.fillText(ln, w / 2, barY + 70 * k + i * 70 * k));
  }
  return save(c, spec.big);
}

// ---------------------------------------------------------------- article card

function loadImg(src: string): Promise<HTMLImageElement | undefined> {
  return new Promise((res) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const t = window.setTimeout(() => res(undefined), 8000);
    img.onload = () => { window.clearTimeout(t); res(img); };
    img.onerror = () => { window.clearTimeout(t); res(undefined); };
    img.src = src;
  });
}

/** A paper clipping of a Wikipedia article. `keywords` are marked with a highlighter. 4:5 shape; the blur frame fits it whole. */
export async function makeArticleCard(a: ArticleItem, keywords: string): Promise<CardResult> {
  const W = 1200, H = 1500;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f5f2ea'; g.fillRect(0, 0, W, H);
  // paper edge shade
  const sh = g.createLinearGradient(0, 0, W, 0);
  sh.addColorStop(0, 'rgba(0,0,0,0.07)'); sh.addColorStop(0.04, 'rgba(0,0,0,0)'); sh.addColorStop(0.96, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(0,0,0,0.07)');
  g.fillStyle = sh; g.fillRect(0, 0, W, H);

  const padX = 90;
  let y = 96;
  g.textBaseline = 'alphabetic'; g.textAlign = 'left';
  g.fillStyle = '#6b6b6b'; g.font = `700 30px ${SANS}`;
  g.fillText('WIKIPEDIA', padX, y);
  g.font = `400 30px ${SANS}`;
  g.fillText('  ·  The Free Encyclopedia', padX + g.measureText('WIKIPEDIA').width, y);
  y += 26;
  g.fillStyle = '#1a1a1a'; g.fillRect(padX, y, W - 2 * padX, 4);
  y += 86;

  // headline
  g.fillStyle = '#111';
  g.font = `800 82px ${SERIF}`;
  const head = wrapLines(g, a.title, W - 2 * padX, 3);
  for (const ln of head) { g.fillText(ln, padX, y); y += 96; }
  y += 6;
  g.fillStyle = '#c9c4b6'; g.fillRect(padX, y, W - 2 * padX, 2);
  y += 54;

  // lead photo
  if (a.thumb) {
    const img = await loadImg(a.thumb);
    if (img && img.width > 0) {
      const bw = W - 2 * padX, bh = 430;
      const sc = Math.max(bw / img.width, bh / img.height);
      g.save();
      g.beginPath(); g.rect(padX, y, bw, bh); g.clip();
      g.drawImage(img, padX + (bw - img.width * sc) / 2, y + (bh - img.height * sc) / 2, img.width * sc, img.height * sc);
      g.restore();
      y += bh + 50;
    }
  }

  // body with highlighter on the key words
  const keys = keywords.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 2);
  g.font = `400 42px ${SERIF}`;
  const lineH = 64, maxW = W - 2 * padX;
  const maxLines = Math.max(3, Math.floor((H - 120 - y) / lineH));
  const words = a.extract.split(/\s+/);
  let x = padX, line = 0;
  const space = g.measureText(' ').width;
  outer:
  for (let i = 0; i < words.length; i++) {
    const wd = words[i]!;
    const wW = g.measureText(wd).width;
    if (x + wW > padX + maxW && x > padX) { x = padX; line++; }
    if (line >= maxLines) break outer;
    const last = line === maxLines - 1;
    let text = wd;
    if (last && i < words.length - 1 && x + wW + g.measureText(' ...').width > padX + maxW) text = wd + '...';
    const bare = wd.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    if (bare && keys.includes(bare)) { g.fillStyle = 'rgba(255,214,10,0.78)'; g.fillRect(x - 4, y + line * lineH - 40, wW + 8, 52); }
    g.fillStyle = '#1c1c1c';
    g.fillText(text, x, y + line * lineH);
    x += wW + space;
    if (text !== wd) break outer;
  }
  return save(c, a.title);
}
