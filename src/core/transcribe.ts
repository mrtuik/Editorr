import type { CapWord, CaptionData } from './captions';
import { needsRoman, romanize } from './romanize';
import { EditorrNative, isNative } from './native';

export type WhisperModel = 'base' | 'small';
export const WHISPER_IDS: Record<WhisperModel, string> = { base: 'Xenova/whisper-base', small: 'Xenova/whisper-small' };
export const LANGS: [string, string][] = [['', 'Auto'], ['bengali', 'Bangla'], ['hindi', 'Hindi'], ['english', 'English'], ['urdu', 'Urdu']];


/**
 * Whisper sometimes "hears" a voice it cannot read and repeats one sound ("aa, aa, aa") or a short pattern
 * ("AA, AAWW, AAWW, AA, AAWW, AAWW"). Any word or 2-4 word pattern repeated 3+ times in a row is that loop and is dropped.
 * If almost every word is the same few sounds, the whole result is junk and nothing is returned.
 */
export function dropLoops(words: CapWord[]): CapWord[] {
  const norm = (x: CapWord) => (x.orig || x.w).toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');
  const n = words.map(norm);
  const kill = new Array<boolean>(words.length).fill(false);
  for (let i = 0; i < words.length; i++) if (n[i]!.length === 0) kill[i] = true;
  for (let per = 1; per <= 4; per++) {
    let i = 0;
    while (i + per * 3 <= words.length) {
      let reps = 1;
      while (i + (reps + 1) * per <= words.length) {
        let same = true;
        for (let k = 0; k < per; k++) if (n[i + k] !== n[i + reps * per + k]) { same = false; break; }
        if (!same) break;
        reps++;
      }
      if (reps >= 3) { for (let k = i; k < i + reps * per; k++) kill[k] = true; i += reps * per; } else i++;
    }
  }
  const out = words.filter((_, i) => !kill[i]);
  if (out.length >= 8 && new Set(out.map(norm)).size / out.length < 0.2) return [];
  return out;
}

export interface TranscribeJob { promise: Promise<CaptionData>; cancel: () => void }

/**
 * Speech to words with times. `pcm` is mono 16 kHz audio that starts at timeline 0.
 * Bangla / Hindi come back in their own script; the Latin version (Banglish / Hinglish) is made by romanize().
 */
/** whisper.cpp wants ISO codes; the app's language chips use names. */
const ISO: Record<string, string> = { bengali: 'bn', hindi: 'hi', english: 'en', urdu: 'ur' };

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

type NativeModel = 'tiny' | 'base' | 'small';
const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

/**
 * One native Whisper attempt (whisper.cpp). Rejects with 'native-unavailable' when this build/phone has no native Whisper,
 * and with 'stalled' when it makes no progress for `stallMs` (the caller then tries a faster setting).
 */
function transcribeNative(
  pcm: Float32Array, key: NativeModel, language: string,
  onStatus: (text: string, percent?: number) => void,
  segmentsOnly: boolean, stallMs: number,
): TranscribeJob {
  let cancelled = false;
  let phase: 'prep' | 'listen' = 'prep';
  let lastPct = 0;
  let lastMove = Date.now();
  let startedListening = 0;
  let rejectStall: (e: Error) => void = () => {};
  const handles: { remove: () => void }[] = [];
  const stop = () => { handles.forEach((x) => x.remove()); handles.length = 0; };

  const stallPromise = new Promise<never>((_, rej) => { rejectStall = rej; });
  // elapsed clock (so the screen visibly lives) + stall watchdog
  const ticker = setInterval(() => {
    if (phase === 'listen') {
      onStatus(`Listening ${mmss(Date.now() - startedListening)}`, lastPct);
      if (Date.now() - lastMove > stallMs) { void EditorrNative.whisperCancel(); rejectStall(new Error('stalled')); }
    }
  }, 1000);

  const work = (async (): Promise<CaptionData> => {
    const st = await EditorrNative.whisperStatus();
    if (!st.available) throw new Error('native-unavailable');
    if (!st[key]) {
      onStatus('Downloading model', 0);
      handles.push(await EditorrNative.addListener('whisperDownload', (e: { percent: number }) => onStatus('Downloading model', e.percent)));
      await EditorrNative.whisperDownloadModel({ model: key });
      stop();
    }
    if (cancelled) throw new Error('cancelled');
    onStatus('Preparing audio', 0);
    await EditorrNative.whisperBegin();
    const PIECE = 16000 * 60; // one minute per hand-over keeps every message small
    for (let at = 0; at < pcm.length; at += PIECE) {
      if (cancelled) throw new Error('cancelled');
      await EditorrNative.whisperPush({ data: pcmChunkB64(pcm, at, Math.min(pcm.length, at + PIECE)) });
    }
    phase = 'listen'; startedListening = Date.now(); lastMove = Date.now();
    handles.push(await EditorrNative.addListener('whisperProgress', (e: { percent: number }) => {
      if (e.percent !== lastPct) { lastPct = e.percent; lastMove = Date.now(); }
    }));
    const r = await EditorrNative.whisperRun({ model: key, language: ISO[language] ?? '', words: !segmentsOnly });
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
      const parts = segmentsOnly ? text.split(/\s+/).filter(Boolean) : [text];
      const total = parts.reduce((a, x) => a + x.length + 1, 0);
      let at = s;
      for (const orig of parts) {
        const span = Math.max(80, Math.round(((e - s) * (orig.length + 1)) / total));
        words.push({ orig, w: needsRoman(orig) ? romanize(orig) : orig, s: at, e: Math.max(at + 80, at + span - 20) });
        at += span;
      }
    }
    return { lang: language || 'auto', words: dropLoops(words) };
  })();

  const promise = Promise.race([work, stallPromise]).finally(() => { clearInterval(ticker); stop(); });
  // a stalled attempt's own rejection (from the cancelled run) must not become an unhandled error
  work.catch(() => { /* handled through the race */ });
  return { promise, cancel: () => { cancelled = true; void EditorrNative.whisperCancel(); } };
}

/**
 * Native Whisper with automatic fallbacks, so it can never sit on "Listening" for ever:
 * the chosen model with word timing -> a faster setting if it stops moving -> the tiny model.
 * Without native Whisper in this build the web version is used.
 */
function transcribeNativeTiered(
  pcm: Float32Array, model: WhisperModel, language: string,
  onStatus: (text: string, percent?: number) => void,
  opts: { modelId?: string; segments?: boolean },
): TranscribeJob {
  const first: NativeModel = opts.modelId?.includes('tiny') ? 'tiny' : model;
  const tiers: { key: NativeModel; seg: boolean }[] = [{ key: first, seg: !!opts.segments }];
  if (!opts.segments) tiers.push({ key: first, seg: true });
  if (first === 'small') tiers.push({ key: 'base', seg: true });
  if (first !== 'tiny') tiers.push({ key: 'tiny', seg: true });
  let current: TranscribeJob | null = null;
  let stopped = false;
  const promise = (async (): Promise<CaptionData> => {
    let lastErr = new Error('Transcription failed.');
    // Fallbacks may only use models that are already on the phone: never start a new download in the middle of a retry.
    try {
      const st = await EditorrNative.whisperStatus();
      if (st.available) for (let k = tiers.length - 1; k > 0; k--) if (tiers[k]!.key !== first && !st[tiers[k]!.key]) tiers.splice(k, 1);
    } catch { /* keep the tiers */ }
    for (let i = 0; i < tiers.length; i++) {
      if (stopped) throw new Error('cancelled');
      const t = tiers[i]!;
      if (i > 0) onStatus(`Too slow, trying ${t.key}${t.seg ? ' (faster)' : ''}`, 0);
      // generous for the first try (Small is slow on weak phones), shorter for the fallbacks
      current = transcribeNative(pcm, t.key, language, onStatus, t.seg, i === 0 ? 150_000 : 100_000);
      try { return await current.promise; } catch (e) {
        const err = e as Error;
        if (err.message === 'native-unavailable') throw err;
        if (stopped || err.message === 'cancelled') throw new Error('cancelled');
        lastErr = err.message === 'stalled' ? new Error('Whisper stopped making progress on this phone. Try the Base or Tiny model.') : err;
      }
    }
    throw lastErr;
  })();
  return { promise, cancel: () => { stopped = true; current?.cancel(); } };
}

export function transcribe(
  pcm: Float32Array, model: WhisperModel, language: string,
  onStatus: (text: string, percent?: number) => void,
  /** Fallback options: another model id (e.g. 'Xenova/whisper-tiny') and/or sentence timing instead of word timing (more reliable, words are spread inside each sentence). */
  opts: { modelId?: string; segments?: boolean } = {},
): TranscribeJob {
  if (isNative()) {
    // Native first. If this build has no native Whisper (or it fails to start), fall back to the web version below.
    const native = transcribeNativeTiered(pcm, model, language, onStatus, opts);
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
  // ask the WebView to keep the cached model files instead of evicting them
  try { void navigator.storage?.persist?.(); } catch { /* not supported */ }
  const worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' });
  let settled = false;
  let reject: (e: Error) => void = () => {};
  const promise = new Promise<CaptionData>((resolve, rej) => {
    reject = rej;
    worker.onmessage = (ev: MessageEvent<any>) => {
      const m = ev.data;
      if (m.type === 'status') onStatus(m.text, 0);
      else if (m.type === 'download') onStatus('Loading model', m.percent);
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
        resolve({ lang: language || 'auto', words: dropLoops(words) });
      } else if (m.type === 'error') { settled = true; worker.terminate(); rej(new Error(m.error || 'Transcription failed.')); }
    };
    worker.onerror = (e) => { settled = true; worker.terminate(); rej(new Error(e.message || 'Transcription worker failed.')); };
    const copy = pcm.slice();
    const buf = copy.buffer as ArrayBuffer;
    worker.postMessage({ pcm: buf, model: opts.modelId ?? WHISPER_IDS[model], timestamps: opts.segments ? 'segment' : 'word', language: language || null }, [buf]);
  });
  return { promise, cancel: () => { if (settled) return; settled = true; worker.terminate(); reject(new Error('cancelled')); } };
}
