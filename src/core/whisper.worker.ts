/// <reference lib="webworker" />
/* Whisper on the phone (transformers.js). Model + wasm download once, then the browser cache keeps them.
 * The audio is decoded in short windows (about 25 s, cut at the quietest spot near the edge) so memory stays small,
 * progress is real, and one bad window cannot kill the whole job or crash the WebView. */
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
      if (rms > 0.002) { // skip dead silence: nothing to hear, and it saves time
        const opts = (ts: boolean | 'word') => ({
          return_timestamps: ts,
          ...(language ? { language, task: 'transcribe' } : { task: 'transcribe' }),
        });
        let out: any;
        let seg = !wantWords;
        try {
          out = await asr(piece, opts(wantWords ? 'word' : true));
        } catch {
          // word timing needs more memory; fall back to sentence timing for this window only
          seg = true;
          out = await asr(piece, opts(true));
        }
        for (const c of (out.chunks ?? []) as { text: string; timestamp: [number, number | null] }[]) {
          const a = (c.timestamp?.[0] ?? 0) + offS;
          const b = c.timestamp?.[1] == null ? null : c.timestamp[1] + offS;
          chunks.push({ text: c.text, timestamp: [a, b], seg });
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
