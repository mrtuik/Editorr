import type { CapWord, CaptionData } from './captions';
import { needsRoman, romanize } from './romanize';
import { EditorrNative, isNative } from './native';

export type WhisperModel = 'base' | 'small';
export const WHISPER_IDS: Record<WhisperModel, string> = { base: 'Xenova/whisper-base', small: 'Xenova/whisper-small' };
export const LANGS: [string, string][] = [['', 'Auto'], ['bengali', 'Bangla'], ['hindi', 'Hindi'], ['english', 'English']];

export interface TranscribeJob { promise: Promise<CaptionData>; cancel: () => void }

/**
 * Speech to words with times. `pcm` is mono 16 kHz audio that starts at timeline 0.
 * Bangla / Hindi come back in their own script; the Latin version (Banglish / Hinglish) is made by romanize().
 */
/** whisper.cpp wants ISO codes; the app's language chips use names. */
const ISO: Record<string, string> = { bengali: 'bn', hindi: 'hi', english: 'en' };

/** Float32 mono 16 kHz -> little-endian 16-bit -> base64 (for the native side). */
function pcmChunkB64(pcm: Float32Array, from: number, to: number): string {
  const n = to - from;
  const bytes = new Uint8Array(n * 2);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, pcm[from + i]!));
    dv.setInt16(i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Whisper running natively (whisper.cpp). Rejects with 'native-unavailable' when this build does not have it, so the caller can use the web version. */
function transcribeNative(
  pcm: Float32Array, model: WhisperModel, language: string,
  onStatus: (text: string, percent?: number) => void,
  opts: { modelId?: string; segments?: boolean },
): TranscribeJob {
  let cancelled = false;
  const key = opts.modelId?.includes('tiny') ? 'tiny' : model;
  const handles: { remove: () => void }[] = [];
  const promise = (async (): Promise<CaptionData> => {
    try {
      const st = await EditorrNative.whisperStatus();
      if (!st.available) throw new Error('native-unavailable');
      if (!st[key]) {
        onStatus('Downloading model', 0);
        handles.push(await EditorrNative.addListener('whisperDownload', (e: { percent: number }) => onStatus('Downloading model', e.percent)));
        await EditorrNative.whisperDownloadModel({ model: key });
        handles.forEach((x) => x.remove()); handles.length = 0;
      }
      if (cancelled) throw new Error('cancelled');
      onStatus('Preparing audio', 0);
      await EditorrNative.whisperBegin();
      const PIECE = 16000 * 60; // one minute per hand-over keeps every message small
      for (let at = 0; at < pcm.length; at += PIECE) {
        if (cancelled) throw new Error('cancelled');
        await EditorrNative.whisperPush({ data: pcmChunkB64(pcm, at, Math.min(pcm.length, at + PIECE)) });
      }
      onStatus('Listening', 0);
      handles.push(await EditorrNative.addListener('whisperProgress', (e: { percent: number }) => onStatus('Listening', e.percent)));
      const r = await EditorrNative.whisperRun({ model: key, language: ISO[language] ?? '', words: !opts.segments });
      const segs = JSON.parse(r.segments) as { t0: number; t1: number; text: string }[];
      const words: CapWord[] = [];
      for (const sgm of segs) {
        const text = (sgm.text ?? '').trim();
        if (!text) continue;
        // punctuation-only pieces belong to the word before them
        if (words.length && /^[\p{P}\p{S}]+$/u.test(text)) {
          const prev = words[words.length - 1]!;
          prev.orig += text; prev.w += text; prev.e = Math.max(prev.e, sgm.t1);
          continue;
        }
        const s = Math.max(0, sgm.t0), e = Math.max(s + 80, sgm.t1);
        const parts = opts.segments ? text.split(/\s+/).filter(Boolean) : [text];
        const total = parts.reduce((a, x) => a + x.length + 1, 0);
        let at = s;
        for (const orig of parts) {
          const span = Math.max(80, Math.round(((e - s) * (orig.length + 1)) / total));
          words.push({ orig, w: needsRoman(orig) ? romanize(orig) : orig, s: at, e: Math.max(at + 80, at + span - 20) });
          at += span;
        }
      }
      return { lang: language || 'auto', words };
    } finally {
      handles.forEach((x) => x.remove());
    }
  })();
  return { promise, cancel: () => { cancelled = true; void EditorrNative.whisperCancel(); } };
}

export function transcribe(
  pcm: Float32Array, model: WhisperModel, language: string,
  onStatus: (text: string, percent?: number) => void,
  /** Fallback options: another model id (e.g. 'Xenova/whisper-tiny') and/or sentence timing instead of word timing (more reliable, words are spread inside each sentence). */
  opts: { modelId?: string; segments?: boolean } = {},
): TranscribeJob {
  if (isNative()) {
    // Native first. If this build has no native Whisper (or it fails to start), fall back to the web version below.
    const native = transcribeNative(pcm, model, language, onStatus, opts);
    let inner: TranscribeJob | null = null;
    let stopped = false;
    const promise = native.promise.catch((e: Error) => {
      if (stopped || e.message === 'cancelled' || e.message !== 'native-unavailable') throw e;
      inner = transcribeWeb(pcm, model, language, onStatus, opts);
      return inner.promise;
    });
    return { promise, cancel: () => { stopped = true; native.cancel(); inner?.cancel(); } };
  }
  return transcribeWeb(pcm, model, language, onStatus, opts);
}

function transcribeWeb(
  pcm: Float32Array, model: WhisperModel, language: string,
  onStatus: (text: string, percent?: number) => void,
  opts: { modelId?: string; segments?: boolean },
): TranscribeJob {
  const worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' });
  let settled = false;
  let reject: (e: Error) => void = () => {};
  const promise = new Promise<CaptionData>((resolve, rej) => {
    reject = rej;
    worker.onmessage = (ev: MessageEvent<any>) => {
      const m = ev.data;
      if (m.type === 'status') onStatus(m.text, 0);
      else if (m.type === 'download') onStatus('Downloading model', m.percent);
      else if (m.type === 'progress') onStatus('Listening', m.percent);
      else if (m.type === 'done') {
        settled = true; worker.terminate();
        const words: CapWord[] = [];
        for (const c of m.chunks as { text: string; timestamp: [number, number | null]; seg?: boolean }[]) {
          const text = (c.text ?? '').trim();
          if (!text) continue;
          const s = Math.round((c.timestamp?.[0] ?? 0) * 1000);
          const e = Math.round(((c.timestamp?.[1] ?? (c.timestamp?.[0] ?? 0) + 0.4)) * 1000);
          // sentence timing: spread the words over the sentence by their length
          const parts = opts.segments || c.seg ? text.split(/\s+/).filter(Boolean) : [text];
          const total = parts.reduce((a, x) => a + x.length + 1, 0);
          let at = s;
          for (const orig of parts) {
            const span = Math.max(80, Math.round(((e - s) * (orig.length + 1)) / total));
            words.push({ orig, w: needsRoman(orig) ? romanize(orig) : orig, s: at, e: Math.max(at + 80, at + span - 20) });
            at += span;
          }
        }
        resolve({ lang: language || 'auto', words });
      } else if (m.type === 'error') { settled = true; worker.terminate(); rej(new Error(m.error || 'Transcription failed.')); }
    };
    worker.onerror = (e) => { settled = true; worker.terminate(); rej(new Error(e.message || 'Transcription worker failed.')); };
    const copy = pcm.slice();
    const buf = copy.buffer as ArrayBuffer;
    worker.postMessage({ pcm: buf, model: opts.modelId ?? WHISPER_IDS[model], timestamps: opts.segments ? 'segment' : 'word', language: language || null }, [buf]);
  });
  return { promise, cancel: () => { if (settled) return; settled = true; worker.terminate(); reject(new Error('cancelled')); } };
}
