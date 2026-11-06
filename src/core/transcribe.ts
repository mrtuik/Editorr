import type { CapWord, CaptionData } from './captions';
import { needsRoman, romanize } from './romanize';
import { EditorrNative, isNative } from './native';

/** Whistle (Cactus needle engine): one small model per language. */
export type WhistleLang = 'english' | 'bengali' | 'hindi';
export const WHISTLE_MODELS: Record<WhistleLang, { name: string; sizeMb: number }> = {
  english: { name: 'Whistle English', sizeMb: 16.9 },
  bengali: { name: 'Whistle Bangla (2-bit)', sizeMb: 30.5 },
  hindi: { name: 'Shruti Hindi (Whistle)', sizeMb: 29.5 },
};
export const LANGS: [string, string][] = [['bengali', 'Bangla (Banglish)'], ['hindi', 'Hindi (Hinglish)'], ['english', 'English']];
/** Old saved settings may hold '' (auto) or 'urdu': those map to Bangla. */
export const normLang = (l: string | undefined): WhistleLang => (l === 'english' || l === 'hindi' || l === 'bengali' ? l : 'bengali');


/**
 * Speech models sometimes "hears" a voice it cannot read and repeats one sound ("aa, aa, aa") or a short pattern
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

const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

/**
 * Speech to words with times, with Whistle (Cactus needle engine) running natively on the phone.
 * `pcm` is mono 16 kHz audio that starts at timeline 0. Bangla / Hindi come back in their own script;
 * the Latin version (Banglish / Hinglish) is made by romanize().
 * opts.segments = ignore the engine's word times and spread the words inside each piece (fallback).
 * opts.token = Hugging Face token (only the gated Bangla model needs it).
 */
export function transcribe(
  pcm: Float32Array, langIn: string,
  onStatus: (text: string, percent?: number) => void,
  opts: { segments?: boolean; token?: string; stallMs?: number } = {},
): TranscribeJob {
  const language = normLang(langIn);
  const segmentsOnly = !!opts.segments;
  const stallMs = opts.stallMs ?? 120_000;
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
      if (Date.now() - lastMove > stallMs) { void EditorrNative.whistleCancel(); rejectStall(new Error('Whistle stopped making progress on this phone.')); }
    }
  }, 1000);

  const work = (async (): Promise<CaptionData> => {
    if (!isNative()) throw new Error('Captions run on the phone (Whistle). Install the Android app to make captions.');
    const st = await EditorrNative.whistleStatus();
    if (!st.available) throw new Error('Whistle is not in this build (the needle engine was not linked). Rebuild the APK.');
    if (!st[language]) {
      const info = WHISTLE_MODELS[language];
      onStatus(`Downloading ${info.name} (${info.sizeMb} MB)`, 0);
      handles.push(await EditorrNative.addListener('whistleDownload', (e: { percent: number }) => onStatus(`Downloading ${info.name} (${info.sizeMb} MB)`, e.percent)));
      await EditorrNative.whistleDownloadModel({ lang: language, token: opts.token ?? '' });
      stop();
    }
    if (cancelled) throw new Error('cancelled');
    onStatus('Preparing audio', 0);
    await EditorrNative.whistleBegin();
    const PIECE = 16000 * 60; // one minute per hand-over keeps every message small
    for (let at = 0; at < pcm.length; at += PIECE) {
      if (cancelled) throw new Error('cancelled');
      await EditorrNative.whistlePush({ data: pcmChunkB64(pcm, at, Math.min(pcm.length, at + PIECE)) });
    }
    phase = 'listen'; startedListening = Date.now(); lastMove = Date.now();
    handles.push(await EditorrNative.addListener('whistleProgress', (e: { percent: number }) => {
      if (e.percent !== lastPct) { lastPct = e.percent; lastMove = Date.now(); }
    }));
    const r = await EditorrNative.whistleRun({ lang: language, words: !segmentsOnly });
    const segs = JSON.parse(r.segments) as { t0: number; t1: number; text: string; seg?: boolean }[];
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
      const parts = segmentsOnly || sgm.seg ? text.split(/\s+/).filter(Boolean) : [text];
      const total = parts.reduce((a, x) => a + x.length + 1, 0);
      let at = s;
      for (const orig of parts) {
        const span = Math.max(80, Math.round(((e - s) * (orig.length + 1)) / total));
        words.push({ orig, w: needsRoman(orig) ? romanize(orig) : orig, s: at, e: Math.max(at + 80, at + span - 20) });
        at += span;
      }
    }
    return { lang: language, words: dropLoops(words) };
  })();

  const promise = Promise.race([work, stallPromise]).finally(() => { clearInterval(ticker); stop(); });
  // a stalled attempt's own rejection (from the cancelled run) must not become an unhandled error
  work.catch(() => { /* handled through the race */ });
  return { promise, cancel: () => { cancelled = true; void EditorrNative.whistleCancel(); } };
}
