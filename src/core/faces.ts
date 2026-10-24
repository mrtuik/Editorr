/**
 * Face scan, face tracking, lip movement and Autoframe crop maths.
 *
 * - Uses MediaPipe FaceLandmarker (on-device, GPU when possible) on small frames, 4 per second, while the video plays fast.
 * - Every face gets a track (Person 1, Person 2 ...). Lip opening (inner lip gap / face height) is kept per track.
 * - Lip movement of the chosen person is turned into a 100 ms activity curve that Auto switch can use.
 * - Autoframe turns a face position into the zoom / x / y of a clip crop.
 */
import type { CropState } from './types';

export const FACE_SAMPLE_MS = 250;
const SCAN_W = 256;
const MAX_FACES = 3;
const MAX_TRACKS = 6;
const MATCH_DIST = 0.18;      // how far (fraction of the frame) a face may move between samples and stay the same person
const MAX_GAP_SAMPLES = 8;    // a person may vanish for ~2 s and still be the same person

export interface FaceTrack {
  id: number;
  /** Box centre and size per sample, 0..1 of the video frame. NaN = not visible. */
  cx: Float32Array; cy: Float32Array; w: Float32Array; h: Float32Array;
  /** Inner lip gap / face height per sample. NaN = not visible. */
  lip: Float32Array;
  /** Fraction of samples where this person was visible. */
  presence: number;
}

export interface FaceScan {
  sampleMs: number;
  n: number;
  /** video time (ms) that was timeline 0 when this was scanned (Host 0, Constant offset) */
  startMs: number;
  /** video width / height */
  aspect: number;
  tracks: FaceTrack[];
  /** A picture from the moment with the most people in view, and its sample number (for the face picker). */
  snapshot?: HTMLCanvasElement;
  snapshotI?: number;
}

// ------------------------------------------------------------------ model loading

let mpPromise: Promise<any> | null = null;
let working: { srcIndex: number; delegate: 'GPU' | 'CPU' } | null = null;

function baseUrl(path: string): string {
  return new URL(path, document.baseURI).href;
}

function loadMediaPipe(): Promise<any> {
  // @ts-ignore - resolved after `npm install`
  if (!mpPromise) mpPromise = import('@mediapipe/tasks-vision').catch((e: unknown) => { mpPromise = null; throw e; });
  return mpPromise;
}

/** A fresh landmarker in VIDEO mode (it tracks faces from frame to frame, which is much faster than detecting every frame).
 *  Local files first (offline), the internet only as a fallback. */
function delegateOk(): 'GPU' | 'CPU' | null { return working ? working.delegate : null; }

async function newLandmarker(forceCpu = false): Promise<any> {
  const mp = await loadMediaPipe();
  const sources = [
    { wasm: baseUrl('mediapipe/wasm'), model: baseUrl('mediapipe/face_landmarker.task') },
    {
      wasm: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm',
      model: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    },
  ];
  const tries: { srcIndex: number; delegate: 'GPU' | 'CPU' }[] = [];
  const delegates = forceCpu ? (['CPU'] as const) : (['GPU', 'CPU'] as const);
  if (working && (!forceCpu || working.delegate === 'CPU')) tries.push(working);
  sources.forEach((_, srcIndex) => delegates.forEach((delegate) => {
    if (!(working && working.srcIndex === srcIndex && working.delegate === delegate && tries.length)) tries.push({ srcIndex, delegate });
  }));
  let lastError: unknown = null;
  for (const t of tries) {
    try {
      const src = sources[t.srcIndex];
      const fileset = await mp.FilesetResolver.forVisionTasks(src.wasm);
      const lm = await mp.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: src.model, delegate: t.delegate },
        runningMode: 'VIDEO',
        numFaces: MAX_FACES,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      working = t;
      return lm;
    } catch (e) { lastError = e; }
  }
  throw lastError ?? new Error('Face model could not be loaded.');
}

// ------------------------------------------------------------------ frame sampling

function waitSeek(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => { if (done) return; done = true; v.removeEventListener('seeked', fin); clearTimeout(to); resolve(); };
    const to = window.setTimeout(fin, 2500);
    v.addEventListener('seeked', fin);
    try { v.currentTime = t; } catch { fin(); }
  });
}

/**
 * Calls `cb(i)` for samples i (timeline time i * sampleMs) with the matching frame showing in `v`.
 * Fast path: the video PLAYS at 2x-8x muted and frames are picked as they pass (no seeking, so it is many times faster).
 * Slow path: seek for every sample, only when the fast path cannot get frames.
 * Returns false when cancelled.
 */
async function sampleVideo(
  v: HTMLVideoElement, startMs: number, n: number, sampleMs: number,
  cb: (i: number) => void, onProgress: (pct: number) => void, cancelled: () => boolean,
  isDone: (i: number) => boolean, recover?: () => Promise<void>,
): Promise<{ ok: boolean; via: 'play' | 'play+seek' | 'seek' }> {
  let next = Math.ceil(Math.max(0, -startMs) / sampleMs);

  const sequential = (): Promise<'done' | 'cancel' | 'stalled'> => new Promise((resolve) => {
    let finished = false, lastMoveAt = performance.now(), lastT = -1, got = 0, rate = 2, busyMs = 0, busyN = 0;
    const finish = (r: 'done' | 'cancel' | 'stalled') => {
      if (finished) return; finished = true; window.clearInterval(timer);
      try { v.pause(); } catch { /* ignore */ }
      resolve(r);
    };
    // Poll the playing video's clock. This works whether or not the video is visible on screen
    // (frame callbacks do not fire for hidden videos).
    const timer = window.setInterval(() => {
      if (finished) return;
      if (cancelled()) { finish('cancel'); return; }
      if (v.error) { finish(got ? 'done' : 'stalled'); return; }
      const nowMs = performance.now();
      if (v.currentTime !== lastT) { lastT = v.currentTime; lastMoveAt = nowMs; got++; }
      if (v.paused && !v.ended) { v.play().catch(() => {}); }
      if (nowMs - lastMoveAt > 4000) { finish(got > 3 ? 'done' : 'stalled'); return; }
      const tl = v.currentTime * 1000 - startMs;
      const due = Math.floor(tl / sampleMs);
      if (v.ended || due >= n) { finish('done'); return; }
      if (due >= next) {
        const t0 = performance.now();
        try { cb(due); } catch { /* skip this sample */ }
        busyMs += performance.now() - t0; busyN++;
        next = due + 1;
        if (busyN >= 8) {
          // keep up with the detector: the video may not run faster than we can look at it
          const per = busyMs / busyN; busyMs = 0; busyN = 0;
          const want = Math.max(1, Math.min(4, Math.floor(sampleMs / (per + 6))));
          if (want !== rate) { rate = want; try { v.playbackRate = rate; } catch { /* ignore */ } }
        }
        if (next % 6 === 0) onProgress(Math.min(99, (next / n) * 100));
      }
    }, 16);
    (async () => {
      try {
        await waitSeek(v, Math.max(0, (startMs + next * sampleMs) / 1000));
        lastMoveAt = performance.now();
        v.muted = true; v.playbackRate = rate;
        await v.play();
      } catch { finish('stalled'); }
    })();
  });

  const first = Math.ceil(Math.max(0, -startMs) / sampleMs);
  const r = await sequential();
  if (r === 'cancel') return { ok: false, via: 'play' };
  let covered = 0;
  for (let i = first; i < n; i++) if (isDone(i)) covered++;
  // the video played to the end with most samples read: good. Otherwise (it stalled, errored, or skipped most): seek for the missing ones.
  if (r === 'done' && covered >= 0.6 * Math.max(1, n - first)) { onProgress(100); return { ok: true, via: 'play' }; }

  if (v.error && recover) await recover();
  let usedSeek = false;
  for (let i = first; i < n; i++) {
    if (cancelled()) return { ok: false, via: 'play+seek' };
    if (isDone(i)) continue;
    const t = (startMs + i * sampleMs) / 1000;
    if (t < 0 || t > v.duration) continue;
    usedSeek = true;
    await waitSeek(v, t);
    try { cb(i); } catch { /* skip */ }
    if (i % 5 === 0) { onProgress((i / n) * 100); await new Promise((res) => setTimeout(res, 0)); }
  }
  onProgress(100);
  return { ok: true, via: covered ? (usedSeek ? 'play+seek' : 'play') : 'seek' };
}

// ------------------------------------------------------------------ scan

interface RawFace { cx: number; cy: number; w: number; h: number; lip: number }

function readFaces(result: any): RawFace[] {
  const out: RawFace[] = [];
  for (const lm of (result?.faceLandmarks ?? []) as { x: number; y: number }[][]) {
    if (!lm || lm.length < 15) continue;
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const q of lm) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y; }
    const w = x1 - x0, hh = y1 - y0;
    if (w <= 0.01 || hh <= 0.01) continue;
    // 13 = upper inner lip, 14 = lower inner lip
    const gap = Math.abs(lm[14].y - lm[13].y) / hh;
    out.push({ cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w, h: hh, lip: gap });
  }
  return out;
}

/** What the last scan of each video did. Shown when no face is found, so we can see why instead of guessing. */
export interface FaceReport { samples: number; expected: number; errors: number; firstError: string; maxFaces: number; tracks: number; delegate: string; via: string; ms: number }
export const lastReport: { host?: FaceReport; constant?: FaceReport } = {};

/**
 * Scans one video. It plays the GIVEN video element (the editor's own), so no extra video decoder is opened:
 * phones only have a few, and opening more makes the editor's own videos fail.
 * Sample i is timeline time i * FACE_SAMPLE_MS (video time = videoStartMs + that).
 * `onProgress` is first called once the model is ready, so 0% means "still loading the model".
 * @param recover reloads the video if it broke while playing fast
 */
export async function scanFaces(
  v: HTMLVideoElement,
  videoStartMs: number,
  durationMs: number,
  onProgress: (pct: number) => void,
  cancelled: () => boolean,
  role: 'host' | 'constant' = 'host',
  recover?: () => Promise<void>,
): Promise<FaceScan | null> {
  if (v.readyState < 1 || !v.videoWidth) return null;
  const aspect = v.videoWidth / v.videoHeight;
  const n = Math.ceil(durationMs / FACE_SAMPLE_MS) + 1;
  const t00 = performance.now();

  // GPU first; when it reads frames but every detect call fails (some phones), run again on the CPU.
  for (const forceCpu of [false, true]) {
    if (forceCpu && delegateOk() !== 'GPU') break;
    const landmarker = await newLandmarker(forceCpu);
    const c = document.createElement('canvas');
    c.width = SCAN_W; c.height = Math.max(2, Math.round(SCAN_W / aspect));
    const g = c.getContext('2d', { willReadFrequently: false } as any) as CanvasRenderingContext2D;
    type Work = { id: number; last: RawFace; lastAt: number; items: (RawFace | null)[] };
    const works: Work[] = [];
    const done = new Uint8Array(n);
    let snapshot: HTMLCanvasElement | undefined, snapshotI = 0, snapCount = 0;
    let errors = 0, attempts = 0, firstError = '', maxFaces = 0, tsBase = 0;

    const handle = (i: number) => {
      attempts++;
      let faces: RawFace[];
      try {
        g.drawImage(v, 0, 0, c.width, c.height);
        tsBase += 1; // strictly rising timestamps (the video clock can jump back when we seek)
        faces = readFaces(landmarker.detectForVideo(c, tsBase * 10));
      } catch (e) {
        errors++; if (!firstError) firstError = String((e as Error)?.message ?? e).slice(0, 80);
        return;
      }
      done[i] = 1;
      if (faces.length > maxFaces) maxFaces = faces.length;
      if (faces.length > snapCount) {
        snapCount = faces.length; snapshotI = i;
        snapshot = snapshot ?? document.createElement('canvas');
        snapshot.width = 640; snapshot.height = Math.max(2, Math.round(640 / aspect));
        try { snapshot.getContext('2d')!.drawImage(v, 0, 0, snapshot.width, snapshot.height); } catch { /* picker shows boxes only */ }
      }
      const used = new Set<number>();
      const pairs: { d: number; fi: number; wi: number }[] = [];
      faces.forEach((f, fi) => works.forEach((wk, wi) => {
        if (i - wk.lastAt > MAX_GAP_SAMPLES) return;
        const d = Math.hypot(f.cx - wk.last.cx, f.cy - wk.last.cy);
        if (d < MATCH_DIST) pairs.push({ d, fi, wi });
      }));
      pairs.sort((a, b) => a.d - b.d);
      const faceTaken = new Set<number>();
      for (const pr of pairs) {
        if (faceTaken.has(pr.fi) || used.has(pr.wi)) continue;
        faceTaken.add(pr.fi); used.add(pr.wi);
        const wk = works[pr.wi];
        wk.items[i] = faces[pr.fi]; wk.last = faces[pr.fi]; wk.lastAt = i;
      }
      faces.forEach((f, fi) => {
        if (faceTaken.has(fi) || works.length >= MAX_TRACKS) return;
        const items: (RawFace | null)[] = new Array(n).fill(null);
        items[i] = f;
        works.push({ id: works.length, last: f, lastAt: i, items });
      });
    };

    try {
      onProgress(1);
      const r = await sampleVideo(v, videoStartMs, n, FACE_SAMPLE_MS, handle, onProgress, cancelled, (i) => done[i] === 1, recover);
      if (!r.ok) return null;

      const tracks: FaceTrack[] = [];
      for (const wk of works) {
        const cx = new Float32Array(n).fill(NaN), cy = new Float32Array(n).fill(NaN);
        const w = new Float32Array(n).fill(NaN), hh = new Float32Array(n).fill(NaN), lip = new Float32Array(n).fill(NaN);
        let seen = 0;
        for (let i = 0; i < n; i++) {
          const f = wk.items[i];
          if (!f) continue;
          cx[i] = f.cx; cy[i] = f.cy; w[i] = f.w; hh[i] = f.h; lip[i] = f.lip; seen++;
        }
        const presence = seen / n;
        if (presence < 0.02) continue; // a flicker, not a person
        tracks.push({ id: 0, cx, cy, w, h: hh, lip, presence });
      }
      tracks.sort((a, b) => b.presence * medianOf(b.w) - a.presence * medianOf(a.w));
      tracks.forEach((t, k) => { t.id = k; });
      let samples = 0; for (let i = 0; i < n; i++) samples += done[i];
      lastReport[role] = { samples, expected: n, errors, firstError, maxFaces, tracks: tracks.length, delegate: delegateOk() ?? '?', via: r.via, ms: Math.round(performance.now() - t00) };
      // every detect call failed on the GPU: try again on the CPU
      if (!forceCpu && delegateOk() === 'GPU' && errors > 0 && errors >= attempts * 0.5) continue;
      return { sampleMs: FACE_SAMPLE_MS, n, startMs: videoStartMs, aspect, tracks, snapshot, snapshotI };
    } finally { try { landmarker.close(); } catch { /* ignore */ } try { v.pause(); } catch { /* ignore */ } }
  }
  return null;
}

// ------------------------------------------------------------------ helpers

function medianOf(a: Float32Array, from = 0, to = a.length): number {
  const vals: number[] = [];
  for (let i = Math.max(0, from); i < Math.min(a.length, to); i++) if (!Number.isNaN(a[i])) vals.push(a[i]);
  if (!vals.length) return NaN;
  vals.sort((x, y) => x - y);
  return vals[Math.floor(vals.length / 2)];
}

/** Typical position of a person over the whole video (used as an anchor to remember which person was picked). */
export function trackAnchor(t: FaceTrack): { x: number; y: number } {
  return { x: medianOf(t.cx), y: medianOf(t.cy) };
}

/** The person the user picked (nearest to the saved anchor), else the most visible, biggest person. */
export function pickTrack(scan: FaceScan | undefined, anchor?: { x: number; y: number } | null): FaceTrack | undefined {
  if (!scan || !scan.tracks.length) return undefined;
  if (anchor) {
    let best = scan.tracks[0], bd = Infinity;
    for (const t of scan.tracks) {
      const a = trackAnchor(t);
      const d = Math.hypot(a.x - anchor.x, a.y - anchor.y);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }
  return scan.tracks[0];
}

/** How much one person's lips move per sample (0 when not visible). Smoothed over ~0.6 s. */
function lipMovement(t: FaceTrack): Float32Array {
  const n = t.lip.length;
  const raw = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    const a = t.lip[i], b = t.lip[i - 1];
    raw[i] = Number.isNaN(a) || Number.isNaN(b) ? 0 : Math.abs(a - b);
  }
  const out = new Float32Array(n);
  const R = 1;
  for (let i = 0; i < n; i++) {
    let s = 0, k = 0;
    for (let j = -R; j <= R; j++) { const q = i + j; if (q >= 0 && q < n) { s += raw[q]; k++; } }
    out[i] = s / k;
  }
  return out;
}

/**
 * Lip movement per 100 ms timeline frame, in the same shape the old pixel scan produced,
 * so Auto switch can use it directly. With a pick: that person only. Without: the most active person.
 */
export function motionFromScan(scan: FaceScan, anchor: { x: number; y: number } | null | undefined, durationMs: number): Float32Array {
  const sel = anchor ? pickTrack(scan, anchor) : undefined;
  const list = sel ? [sel] : scan.tracks;
  const mv = list.map(lipMovement);
  const n = scan.n;
  const per = new Float32Array(n);
  for (let i = 0; i < n; i++) { let m = 0; for (const a of mv) if (a[i] > m) m = a[i]; per[i] = m; }
  const frames = Math.ceil(durationMs / 100);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const pos = (f * 100) / scan.sampleMs, a = Math.floor(pos), b = Math.min(n - 1, a + 1), w = pos - a;
    out[f] = (per[Math.min(n - 1, a)] ?? 0) * (1 - w) + (per[b] ?? 0) * w;
  }
  return out;
}

/** Typical face box of a track between two timeline times. null when the person is not there. */
export function faceBetween(t: FaceTrack | undefined, sampleMs: number, startMs: number, endMs: number): { cx: number; cy: number; w: number; h: number } | null {
  if (!t) return null;
  const a = Math.floor(startMs / sampleMs), b = Math.ceil(endMs / sampleMs);
  const r = { cx: medianOf(t.cx, a, b + 1), cy: medianOf(t.cy, a, b + 1), w: medianOf(t.w, a, b + 1), h: medianOf(t.h, a, b + 1) };
  if (Number.isNaN(r.cx)) {
    // not visible in this part: use where the person usually is
    const m = { cx: medianOf(t.cx), cy: medianOf(t.cy), w: medianOf(t.w), h: medianOf(t.h) };
    return Number.isNaN(m.cx) ? null : m;
  }
  return r;
}

// ------------------------------------------------------------------ autoframe crop

/**
 * Crop (zoom + x + y) that puts a face in a nice spot of a slot.
 * Same maths as the preview: the picture covers the slot, then is scaled by `zoom` about the centre and moved by
 * x * (zoom - 1) / 2 of the slot size.
 * @param videoAspect width / height of the video
 * @param slotAspect width / height of the slot the video sits in
 * @param mirrored the picture is flipped sideways
 */
export function cropForFace(
  face: { cx: number; cy: number; w: number; h: number },
  videoAspect: number,
  slotAspect: number,
  mirrored: boolean,
  base: CropState,
): CropState {
  const wide = videoAspect > slotAspect;
  const kx = wide ? videoAspect / slotAspect : 1;   // how much wider than the slot the picture is
  const ky = wide ? 1 : slotAspect / videoAspect;   // how much taller than the slot the picture is
  const fx = mirrored ? 1 - face.cx : face.cx;
  const u = 0.5 + (fx - 0.5) * kx;
  const v = 0.5 + (face.cy - 0.5) * ky;

  const zx = 0.45 / Math.max(0.01, face.w * kx);
  const zy = 0.30 / Math.max(0.01, face.h * ky);
  const zoom = Math.max(1, Math.min(3, Math.min(zx, zy)));
  const next: CropState = { ...base, rotate: 0 };
  if (zoom < 1.03) { next.zoom = 1; next.x = 0; next.y = 0; return next; }

  const targetV = 0.40; // face centre sits a bit above the middle: headroom on top
  const clamp = (q: number) => Math.max(-1, Math.min(1, q));
  next.zoom = zoom;
  next.x = clamp((-2 * zoom * (u - 0.5)) / (zoom - 1));
  next.y = clamp((2 * (targetV - 0.5 - (v - 0.5) * zoom)) / (zoom - 1));
  return next;
}
