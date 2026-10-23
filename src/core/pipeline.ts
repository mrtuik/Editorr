import { decodeToMono16k } from './audio';
import { findOffset } from './sync';
import { detectSpeakers } from './speaker';
import { EditorrNative, isNative, loadPcm } from './native';
import { runtime } from './store';
import { defaultSegments, overlapDuration } from './timeline';
import type { Project, Role, Segment, Settings, SyncResult } from './types';

// ---------------------------------------------------------------- audio

type Cb = (pct: number) => void;
const progressCbs = new Map<string, Cb>();
let audioListener = false;

/** One native 'audioProgress' listener for the whole app; it hands each percent to whoever waits for that file. */
function ensureAudioListener(): void {
  if (audioListener || !isNative()) return;
  audioListener = true;
  EditorrNative.addListener('audioProgress', (e: { path?: string; percent: number }) => {
    if (e.path) progressCbs.get(e.path)?.(e.percent);
  }).catch(() => { audioListener = false; });
}

/** Audio extraction already running for a file: a second request waits for the same result. */
const jobs = new Map<string, Promise<Float32Array>>();

/**
 * Mono 16 kHz audio of one video, read into memory. Cached in `runtime`.
 * Native: MediaCodec in the plugin. Browser: decodeAudioData.
 */
export function ensureAudio(role: Role, onPct?: Cb): Promise<Float32Array> {
  const have = role === 'host' ? runtime.hostPcm : runtime.constPcm;
  if (have) return Promise.resolve(have);
  const native = isNative();
  const path = role === 'host' ? runtime.hostPath : runtime.constPath;
  const file = role === 'host' ? runtime.hostFile : runtime.constFile;
  const key = native ? path : file ? `${role}:${file.name}:${file.size}` : undefined;
  if (!key) return Promise.reject(new Error('The video is missing. Go back and pick it again.'));

  let job = jobs.get(key);
  if (!job) {
    const pid = runtime.projectId;
    job = (async () => {
      let pcm: Float32Array;
      if (native) {
        ensureAudioListener();
        progressCbs.set(path!, (n) => onPct?.(n));
        try {
          const r = await EditorrNative.extractAudio({ path: path! });
          pcm = await loadPcm(r.pcmPath);
        } finally { progressCbs.delete(path!); }
      } else {
        pcm = await decodeToMono16k(file!);
      }
      // keep it only if the same project is still open
      if (runtime.projectId === pid) { if (role === 'host') runtime.hostPcm = pcm; else runtime.constPcm = pcm; }
      return pcm;
    })().finally(() => jobs.delete(key));
    jobs.set(key, job);
  } else if (onPct) {
    // joined a running job: progress comes from the first caller's callback only
    onPct(0);
  }
  return job;
}

// ---------------------------------------------------------------- sync + auto switch

/** Find the offset between the two videos from their audio. Sets offset, confidence and the edit length. */
export function runSync(p: Project): SyncResult {
  const r = findOffset(runtime.hostPcm!, runtime.constPcm!);
  p.offsetMs = r.offsetMs;
  p.syncConfidence = r.confidence;
  p.durationMs = overlapDuration(p.host!.durationMs, p.constant!.durationMs, p.offsetMs);
  return r;
}

/** Who is speaking: builds the layout segments. Falls back to one full-length segment when it cannot tell. */
export function runAutoSwitch(p: Project, settings: Settings): Segment[] {
  try {
    const segs = detectSpeakers(runtime.hostPcm!, runtime.constPcm!, p.offsetMs, p.durationMs, settings, p.mainAudio);
    if (segs.length) return segs;
  } catch { /* fall through */ }
  return defaultSegments(p.durationMs, p.mainAudio);
}

/** Give the browser a moment to paint (so a pill shows up) before a long synchronous calculation. */
export function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 30)));
}
