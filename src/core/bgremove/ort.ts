/** onnxruntime-web, loaded once and shared by SAM 2 and RVM. */
const baseUrl = (path: string) => new URL(path, document.baseURI).href;

let ortP: Promise<any> | null = null;
export function loadOrt(): Promise<any> {
  if (!ortP) {
    // @ts-ignore - resolved after `npm install`
    ortP = import('onnxruntime-web/webgpu').then((ort: any) => {
      // wasm files are copied to public/ort by `npm run ort-assets`
      ort.env.wasm.wasmPaths = baseUrl('ort/');
      ort.env.wasm.numThreads = (self as any).crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
      return ort;
    }).catch((e: unknown) => { ortP = null; throw e; });
  }
  return ortP;
}

/**
 * Model bytes, downloaded once. The file is streamed straight into the Cache Storage (never held in memory while it
 * downloads), then read back once. `urls` are tried in order.
 */
export async function getModelBytes(cacheName: string, urls: string[], minBytes: number, onPct: (p: number) => void, cancelled: () => boolean): Promise<Uint8Array> {
  let cache: Cache | null = null;
  try { cache = await caches.open(cacheName); } catch { cache = null; }
  let lastErr: unknown = null;
  for (const url of urls) {
    try {
      const hit = await cache?.match(url);
      if (hit) { const b = new Uint8Array(await hit.arrayBuffer()); if (b.length >= minBytes) return b; await cache?.delete(url); }
      const ac = new AbortController();
      const res = await fetch(url, { signal: ac.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      let got = 0;
      const counter = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctl) {
          if (cancelled()) { ac.abort(); ctl.error(new Error('cancelled')); return; }
          got += chunk.length;
          if (total) onPct(Math.min(99, (got / total) * 100));
          ctl.enqueue(chunk);
        },
      });
      const body = res.body.pipeThrough(counter);
      if (cache) {
        await cache.put(url, new Response(body, { headers: { 'content-type': 'application/octet-stream' } }));
        const back = await cache.match(url);
        const b = new Uint8Array(await back!.arrayBuffer());
        if (b.length < minBytes) { await cache.delete(url); throw new Error('file too small (not a model)'); }
        return b;
      }
      const b = new Uint8Array(await new Response(body).arrayBuffer());
      if (b.length < minBytes) throw new Error('file too small (not a model)');
      return b;
    } catch (e) {
      if ((e as Error).message === 'cancelled' || (e as Error).name === 'AbortError') throw new Error('cancelled');
      lastErr = e;
    }
  }
  throw new Error(`Model download failed: ${(lastErr as Error)?.message ?? 'no connection'}`);
}

/** Heavy models can shut a nearly empty phone off: stop early with a clear message. */
export async function checkBattery(minLevel: number, what: string): Promise<void> {
  try {
    const b = await (navigator as any).getBattery?.();
    if (b && !b.charging && b.level < minLevel) throw new Error(`Battery is at ${Math.round(b.level * 100)}%. Charge to ${Math.round(minLevel * 100)}% or plug in the charger first. ${what} is heavy for the phone.`);
  } catch (e) { if ((e as Error).message.startsWith('Battery')) throw e; }
}

/** Keeps the screen on while a long job runs (a locked screen pauses the WebView). Returns a release function. */
export async function keepAwake(): Promise<() => void> {
  try {
    const lock = await (navigator as any).wakeLock?.request('screen');
    return () => { try { void lock?.release(); } catch { /* ignore */ } };
  } catch { return () => {}; }
}
