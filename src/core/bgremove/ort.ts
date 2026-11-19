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

/** Download with progress, kept in the Cache Storage (so it happens once). `urls` are tried in order. */
export async function getModelBytes(cacheName: string, urls: string[], minBytes: number, onPct: (p: number) => void, cancelled: () => boolean): Promise<Uint8Array> {
  let cache: Cache | null = null;
  try { cache = await caches.open(cacheName); } catch { cache = null; }
  let lastErr: unknown = null;
  for (const url of urls) {
    try {
      const hit = await cache?.match(url);
      if (hit) { const b = new Uint8Array(await hit.arrayBuffer()); if (b.length >= minBytes) return b; }
      const res = await fetch(url);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      const reader = res.body.getReader();
      const parts: Uint8Array[] = [];
      let got = 0;
      for (;;) {
        if (cancelled()) { try { await reader.cancel(); } catch { /* ignore */ } throw new Error('cancelled'); }
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value); got += value.length;
        if (total) onPct(Math.min(99, (got / total) * 100));
      }
      if (got < minBytes) throw new Error('file too small (not a model)');
      const out = new Uint8Array(got);
      let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
      try { await cache?.put(url, new Response(out.slice(0))); } catch { /* storage full: downloaded again next time */ }
      return out;
    } catch (e) {
      if ((e as Error).message === 'cancelled') throw e;
      lastErr = e;
    }
  }
  throw new Error(`Model download failed: ${(lastErr as Error)?.message ?? 'no connection'}`);
}
