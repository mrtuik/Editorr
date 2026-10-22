/**
 * Lip / face movement scan.
 * Samples a few frames per second from a video, and measures how much the face area moves.
 * The person who is talking moves their mouth and head more than the person who is listening,
 * so comparing the two cameras tells us who speaks (this works even when both voices sound alike).
 */
const SAMPLE_MS = 300;
const W = 64, Hh = 36;

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
 * @param videoStartMs video time that matches timeline 0 (0 for Host, offsetMs for Constant)
 * @returns motion energy per 100 ms timeline frame, or null when the video cannot be read
 */
export async function scanMotion(
  url: string,
  videoStartMs: number,
  durationMs: number,
  onProgress: (pct: number) => void,
  cancelled: () => boolean,
): Promise<Float32Array | null> {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
  await new Promise<void>((res) => { v.onloadeddata = () => res(); v.onerror = () => res(); window.setTimeout(res, 8000); });
  if (!v.videoWidth) return null;

  const c = document.createElement('canvas'); c.width = W; c.height = Hh;
  const g = c.getContext('2d', { willReadFrequently: true } as any) as CanvasRenderingContext2D;
  const n = Math.ceil(durationMs / SAMPLE_MS) + 1;
  const samples = new Float32Array(n);
  let prev: Uint8Array | null = null;
  const x0 = Math.floor(W * 0.15), x1 = Math.floor(W * 0.85), y0 = Math.floor(Hh * 0.05), y1 = Math.floor(Hh * 0.85);

  for (let i = 0; i < n; i++) {
    if (cancelled()) return null;
    const t = (videoStartMs + i * SAMPLE_MS) / 1000;
    if (t < 0 || t > v.duration) { samples[i] = NaN; continue; }
    await waitSeek(v, t);
    try { g.drawImage(v, 0, 0, W, Hh); } catch { return null; }
    let img: ImageData;
    try { img = g.getImageData(0, 0, W, Hh); } catch { return null; }
    const gray = new Uint8Array(W * Hh);
    for (let k = 0; k < gray.length; k++) gray[k] = (img.data[k * 4] * 3 + img.data[k * 4 + 1] * 6 + img.data[k * 4 + 2]) / 10;
    if (prev) {
      let s = 0, cnt = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const k = y * W + x; s += Math.abs(gray[k] - prev[k]); cnt++; }
      samples[i] = s / cnt;
    }
    prev = gray;
    if (i % 10 === 0) { onProgress((i / n) * 100); await new Promise((r) => setTimeout(r, 0)); }
  }
  v.removeAttribute('src'); v.load();

  // fill gaps, then upsample to 100 ms frames
  let last = 0;
  for (let i = 0; i < n; i++) { if (Number.isNaN(samples[i]) || (i === 0 && !samples[i])) samples[i] = last; else last = samples[i]; }
  const frames = Math.ceil(durationMs / 100);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const pos = (f * 100) / SAMPLE_MS, a = Math.floor(pos), b = Math.min(n - 1, a + 1), w = pos - a;
    out[f] = samples[a] * (1 - w) + samples[b] * w;
  }
  onProgress(100);
  return out;
}

/** Normalised "how much is this person moving" (0 = resting, 1 = clearly talking), smoothed ~1 s. */
export function motionToActivity(m: Float32Array): Float32Array {
  const s = Float32Array.from(m).sort();
  const p20 = s[Math.floor(0.2 * s.length)] ?? 0, p90 = s[Math.floor(0.9 * s.length)] ?? 1;
  const span = Math.max(1e-3, p90 - p20);
  const z = new Float32Array(m.length);
  for (let i = 0; i < m.length; i++) z[i] = Math.max(-0.5, Math.min(2, (m[i] - p20) / span));
  const out = new Float32Array(m.length);
  const R = 4;
  for (let i = 0; i < m.length; i++) {
    let a = 0, c = 0;
    for (let k = -R; k <= R; k++) { const j = i + k; if (j >= 0 && j < m.length) { a += z[j]; c++; } }
    out[i] = a / c;
  }
  return out;
}
