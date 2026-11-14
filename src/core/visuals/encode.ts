/**
 * Motion scene -> video file, in the WebView, no server.
 *   1. WebCodecs VideoEncoder (H.264) + our own MP4 writer (mp4.ts)  -> .mp4, exact frame count and duration
 *   2. MediaRecorder on canvas.captureStream() driven in real time    -> .mp4 or .webm (slower, duration is wall-clock)
 *   3. nothing works                                                  -> throws NoEncoderError; the caller uses the baked-frame path
 * Frames always come from renderFrame(), a pure function of time, so the file shows exactly what the Live Canvas Monitor shows.
 */
import { loadVisualFonts } from './fonts';
import { Mp4Writer } from './mp4';
import { renderFrame } from './render';
import { getTheme } from './themes';
import type { Visual } from './types';

export interface RenderSignal { cancelled: boolean }
export interface RenderOpts { w: number; h: number; fps: number; signal: RenderSignal; onProgress?: (done: number, total: number) => void }
export interface RenderResult { blob: Blob; durationMs: number; ext: 'mp4' | 'webm'; fps: number; via: 'webcodecs' | 'recorder'; note?: string }

export class RenderCancelled extends Error { constructor() { super('cancelled'); } }
export class NoEncoderError extends Error { constructor(why: string) { super(why); } }

const tick = () => new Promise<void>(r => setTimeout(r, 0));

/** Opaque frame of a scene: the theme colour behind, the drawn card on top (the card box leaves margins and the caption zone empty). */
export async function drawSceneFrame(g: CanvasRenderingContext2D, v: Visual, tMs: number, w: number, h: number): Promise<void> {
  const fr = await renderFrame(v, tMs, w, h);
  g.globalCompositeOperation = 'source-over';
  g.fillStyle = getTheme(v.themeId).bg; g.fillRect(0, 0, g.canvas.width, g.canvas.height);
  g.drawImage(fr, 0, 0, g.canvas.width, g.canvas.height);
}

/** Output size for a project aspect (width / height): `short` px on the short side, both even. */
export function outSize(aspect: number, short: number): { w: number; h: number } {
  const a = aspect > 0 ? aspect : 16 / 9, even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return a >= 1 ? { w: even(short * a), h: even(short) } : { w: even(short), h: even(short / a) };
}

const AVC_720 = ['avc1.42001f', 'avc1.4d001f', 'avc1.64001f', 'avc1.42002a', 'avc1.64002a'];
const AVC_1080 = ['avc1.640028', 'avc1.42002a', 'avc1.4d002a', 'avc1.64002a', 'avc1.640032'];

/** The first H.264 profile/level this WebView can encode at this size, or null (no WebCodecs, or no H.264 encoder). */
export async function pickAvc(w: number, h: number, fps: number, bitrate: number): Promise<string | null> {
  const VE = (globalThis as { VideoEncoder?: typeof VideoEncoder }).VideoEncoder;
  if (!VE || !(globalThis as { VideoFrame?: unknown }).VideoFrame) return null;
  for (const codec of Math.min(w, h) > 800 ? AVC_1080 : AVC_720) {
    try {
      const r = await VE.isConfigSupported({ codec, width: w, height: h, framerate: fps, bitrate, avc: { format: 'avc' } } as VideoEncoderConfig);
      if (r.supported) return codec;
    } catch { /* try the next one */ }
  }
  return null;
}

export const bitrateFor = (w: number, h: number) => (Math.min(w, h) >= 1000 ? 6_000_000 : 3_000_000);
/** rough size of the file, for the free-space check before rendering */
export const estimateBytes = (w: number, h: number, durationMs: number) => Math.round((bitrateFor(w, h) / 8) * (durationMs / 1000) * 1.15);

async function viaWebCodecs(v: Visual, o: RenderOpts, codec: string, fps: number, note?: string): Promise<RenderResult> {
  const dur = Math.max(300, v.endMs - v.startMs), total = Math.max(2, Math.round((dur / 1000) * fps)), frameUs = 1e6 / fps;
  const cv = document.createElement('canvas'); cv.width = o.w; cv.height = o.h; // ONE canvas for the whole scene
  const g = cv.getContext('2d', { alpha: false })!;
  const mux = new Mp4Writer(o.w, o.h);
  let failure: Error | null = null;
  const enc = new VideoEncoder({
    output: (chunk, meta) => {
      try {
        const d = meta?.decoderConfig?.description;
        if (d && !mux.hasDescription) mux.setDescription(ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d as ArrayBuffer));
        const buf = new Uint8Array(chunk.byteLength); chunk.copyTo(buf);
        mux.addSample(buf, chunk.timestamp, chunk.duration ?? frameUs, chunk.type === 'key');
      } catch (e) { failure = e as Error; }
    },
    error: (e) => { failure = e as Error; },
  });
  try {
    enc.configure({ codec, width: o.w, height: o.h, framerate: fps, bitrate: bitrateFor(o.w, o.h), latencyMode: 'realtime', avc: { format: 'avc' } } as VideoEncoderConfig);
    for (let i = 0; i < total; i++) {
      if (o.signal.cancelled) throw new RenderCancelled();
      if (failure) throw failure;
      await drawSceneFrame(g, v, Math.min(dur, (i * 1000) / fps), o.w, o.h);
      while (enc.encodeQueueSize > 6) { await new Promise(r => setTimeout(r, 4)); if (o.signal.cancelled) throw new RenderCancelled(); }
      const frame = new VideoFrame(cv, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs) });
      try { enc.encode(frame, { keyFrame: i % 30 === 0 }); } finally { frame.close(); }
      o.onProgress?.(i + 1, total);
      if (i % 4 === 3) await tick();
    }
    await enc.flush();
    if (failure) throw failure;
    const blob = mux.finish();
    return { blob, durationMs: mux.durationMs, ext: 'mp4', fps, via: 'webcodecs', note };
  } finally {
    try { if (enc.state !== 'closed') enc.close(); } catch { /* already closed */ }
    cv.width = cv.height = 1; // let go of the pixels
  }
}

/** MediaRecorder: the canvas is drawn in real time (wall clock), so this takes as long as the scene lasts. */
async function viaRecorder(v: Visual, o: RenderOpts, note?: string): Promise<RenderResult> {
  const MR = (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  const cv = document.createElement('canvas'); cv.width = o.w; cv.height = o.h;
  if (!MR || typeof cv.captureStream !== 'function') throw new NoEncoderError('This phone has no video recorder in its WebView');
  const mime = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(m => MR.isTypeSupported(m));
  if (!mime) throw new NoEncoderError('This phone cannot record video here');
  const dur = Math.max(300, v.endMs - v.startMs), g = cv.getContext('2d', { alpha: false })!;
  await drawSceneFrame(g, v, 0, o.w, o.h);
  const stream = cv.captureStream(o.fps), rec = new MR(stream, { mimeType: mime, videoBitsPerSecond: bitrateFor(o.w, o.h) }), parts: Blob[] = [];
  rec.ondataavailable = e => { if (e.data.size) parts.push(e.data); };
  const stopped = new Promise<void>(res => { rec.onstop = () => res(); });
  rec.start(250);
  const t0 = performance.now();
  let busy = false, t = 0;
  try {
    while (t < dur) {
      if (o.signal.cancelled) throw new RenderCancelled();
      t = Math.min(dur, performance.now() - t0);
      if (!busy) { busy = true; void drawSceneFrame(g, v, t, o.w, o.h).finally(() => { busy = false; }); } // a slow frame is held, never waited for
      o.onProgress?.(Math.round(t), Math.round(dur));
      await new Promise<void>(r => requestAnimationFrame(() => r()));
    }
    while (busy) await tick();
    await drawSceneFrame(g, v, dur, o.w, o.h);
    await new Promise(r => setTimeout(r, 120));
  } finally {
    try { if (rec.state !== 'inactive') rec.stop(); } catch { /* ignore */ }
    stream.getTracks().forEach(tr => tr.stop());
  }
  await stopped;
  if (o.signal.cancelled) throw new RenderCancelled();
  const blob = new Blob(parts, { type: mime.split(';')[0] });
  if (!blob.size) throw new NoEncoderError('The recorder gave an empty file');
  return { blob, durationMs: Math.round(dur), ext: mime.startsWith('video/mp4') ? 'mp4' : 'webm', fps: o.fps, via: 'recorder', note };
}

/**
 * Render one scene. The speed is checked on the first frames: when the whole scene would take more than 60 s the frame rate drops to 24.
 * Throws RenderCancelled when o.signal.cancelled turns true, NoEncoderError when neither encoder works.
 */
export async function renderSceneToVideo(v: Visual, o: RenderOpts): Promise<RenderResult> {
  await loadVisualFonts();
  const dur = Math.max(300, v.endMs - v.startMs);
  let fps = o.fps, note: string | undefined;
  // speed probe: three frames at different times (each is drawn once, then cached for the real pass)
  const probe = document.createElement('canvas'); probe.width = o.w; probe.height = o.h;
  const pg = probe.getContext('2d', { alpha: false })!, t0 = performance.now();
  for (const f of [0.15, 0.4, 0.7]) await drawSceneFrame(pg, v, dur * f, o.w, o.h);
  const perFrame = (performance.now() - t0) / 3;
  probe.width = probe.height = 1;
  if (fps > 24 && perFrame * (dur / 1000) * fps > 60000) { fps = 24; note = `Scene is heavy on this phone: rendered at ${fps} FPS`; }
  const codec = await pickAvc(o.w, o.h, fps, bitrateFor(o.w, o.h));
  if (codec) {
    try { return await viaWebCodecs(v, o, codec, fps, note); }
    catch (e) { if (e instanceof RenderCancelled) throw e; note = `${note ? note + '. ' : ''}Encoder failed (${(e as Error).message || 'error'}), used the slower recorder`; }
  } else note = `${note ? note + '. ' : ''}This phone cannot encode video here (using slower mode)`;
  if (o.signal.cancelled) throw new RenderCancelled();
  return viaRecorder(v, { ...o, fps }, note);
}
