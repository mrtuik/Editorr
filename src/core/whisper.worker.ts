/// <reference lib="webworker" />
/* Whisper on the phone (transformers.js). Model + wasm download once, then the browser cache keeps them.
 * The audio is decoded in short windows (about 25 s, cut at the quietest spot near the edge) so memory stays small,
 * progress is real, and one bad window cannot kill the whole job or crash the WebView.
 *
 * Anti-hallucination ("AA, AAWW, AAWW") layers:
 *  1. Adaptive voice gate: a window is skipped unless its energy clearly stands above the noise floor,
 *     so fans / hum / silence never reach the decoder.
 *  2. Decoder config: `condition_on_previous_text: false` (one window's garbage can no longer seed the next),
 *     `no_speech_threshold` + `compression_ratio_threshold` (Whisper drops its own repeated/non-speech output),
 *     and a small temperature ladder for a deterministic first pass.
 *  3. Window loop filter: a decoded window that is mostly one repeated sound is re-tried once at a higher
 *     temperature and, if still loopy, dropped instead of being shown to the user.
 */
let asr: any = null;
let loaded = '';

const SR = 16000;
const WINDOW = 25 * SR;
const SEARCH = 2 * SR;

/** Quietest point within +-2 s of `target` (so a window never cuts through a word if it can be avoided). */
function quietCut(pcm: Float32Array, target: number): number {
  const lo = Math.max(0, target - SEARCH), hi = Math.min(pcm.length, target + SEARCH);
  const step = Math.round(SR * 0.02);
  let best = target, bestE = Infinity;
  for (let i = lo; i + step <= hi; i += step) {
    let e = 0;
    for (let k = 0; k < step; k += 4) e += pcm[i + k]! * pcm[i + k]!;
    if (e < bestE) { bestE = e; best = i + (step >> 1); }
  }
  return best;
}

/** Normalize a caption piece for loop detection (letters only, lowercase). */
const normWord = (t: string) => t.toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');

/**
 * True when a window's decoded words are the "AA, AAWW, AAWW" pattern:
 * a 1-2 word block repeated 3+ times in a row, or almost every word drawn from 1-2 sounds.
 */
function looksLikeLoop(texts: string[]): boolean {
  const words = texts.map(normWord).filter((w) => w.length > 0);
  if (words.length < 3) return false;
  for (let per = 1; per <= 2; per++) {
    let i = 0;
    while (i + per * 3 <= words.length) {
      let reps = 1;
      while (i + (reps + 1) * per <= words.length) {
        let same = true;
        for (let k = 0; k < per; k++) if (words[i + k] !== words[i + reps * per + k]) { same = false; break; }
        if (!same) break;
        reps++;
      }
      if (reps >= 3) return true;
      i++;
    }
  }
  // almost every word is one of two sounds: junk the whole window
  const uniq = new Set(words);
  if (words.length >= 6 && uniq.size / words.length < 0.25) return true;
  return false;
}

const post = (m: unknown) => (self as any).postMessage(m);

self.onmessage = async (event: MessageEvent<{ pcm: ArrayBuffer; model: string; timestamps?: 'word' | 'segment'; language: string | null }>) => {
  const { pcm: buf, model, language, timestamps } = event.data;
  try {
    const pcm = new Float32Array(buf);
    // @ts-ignore - resolved after `npm install`
    const tf: any = await import('@xenova/transformers');
    tf.env.allowLocalModels = false;
    tf.env.useBrowserCache = true;
    tf.env.backends.onnx.wasm.numThreads = 1;
    tf.env.backends.onnx.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/';
    if (!asr || loaded !== model) {
      post({ type: 'status', text: 'Loading Whisper model (first time downloads it)' });
      const files = new Map<string, number>();
      asr = await tf.pipeline('automatic-speech-recognition', model, {
        // One overall number across all model files, so the percentage never jumps back to 0 for the next file.
        progress_callback: (p: any) => {
          if (p?.status !== 'progress' && p?.status !== 'done') return;
          files.set(p.file ?? '', p.status === 'done' ? 100 : (p.progress ?? 0));
          let sum = 0; for (const v of files.values()) sum += v;
          post({ type: 'download', percent: Math.min(100, Math.round(sum / Math.max(1, files.size))), file: p.file });
        },
      });
      loaded = model;
    }
    post({ type: 'status', text: 'Listening' });

    // Never write Urdu/Arabic letters unless that language was chosen (Whisper sometimes does it for Bangla/Hindi speech).
    let bad: number[] | undefined;
    if (language && !['urdu', 'arabic', 'persian'].includes(language)) {
      try {
        const tok = asr.tokenizer;
        const n = tok.model?.vocab?.length ?? 0;
        const arab = /[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
        bad = [];
        for (let id = 0; id < n; id++) { let t = ''; try { t = tok.decode([id]); } catch { continue; } if (arab.test(t)) bad.push(id); }
      } catch { bad = undefined; }
    }

    // Adaptive voice gate: one pass to find the loudest peak, then a window is skipped when its level
    // is under 20% of that peak (background fan / hum / hiss) and 0.002 absolute minimum for true silence.
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) { const v = Math.abs(pcm[i]!); if (v > peak) peak = v; }
    const gate = Math.max(0.002, peak * 0.2);

    const wantWords = timestamps !== 'segment';
    const chunks: { text: string; timestamp: [number, number | null]; seg: boolean }[] = [];
    let from = 0;
    while (from < pcm.length) {
      let to = Math.min(pcm.length, from + WINDOW);
      if (to < pcm.length) to = Math.max(from + SR * 5, quietCut(pcm, to));
      const piece = pcm.slice(from, to);
      const offS = from / SR;
      let rms = 0;
      for (let i = 0; i < piece.length; i += 8) rms += piece[i]! * piece[i]!;
      rms = Math.sqrt(rms / Math.max(1, piece.length / 8));
      if (rms >= gate) { // adaptive gate: background sound and dead silence never reach the decoder
        const opts = (ts: boolean | 'word', sup = true, temperature = 0) => ({
          return_timestamps: ts,
          condition_on_previous_text: false, // one window's hallucination can no longer seed the next window
          no_speech_threshold: 0.6, // drop output when Whisper itself is unsure there is speech
          compression_ratio_threshold: 2.4, // drop overly repetitive output (the classic "aa aa aa" loop)
          temperature, // 0 first: the most faithful decode; a retry may raise it
          ...(language ? { language, task: 'transcribe' } : { task: 'transcribe' }),
          ...(sup && bad && bad.length ? { suppress_tokens: bad } : {}),
        });
        // if this transformers.js build rejects an option or suppress_tokens, silently go on without it
        const ask = async (ts: boolean | 'word', temperature = 0) => {
          try { return await asr(piece, opts(ts, true, temperature)); } catch (err) {
            if (temperature === 0 && bad && bad.length) { bad = undefined; return await asr(piece, opts(ts, false, temperature)); }
            throw err;
          }
        };
        const decode = async (ts: boolean | 'word') => {
          let out = await ask(ts);
          // Loop filter: if the window came back as "AA, AAWW, AAWW", decode it once more at a higher
          // temperature; sampling breaks the greedy repetition lock. Keep the better of the two.
          const texts = (out.chunks ?? []).map((c: any) => c.text ?? '');
          if (looksLikeLoop(texts.length ? texts : String(out.text ?? '').split(/\s+/))) {
            try { out = await ask(ts, 0.6); } catch { /* keep the first decode */ }
          }
          return out;
        };
        let out: any;
        let seg = !wantWords;
        try {
          out = await decode(wantWords ? 'word' : true);
        } catch {
          // word timing needs more memory; fall back to sentence timing for this window only
          seg = true;
          out = await decode(true);
        }
        const winTexts = (out.chunks ?? []).map((c: any) => c.text ?? '');
        if (!looksLikeLoop(winTexts.length ? winTexts : String(out.text ?? '').split(/\s+/))) {
          for (const c of (out.chunks ?? []) as { text: string; timestamp: [number, number | null] }[]) {
            const a = (c.timestamp?.[0] ?? 0) + offS;
            const b = c.timestamp?.[1] == null ? null : c.timestamp[1] + offS;
            chunks.push({ text: c.text, timestamp: [a, b], seg });
          }
        }
      }
      from = to;
      post({ type: 'progress', percent: Math.min(99, Math.round((from / pcm.length) * 100)) });
    }
    post({ type: 'done', chunks, text: chunks.map((c) => c.text).join(' ') });
  } catch (e) {
    post({ type: 'error', error: e instanceof Error ? e.message : String(e) });
  }
};
