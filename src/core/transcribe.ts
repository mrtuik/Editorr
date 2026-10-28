import type { CapWord, CaptionData } from './captions';
import { needsRoman, romanize } from './romanize';

export type WhisperModel = 'base' | 'small';
export const WHISPER_IDS: Record<WhisperModel, string> = { base: 'Xenova/whisper-base', small: 'Xenova/whisper-small' };
export const LANGS: [string, string][] = [['', 'Auto'], ['bengali', 'Bangla'], ['hindi', 'Hindi'], ['english', 'English']];

export interface TranscribeJob { promise: Promise<CaptionData>; cancel: () => void }

/**
 * Speech to words with times. `pcm` is mono 16 kHz audio that starts at timeline 0.
 * Bangla / Hindi come back in their own script; the Latin version (Banglish / Hinglish) is made by romanize().
 */
export function transcribe(
  pcm: Float32Array, model: WhisperModel, language: string,
  onStatus: (text: string, percent?: number) => void,
  /** Fallback options: another model id (e.g. 'Xenova/whisper-tiny') and/or sentence timing instead of word timing (more reliable, words are spread inside each sentence). */
  opts: { modelId?: string; segments?: boolean } = {},
): TranscribeJob {
  const worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' });
  let settled = false;
  let reject: (e: Error) => void = () => {};
  const promise = new Promise<CaptionData>((resolve, rej) => {
    reject = rej;
    worker.onmessage = (ev: MessageEvent<any>) => {
      const m = ev.data;
      if (m.type === 'status') onStatus(m.text);
      else if (m.type === 'download') onStatus(`Downloading model ${m.percent}%`, m.percent);
      else if (m.type === 'progress') onStatus('Listening', m.percent);
      else if (m.type === 'done') {
        settled = true; worker.terminate();
        const words: CapWord[] = [];
        for (const c of m.chunks as { text: string; timestamp: [number, number | null] }[]) {
          const text = (c.text ?? '').trim();
          if (!text) continue;
          const s = Math.round((c.timestamp?.[0] ?? 0) * 1000);
          const e = Math.round(((c.timestamp?.[1] ?? (c.timestamp?.[0] ?? 0) + 0.4)) * 1000);
          // sentence timing: spread the words over the sentence by their length
          const parts = opts.segments ? text.split(/\s+/).filter(Boolean) : [text];
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
    worker.postMessage({ pcm: buf, model: opts.modelId ?? WHISPER_IDS[model], timestamps: opts.segments ? 'segment' : 'word', language: language || null, totalChunks: Math.max(1, Math.ceil(pcm.length / 16000 / 20)) }, [buf]);
  });
  return { promise, cancel: () => { if (settled) return; settled = true; worker.terminate(); reject(new Error('cancelled')); } };
}
