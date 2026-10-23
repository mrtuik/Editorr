export const SAMPLE_RATE = 16000;
/** Waveform resolution used by the timeline. */
export const PEAKS_PER_SEC = 20;

/** Decode the audio track of a video file to mono 16 kHz PCM. */
export async function decodeToMono16k(file: File | Blob): Promise<Float32Array> {
  const buf = await file.arrayBuffer();
  const Ctx = (window.OfflineAudioContext || (window as any).webkitOfflineAudioContext) as typeof OfflineAudioContext;
  const ctx = new Ctx(1, SAMPLE_RATE, SAMPLE_RATE);
  const audio = await ctx.decodeAudioData(buf);
  const ch = audio.numberOfChannels;
  const out = new Float32Array(audio.length);
  for (let c = 0; c < ch; c++) {
    const d = audio.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += d[i] / ch;
  }
  return out;
}

/** RMS energy per hop. hopMs e.g. 5 for sync, 100 for VAD. */
export function rmsEnvelope(pcm: Float32Array, hopMs: number): Float32Array {
  const hop = Math.max(1, Math.round((SAMPLE_RATE * hopMs) / 1000));
  const n = Math.floor(pcm.length / hop);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const base = i * hop;
    for (let j = 0; j < hop; j++) { const v = pcm[base + j]; s += v * v; }
    out[i] = Math.sqrt(s / hop);
  }
  return out;
}

/** Peak-per-bucket values (0..1) for drawing waveforms. */
export function peaks(pcm: Float32Array, buckets: number): Float32Array {
  const out = new Float32Array(buckets);
  const step = pcm.length / buckets;
  let max = 1e-6;
  for (let b = 0; b < buckets; b++) {
    let m = 0;
    const s = Math.floor(b * step), e = Math.min(pcm.length, Math.floor((b + 1) * step));
    for (let i = s; i < e; i += 4) { const v = Math.abs(pcm[i]); if (v > m) m = v; }
    out[b] = m;
    if (m > max) max = m;
  }
  for (let b = 0; b < buckets; b++) out[b] /= max;
  return out;
}

/** Read basic metadata through a hidden <video> element. */
export function probeVideo(url: string): Promise<{ durationMs: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = () =>
      resolve({ durationMs: Math.round(v.duration * 1000), width: v.videoWidth, height: v.videoHeight });
    v.onerror = () => reject(new Error('Could not read this video. Try an MP4 (H.264) file.'));
    v.src = url;
  });
}
