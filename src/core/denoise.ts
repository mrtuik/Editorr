export interface DenoiseWorkerJob {
  promise: Promise<Float32Array>;
  cancel: () => void;
}

export function startDenoise(
  pcm: Float32Array,
  strength: number,
  onProgress: (percent: number) => void,
): DenoiseWorkerJob {
  const worker = new Worker(new URL('./denoise.worker.ts', import.meta.url), { type: 'module' });
  let settled = false;
  let rejectJob: (error: Error) => void = () => {};
  const promise = new Promise<Float32Array>((resolve, reject) => {
    rejectJob = reject;
    worker.onmessage = (event: MessageEvent<{ type: string; percent?: number; pcm?: ArrayBuffer; error?: string }>) => {
      const message = event.data;
      if (message.type === 'progress') {
        onProgress(message.percent ?? 0);
      } else if (message.type === 'done' && message.pcm) {
        settled = true;
        worker.terminate();
        resolve(new Float32Array(message.pcm));
      } else if (message.type === 'error') {
        settled = true;
        worker.terminate();
        reject(new Error(message.error || 'Noise reduction failed.'));
      }
    };
    worker.onerror = (event) => {
      settled = true;
      worker.terminate();
      reject(new Error(event.message || 'Noise reduction worker failed.'));
    };
    const copy = pcm.slice();
    const buffer = copy.buffer as ArrayBuffer;
    worker.postMessage({ pcm: buffer, strength: Math.max(0, Math.min(100, Math.round(strength))) }, [buffer]);
  });
  return {
    promise,
    cancel: () => {
      if (settled) return;
      settled = true;
      worker.terminate();
      rejectJob(new Error('Noise reduction cancelled.'));
    },
  };
}
