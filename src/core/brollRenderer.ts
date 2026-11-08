/**
 * Draws one B-roll beat on the transparent canvas over the video (preview).
 * EditorrNativePlugin.BrollOverlay repeats the same picture for the export.
 *
 * The beat is first painted ONCE into a frame-sized layer (dimming, shadow, rounded photo, vignette).
 * Each frame then only moves that layer (scale, sideways shift, fade): cheap, and the same thing the export does.
 */
import { Capacitor } from '@capacitor/core';
import { BROLL_BLUR_DIM, BROLL_BLUR_DIV, BROLL_SCRIM, BROLL_VIGNETTE, brollAlpha, brollBox, brollContain, brollMotionAt, brollRadiusPx, isBrollVideo, type BrollBeat } from './brollTypes';

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

/**
 * Blur frame: a blurred copy of the picture fills the frame (made tiny, then stretched back: the same trick as the export, so both match),
 * darkened, and the WHOLE picture sits in front with rounded corners and a shadow. Nothing of the picture is cropped.
 */
function paintBlurFrame(g: CanvasRenderingContext2D, img: CanvasImageSource & { width: number; height: number }, b: BrollBeat, w: number, h: number) {
  const iw = img.width || 1, ih = img.height || 1, k = Math.min(w, h) / 1080;
  const tw = Math.max(8, Math.round(w / BROLL_BLUR_DIV)), th = Math.max(8, Math.round(h / BROLL_BLUR_DIV));
  const t = document.createElement('canvas');
  t.width = tw; t.height = th;
  const tg = t.getContext('2d');
  if (tg) {
    tg.imageSmoothingEnabled = true; tg.imageSmoothingQuality = 'high';
    const sc = Math.max(tw / iw, th / ih);
    tg.drawImage(img, (tw - iw * sc) / 2, (th - ih * sc) / 2, iw * sc, ih * sc);
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(t, 0, 0, tw, th, 0, 0, w, h);
  }
  g.fillStyle = `rgba(0,0,0,${BROLL_BLUR_DIM})`;
  g.fillRect(0, 0, w, h);
  const r = brollContain(iw, ih, brollBox('blur', w, h)), rad = brollRadiusPx(b, w, h);
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.55)'; g.shadowBlur = 48 * k; g.shadowOffsetY = 14 * k;
  g.fillStyle = '#000';
  roundRectPath(g, r.x, r.y, r.w, r.h, rad); g.fill();
  g.restore();
  g.save();
  roundRectPath(g, r.x, r.y, r.w, r.h, rad);
  g.clip();
  g.drawImage(img, r.x, r.y, r.w, r.h);
  g.restore();
}

/** Paints the still layer of a beat into `g` (w x h). Same recipe as BrollOverlay.render in Java. */
export function paintBrollLayer(g: CanvasRenderingContext2D, img: CanvasImageSource & { width: number; height: number }, b: BrollBeat, w: number, h: number) {
  if (b.frame === 'blur') { paintBlurFrame(g, img, b, w, h); return; }
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

// ---------------------------------------------------------------- video beats (preview)
// The clip plays in a hidden <video> and each frame is copied to the canvas, full frame (the export puts the clip full frame too).

const vids = new Map<string, HTMLVideoElement>();

function videoFor(b: BrollBeat, onLoad: () => void): HTMLVideoElement {
  const src = srcOf(b);
  let v = vids.get(b.id);
  if (v && v.dataset.src !== src) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch { /* ignore */ } v.remove(); vids.delete(b.id); v = undefined; }
  if (!v) {
    v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.loop = false;
    v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
    v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
    v.dataset.src = src;
    v.src = src;
    document.body.append(v);
    vids.set(b.id, v);
    if (vids.size > 4) { const k = vids.keys().next().value; if (k !== undefined && k !== b.id) { const old = vids.get(k); try { old?.pause(); old?.removeAttribute('src'); old?.load(); } catch { /* ignore */ } old?.remove(); vids.delete(k); } }
  }
  const el = v as HTMLVideoElement & { __cb?: () => void };
  el.__cb = onLoad;
  if (!el.dataset.wired) {
    el.dataset.wired = '1';
    el.addEventListener('seeked', () => el.__cb?.());
    el.addEventListener('loadeddata', () => el.__cb?.());
  }
  return el;
}

/** Stops every preview clip (call when the playhead is not inside a video beat). */
export function pauseBrollVideos() {
  vids.forEach((v) => { if (!v.paused) { try { v.pause(); } catch { /* ignore */ } } });
}

function drawVideoBeat(g: CanvasRenderingContext2D, b: BrollBeat, ms: number, w: number, h: number, onLoad: () => void, playing: boolean) {
  const v = videoFor(b, onLoad);
  vids.forEach((o, id) => { if (id !== b.id && !o.paused) { try { o.pause(); } catch { /* ignore */ } } });
  const target = Math.max(0, ((b.inMs ?? 0) + (ms - b.start)) / 1000);
  const drift = Math.abs(v.currentTime - target);
  if (drift > (playing ? 0.4 : 0.05)) { try { v.currentTime = target; } catch { /* not ready yet */ } }
  if (playing) { if (v.paused) v.play().catch(() => { /* ignore */ }); }
  else if (!v.paused) { try { v.pause(); } catch { /* ignore */ } }
  if (v.readyState < 2 || !v.videoWidth) return;
  const sc = Math.max(w / v.videoWidth, h / v.videoHeight);
  const dw = v.videoWidth * sc, dh = v.videoHeight * sc;
  g.drawImage(v, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

/** Draws the beat at `ms` on the preview canvas. Redraws itself through `onLoad` when the picture has just arrived. */
export function drawBrollFrame(g: CanvasRenderingContext2D, b: BrollBeat, ms: number, w: number, h: number, onLoad: () => void, playing = false) {
  if (isBrollVideo(b)) { drawVideoBeat(g, b, ms, w, h, onLoad, playing); return; }
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
    if (isBrollVideo(b) || !b.path || b.end - b.start < 300) continue;
    const box = brollBox(b.frame, outW, outH);
    out.push({
      s: Math.round(b.start), e: Math.round(b.end), path: b.path, frame: b.frame, motion: b.motion,
      radius: brollRadiusPx(b, outW, outH), box, scrim: b.frame === 'card' ? BROLL_SCRIM : 0, vignette: b.frame === 'card' ? BROLL_VIGNETTE : 0,
      shadowBlur: 48 * Math.min(outW, outH) / 1080, shadowDy: 14 * Math.min(outW, outH) / 1080,
    });
  }
  return out.length ? out : undefined;
}

/**
 * Video beats for the export. They all go into ONE extra video track of the export (EditorrNativePlugin, "B-roll video clips"):
 * the clip fills the frame from `startMs` to `endMs`, starting `inMs` into the file. The clip's own sound is always off.
 */
export function exportBrollVideos(beats: BrollBeat[] | undefined) {
  const out: { uri: string; startMs: number; endMs: number; inMs: number }[] = [];
  for (const b of [...(beats ?? [])].sort((a, c) => a.start - c.start)) {
    if (!isBrollVideo(b) || !b.path || b.end - b.start < 300) continue;
    out.push({ uri: 'file://' + b.path, startMs: Math.round(b.start), endMs: Math.round(b.end), inMs: Math.max(0, Math.round(b.inMs ?? 0)) });
  }
  return out.length ? out : undefined;
}
