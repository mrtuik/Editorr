/**
 * Draws one B-roll beat on the transparent canvas over the video (preview).
 * EditorrNativePlugin.BrollOverlay repeats the same picture for the export.
 *
 * The beat is first painted ONCE into a frame-sized layer (dimming, shadow, rounded photo, vignette).
 * Each frame then only moves that layer (scale, sideways shift, fade): cheap, and the same thing the export does.
 */
import { Capacitor } from '@capacitor/core';
import { BROLL_SCRIM, BROLL_VIGNETTE, brollAlpha, brollBox, brollMotionAt, brollRadiusPx, type BrollBeat } from './brollTypes';

const srcOf = (b: BrollBeat) => (b.path ? Capacitor.convertFileSrc('file://' + b.path) : b.url);

const images = new Map<string, { img: HTMLImageElement; state: 'loading' | 'ok' | 'bad' }>();
const layers = new Map<string, HTMLCanvasElement>();

function loadImage(src: string, onLoad: () => void): HTMLImageElement | undefined {
  let e = images.get(src);
  if (!e) {
    const img = new Image();
    e = { img, state: 'loading' };
    images.set(src, e);
    img.onload = () => { e!.state = 'ok'; onLoad(); };
    img.onerror = () => { e!.state = 'bad'; };
    img.src = src;
    if (images.size > 24) { const k = images.keys().next().value; if (k !== undefined && k !== src) images.delete(k); }
  }
  return e.state === 'ok' ? e.img : undefined;
}

function roundRectPath(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + k, y);
  g.arcTo(x + w, y, x + w, y + h, k);
  g.arcTo(x + w, y + h, x, y + h, k);
  g.arcTo(x, y + h, x, y, k);
  g.arcTo(x, y, x + w, y, k);
  g.closePath();
}

/** Paints the still layer of a beat into `g` (w x h). Same recipe as BrollOverlay.render in Java. */
export function paintBrollLayer(g: CanvasRenderingContext2D, img: CanvasImageSource & { width: number; height: number }, b: BrollBeat, w: number, h: number) {
  const box = brollBox(b.frame, w, h), r = brollRadiusPx(b, w, h), k = Math.min(w, h) / 1080;
  const card = b.frame === 'card';
  if (card) {
    g.fillStyle = `rgba(0,0,0,${BROLL_SCRIM})`;
    g.fillRect(0, 0, w, h);
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.55)'; g.shadowBlur = 48 * k; g.shadowOffsetY = 14 * k;
    g.fillStyle = '#000';
    roundRectPath(g, box.x, box.y, box.w, box.h, r); g.fill();
    g.restore();
  }
  g.save();
  roundRectPath(g, box.x, box.y, box.w, box.h, r);
  g.clip();
  const iw = img.width || 1, ih = img.height || 1;
  const sc = Math.max(box.w / iw, box.h / ih);
  const dw = iw * sc, dh = ih * sc;
  g.drawImage(img, box.x + (box.w - dw) / 2, box.y + (box.h - dh) / 2, dw, dh);
  if (card) {
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2, rad = Math.hypot(box.w, box.h) / 2;
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
    grad.addColorStop(0, 'rgba(0,0,0,0)'); grad.addColorStop(0.55, 'rgba(0,0,0,0)'); grad.addColorStop(1, `rgba(0,0,0,${BROLL_VIGNETTE})`);
    g.fillStyle = grad;
    g.fillRect(box.x, box.y, box.w, box.h);
  }
  g.restore();
}

function layerFor(b: BrollBeat, w: number, h: number, onLoad: () => void): HTMLCanvasElement | undefined {
  const src = srcOf(b);
  const key = `${b.id}|${src}|${b.frame}|${b.radius}|${w}x${h}`;
  const hit = layers.get(key);
  if (hit) return hit;
  const img = loadImage(src, onLoad);
  if (!img) return undefined;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  if (!g) return undefined;
  paintBrollLayer(g, img, b, w, h);
  layers.set(key, c);
  if (layers.size > 4) { const old = layers.keys().next().value; if (old !== undefined) layers.delete(old); }
  return c;
}

/** Draws the beat at `ms` on the preview canvas. Redraws itself through `onLoad` when the picture has just arrived. */
export function drawBrollFrame(g: CanvasRenderingContext2D, b: BrollBeat, ms: number, w: number, h: number, onLoad: () => void) {
  const layer = layerFor(b, w, h, onLoad);
  if (!layer) return;
  const { s, tx } = brollMotionAt(b.motion, (ms - b.start) / Math.max(1, b.end - b.start));
  g.save();
  g.globalAlpha = brollAlpha(b, ms);
  g.translate(w / 2 + tx * w, h / 2);
  g.scale(s, s);
  g.translate(-w / 2, -h / 2);
  g.drawImage(layer, 0, 0);
  g.restore();
}

/** What the native export gets: only beats whose picture is saved on the phone. */
export function exportBroll(beats: BrollBeat[] | undefined, outW: number, outH: number) {
  const out: unknown[] = [];
  for (const b of beats ?? []) {
    if (!b.path || b.end - b.start < 300) continue;
    const box = brollBox(b.frame, outW, outH);
    out.push({
      s: Math.round(b.start), e: Math.round(b.end), path: b.path, frame: b.frame, motion: b.motion,
      radius: brollRadiusPx(b, outW, outH), box, scrim: b.frame === 'card' ? BROLL_SCRIM : 0, vignette: b.frame === 'card' ? BROLL_VIGNETTE : 0,
      shadowBlur: 48 * Math.min(outW, outH) / 1080, shadowDy: 14 * Math.min(outW, outH) / 1080,
    });
  }
  return out.length ? out : undefined;
}
