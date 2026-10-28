/// <reference lib="webworker" />
/* Whisper on the phone (transformers.js). Model + wasm download once, then the browser cache keeps them. */
let asr: any = null;
let loaded = '';

self.onmessage = async (event: MessageEvent<{ pcm: ArrayBuffer; model: string; timestamps?: 'word' | 'segment'; language: string | null; totalChunks: number }>) => {
  const { pcm, model, language, totalChunks, timestamps } = event.data;
  try {
    // @ts-ignore - resolved after `npm install`
    const tf: any = await import('@xenova/transformers');
    tf.env.allowLocalModels = false;
    tf.env.useBrowserCache = true;
    tf.env.backends.onnx.wasm.numThreads = 1;
    tf.env.backends.onnx.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/';
    if (!asr || loaded !== model) {
      (self as any).postMessage({ type: 'status', text: 'Loading Whisper model (first time downloads it)' });
      asr = await tf.pipeline('automatic-speech-recognition', model, {
        progress_callback: (p: any) => { if (p?.status === 'progress') (self as any).postMessage({ type: 'download', percent: Math.round(p.progress ?? 0), file: p.file }); },
      });
      loaded = model;
    }
    (self as any).postMessage({ type: 'status', text: 'Listening' });
    let done = 0;
    const out = await asr(new Float32Array(pcm), {
      chunk_length_s: 30, stride_length_s: 5, return_timestamps: timestamps === 'segment' ? true : 'word',
      ...(language ? { language, task: 'transcribe' } : { task: 'transcribe' }),
      chunk_callback: () => { done++; (self as any).postMessage({ type: 'progress', percent: Math.min(99, Math.round((done / Math.max(1, totalChunks)) * 100)) }); },
    });
    (self as any).postMessage({ type: 'done', chunks: out.chunks ?? [], text: out.text ?? '' });
  } catch (e) {
    (self as any).postMessage({ type: 'error', error: e instanceof Error ? e.message : String(e) });
  }
};
