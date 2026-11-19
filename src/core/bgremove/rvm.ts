/**
 * RVM (Robust Video Matting, MobileNetV3) on the phone through onnxruntime-web.
 * Made for video: it keeps a small memory (4 recurrent tensors) from frame to frame, so edges do not flicker, and it
 * needs no prompt or face. The model (~15 MB) is bundled by CI into public/rvm; the GitHub release is the fallback.
 * RVM is GPL-3.0 (https://github.com/PeterL1n/RobustVideoMatting).
 */
import { getModelBytes, loadOrt } from './ort';

const FILE = 'rvm_mobilenetv3_fp32.onnx';
const URLS = [
  new URL(`rvm/${FILE}`, document.baseURI).href,
  `https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/${FILE}`,
];
const CACHE = 'editorr-rvm-v1';
/** long side of the picture the model sees, and of the mask that is kept */
export const RVM_LONG = 320;
export const RVM_STORE_LONG = 192;

export async function rvmDownloaded(): Promise<boolean> {
  try {
    const r = await fetch(URLS[0], { method: 'HEAD' });
    if (r.ok && Number(r.headers.get('content-length') || 2e6) > 1_000_000) return true;
  } catch { /* not bundled */ }
  try { const c = await caches.open(CACHE); return !!(await c.match(URLS[1])); } catch { return false; }
}

export class Rvm {
  private state: any[] = [];
  private cv = document.createElement('canvas');
  private sm = document.createElement('canvas');
  private constructor(private ort: any, private sess: any, readonly provider: string) { this.reset(); }

  static async load(stage: (msg: string, pct: number) => void, cancelled: () => boolean): Promise<Rvm> {
    const ort = await loadOrt();
    stage('Loading RVM', 0);
    const bytes = await getModelBytes(CACHE, URLS, 1_000_000, (p) => stage('Downloading RVM (first time only)', p), cancelled);
    stage('Starting RVM', 100);
    const tries: { eps: string[]; name: string }[] = [{ eps: ['webgpu', 'wasm'], name: 'GPU' }, { eps: ['wasm'], name: 'CPU' }];
    let last: unknown = null;
    for (const t of tries) {
      try { return new Rvm(ort, await ort.InferenceSession.create(bytes, { executionProviders: t.eps }), t.name); } catch (e) { last = e; }
    }
    throw last ?? new Error('RVM could not start');
  }

  /** Forget the previous frames (call at the start of a video and after a jump in time). */
  reset(): void {
    this.state = [0, 1, 2, 3].map(() => new this.ort.Tensor('float32', new Float32Array(1), [1, 1, 1, 1]));
  }

  /** Model size for a video: long side RVM_LONG, both multiples of 4. */
  static sizeFor(vw: number, vh: number, long = RVM_LONG): { w: number; h: number } {
    const k = long / Math.max(vw, vh), r4 = (n: number) => Math.max(8, Math.round((n * k) / 4) * 4);
    return { w: r4(vw), h: r4(vh) };
  }

  /** One frame in (video element or canvas), alpha out as 0..255 at the stored size. Frames must come in time order. */
  async matte(frame: CanvasImageSource, vw: number, vh: number): Promise<{ alpha: Uint8Array; w: number; h: number }> {
    const { w, h } = Rvm.sizeFor(vw, vh);
    this.cv.width = w; this.cv.height = h;
    const g = this.cv.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(frame, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data, plane = w * h, data = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) { data[i] = px[i * 4] / 255; data[plane + i] = px[i * 4 + 1] / 255; data[2 * plane + i] = px[i * 4 + 2] / 255; }
    const out = await this.sess.run({
      src: new this.ort.Tensor('float32', data, [1, 3, h, w]),
      r1i: this.state[0], r2i: this.state[1], r3i: this.state[2], r4i: this.state[3],
      downsample_ratio: new this.ort.Tensor('float32', new Float32Array([1]), [1]),
    });
    this.state = [out.r1o, out.r2o, out.r3o, out.r4o];
    const pha = out.pha.data as Float32Array;
    // keep a smaller copy (memory): RVM_STORE_LONG on the long side
    const s = Rvm.sizeFor(vw, vh, RVM_STORE_LONG);
    this.sm.width = w; this.sm.height = h;
    const sg = this.sm.getContext('2d', { willReadFrequently: true })!;
    const big = sg.createImageData(w, h);
    for (let i = 0; i < plane; i++) { const a = Math.max(0, Math.min(255, Math.round(pha[i] * 255))); big.data[i * 4] = a; big.data[i * 4 + 1] = a; big.data[i * 4 + 2] = a; big.data[i * 4 + 3] = 255; }
    sg.putImageData(big, 0, 0);
    const small = document.createElement('canvas'); small.width = s.w; small.height = s.h;
    const smg = small.getContext('2d', { willReadFrequently: true })!;
    smg.imageSmoothingQuality = 'high';
    smg.drawImage(this.sm, 0, 0, s.w, s.h);
    const d = smg.getImageData(0, 0, s.w, s.h).data, alpha = new Uint8Array(s.w * s.h);
    for (let i = 0; i < alpha.length; i++) alpha[i] = d[i * 4];
    return { alpha, w: s.w, h: s.h };
  }

  async dispose(): Promise<void> { try { await this.sess.release(); } catch { /* ignore */ } }
}
