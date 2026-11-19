/**
 * Export bake: Remove BG shows in the preview through a canvas, but the native exporter only reads video files.
 * So before exporting, each video that has its background removed is rendered once to a new H.264 file
 * (person over the chosen background, same timing as the source), and the original sound is copied into it
 * by the native `muxAudio`. The export then uses that file instead of the original. The file is kept and reused until
 * the cut-out changes.
 * The video is written in pieces of about 60 s (an MP4 is held in memory while it is written).
 */
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { pickAvc } from '../visuals/encode';
import { Mp4Writer } from '../visuals/mp4';
import { EditorrNative } from '../native';
import { BgCfg, Cutout, MaskTrack } from './index';

const PIECE_S = 60;
const CHUNK = 3 * 1024 * 1024;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const toB64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const strip = (p: string) => p.replace(/^file:\/\//, '');

export interface BakeOpts {
  projectId: string;
  role: 'host' | 'constant';
  /** the original video file (path or file uri) */
  srcPath: string;
  srcFps: number;
  srcWidth: number;
  srcHeight: number;
  track: MaskTrack;
  cfg: BgCfg;
  /** video time (ms) that is timeline 0 */
  startMs: number;
  /** timeline length (ms) */
  durationMs: number;
  onProgress: (pct: number, label: string) => void;
  cancelled: () => boolean;
}

function seekTo(v: HTMLVideoElement, sec: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => { if (done) return; done = true; v.removeEventListener('seeked', fin); clearTimeout(to); resolve(); };
    const to = window.setTimeout(fin, 3000);
    v.addEventListener('seeked', fin);
    try { v.currentTime = sec; } catch { fin(); }
  });
}

function openVideo(src: string): Promise<HTMLVideoElement | null> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    const fin = (ok: boolean) => { clearTimeout(to); resolve(ok && v.videoWidth ? v : null); };
    const to = window.setTimeout(() => fin(false), 12000);
    v.addEventListener('loadeddata', () => fin(true), { once: true });
    v.addEventListener('error', () => fin(false), { once: true });
    v.src = src;
  });
}

async function writeFile(rel: string, blob: Blob): Promise<void> {
  for (let off = 0, first = true; off < blob.size; off += CHUNK, first = false) {
    const data = toB64(new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer()));
    if (first) await Filesystem.writeFile({ path: rel, data, directory: Directory.Data, recursive: true });
    else await Filesystem.appendFile({ path: rel, data, directory: Directory.Data });
  }
}
const pathOf = async (rel: string) => strip((await Filesystem.getUri({ path: rel, directory: Directory.Data })).uri);

/** Where the finished file lives for this cut-out. */
function finalRel(o: BakeOpts): string {
  const sig = [o.cfg.engine, o.cfg.fill, o.cfg.color.replace('#', ''), o.cfg.count, o.cfg.stamp ?? 0, o.startMs, o.durationMs, o.srcWidth, o.srcHeight].join('_');
  return `bgcut/${o.projectId}_${o.role}_${sig}.mp4`;
}

/** Returns the path of the video (with the original sound) that has the background removed. Reuses an earlier one. */
export async function bakeCutout(o: BakeOpts): Promise<string> {
  const rel = finalRel(o);
  try {
    const have = await EditorrNative.fileExists({ path: await pathOf(rel) });
    if (have.exists) return await pathOf(rel);
  } catch { /* not there yet */ }

  o.onProgress(0, 'Opening video');
  let v = await openVideo(Capacitor.convertFileSrc(o.srcPath));
  if (!v) {
    // this WebView cannot play the original (for example 4K or HEVC): use a small H.264 copy for the pictures
    o.onProgress(0, 'Making a copy this phone can read');
    const short = Math.min(o.srcWidth, o.srcHeight);
    const px = await EditorrNative.makeProxy({ path: o.srcPath, height: Math.min(1080, short) });
    v = await openVideo(Capacitor.convertFileSrc(px.proxyPath));
    if (!v) throw new Error('This video cannot be read for Remove BG.');
  }
  const k = Math.min(1, 1920 / Math.max(v.videoWidth, v.videoHeight));
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const W = even(v.videoWidth * k), H = even(v.videoHeight * k);
  const fps = Math.max(10, Math.min(30, Math.round(o.srcFps || 30)));
  const frameUs = 1e6 / fps;
  const endMs = Math.min((v.duration || Infinity) * 1000, o.startMs + o.durationMs + 250);
  const total = Math.max(2, Math.ceil((endMs / 1000) * fps));
  const codec = await pickAvc(W, H, fps, 8_000_000);
  if (!codec) throw new Error('This phone cannot encode H.264 in the WebView, so Remove BG cannot be exported.');

  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d', { alpha: false })!;
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  const cut = new Cutout(o.track, () => o.cfg);
  const pieces: string[] = [], counts: number[] = [];
  const per = Math.max(1, Math.round(PIECE_S * fps));
  const stamp = Date.now().toString(36);
  const t0 = performance.now();

  try {
    for (let from = 0, n = 0; from < total; from += per, n++) {
      const to = Math.min(total, from + per);
      const mux = new Mp4Writer(W, H);
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
        enc.configure({ codec, width: W, height: H, framerate: fps, bitrate: 8_000_000, latencyMode: 'realtime', avc: { format: 'avc' } } as VideoEncoderConfig);
        for (let i = from; i < to; i++) {
          if (o.cancelled()) throw new Error('cancelled');
          if (failure) throw failure;
          const tMs = (i * 1000) / fps;
          // before the timeline starts (the Constant video is offset) nothing is used: repeat the first picture
          if (tMs >= o.startMs - 40) {
            await seekTo(v, Math.min(tMs / 1000, Math.max(0, (v.duration || 1e9) - 0.001)));
            cut.draw(g, v, tMs - o.startMs, W, H);
          }
          while (enc.encodeQueueSize > 6) { await new Promise((r) => setTimeout(r, 4)); if (o.cancelled()) throw new Error('cancelled'); }
          const frame = new VideoFrame(cv, { timestamp: Math.round((i - from) * frameUs), duration: Math.round(frameUs) });
          try { enc.encode(frame, { keyFrame: i === from || (i - from) % 30 === 0 }); } finally { frame.close(); }
          const done = i + 1, eta = ((performance.now() - t0) / done) * (total - done) / 1000;
          o.onProgress((done / total) * 100, `Removing background (${o.role === 'host' ? 'Host' : 'Constant'})${eta > 8 ? `, about ${Math.ceil(eta / 60)} min left` : ''}`);
          if (i % 4 === 3) await tick();
        }
        await enc.flush();
        if (failure) throw failure;
        const relPiece = `bgcut/${o.projectId}_${o.role}_${stamp}_p${n}.mp4`;
        await writeFile(relPiece, mux.finish());
        pieces.push(await pathOf(relPiece)); counts.push(to - from);
      } finally { try { if (enc.state !== 'closed') enc.close(); } catch { /* closed */ } }
    }
    o.onProgress(100, 'Adding the sound');
    const out = await pathOf(rel).catch(async () => { await Filesystem.mkdir({ path: 'bgcut', directory: Directory.Data, recursive: true }); return pathOf(rel); });
    await EditorrNative.muxAudio({ videoPaths: pieces, frameCounts: counts, fps, audioPath: strip(o.srcPath), outPath: out });
    return out;
  } catch (e) {
    for (const p of pieces) { try { await Filesystem.deleteFile({ path: p }); } catch { /* ignore */ } }
    throw e;
  } finally {
    cv.width = cv.height = 1;
    v.removeAttribute('src'); v.load();
  }
}

/** Delete baked files of a project that are not the current ones (called after a bake). */
export async function sweepBaked(projectId: string, keep: string[]): Promise<void> {
  try {
    const list = await Filesystem.readdir({ path: 'bgcut', directory: Directory.Data });
    const keepNames = new Set(keep.map((p) => p.split('/').pop()));
    for (const f of list.files) {
      const name = typeof f === 'string' ? f : f.name;
      if (name.startsWith(projectId) && !keepNames.has(name)) { try { await Filesystem.deleteFile({ path: `bgcut/${name}`, directory: Directory.Data }); } catch { /* ignore */ } }
    }
  } catch { /* no folder yet */ }
}
