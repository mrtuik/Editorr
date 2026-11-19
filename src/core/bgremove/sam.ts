/**
 * SAM 2 (Segment Anything 2, hiera-tiny) on the phone through onnxruntime-web.
 * encoder: frame 1024x1024 -> image_embed + 2 high-res feature maps; decoder: points -> 3 candidate masks (256x256 logits).
 * The models (about 150 MB) are downloaded once and kept in the Cache Storage.
 * Runs on WebGPU when the WebView has it, else on WASM (slower, same result).
 */
// Model files from huggingface.co/SharpAI/sam2-hiera-tiny-onnx (Apache-2.0, converted from facebook/sam2-hiera-tiny).
export const SAM_ENCODER_URL = 'https://huggingface.co/SharpAI/sam2-hiera-tiny-onnx/resolve/main/encoder.with_runtime_opt.ort';
export const SAM_DECODER_URL = 'https://huggingface.co/SharpAI/sam2-hiera-tiny-onnx/resolve/main/decoder.onnx';
const CACHE = 'editorr-sam2-v1';
const S = 1024;       // encoder input size
export const MASK = 256; // decoder output size

import { checkBattery, getModelBytes, loadOrt } from './ort';

/** true when both model files are already on the phone */
export async function samDownloaded(): Promise<boolean> {
  try {
    const c = await caches.open(CACHE);
    return !!(await c.match(SAM_ENCODER_URL)) && !!(await c.match(SAM_DECODER_URL));
  } catch { return false; }
}

const getModel = (url: string, onPct: (p: number) => void, cancelled: () => boolean) => getModelBytes(CACHE, [url], 1_000_000, onPct, cancelled);

export interface Embed { image_embed: any; high_res_feats_0: any; high_res_feats_1: any }
export interface Prompt { x: number; y: number }

export class Sam2 {
  private constructor(private ort: any, private enc: any, private dec: any, public provider: string, private encBytes: Uint8Array) {}
  private cv = document.createElement('canvas');

  private static makeEnc(ort: any, bytes: Uint8Array, eps: string[]) {
    return ort.InferenceSession.create(bytes, { executionProviders: eps, graphOptimizationLevel: 'disabled', enableCpuMemArena: false, enableMemPattern: false });
  }

  static async load(stage: (msg: string, pct: number) => void, cancelled: () => boolean): Promise<Sam2> {
    await checkBattery(0.25, 'SAM 2');
    const ort = await loadOrt();
    stage('Downloading SAM 2 (first time only)', 0);
    const encBytes = await getModel(SAM_ENCODER_URL, (p) => stage('Downloading SAM 2 (first time only)', p * 0.9), cancelled);
    const decBytes = await getModel(SAM_DECODER_URL, (p) => stage('Downloading SAM 2 (first time only)', 90 + p * 0.1), cancelled);
    stage('Starting SAM 2', 100);
    let enc: any, name = 'GPU';
    try { enc = await Sam2.makeEnc(ort, encBytes, ['webgpu', 'wasm']); } catch { enc = await Sam2.makeEnc(ort, encBytes, ['wasm']); name = 'CPU'; }
    const dec = await ort.InferenceSession.create(decBytes, { executionProviders: ['wasm'] });
    return new Sam2(ort, enc, dec, name, encBytes);
  }

  /** Picture (video frame or canvas) -> embedding. This is the slow step (seconds). */
  async embed(frame: CanvasImageSource): Promise<Embed> {
    this.cv.width = S; this.cv.height = S;
    const g = this.cv.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(frame, 0, 0, S, S);
    const px = g.getImageData(0, 0, S, S).data;
    const plane = S * S, data = new Float32Array(3 * plane);
    const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
    for (let i = 0; i < plane; i++) {
      data[i] = (px[i * 4] / 255 - mean[0]) / std[0];
      data[plane + i] = (px[i * 4 + 1] / 255 - mean[1]) / std[1];
      data[2 * plane + i] = (px[i * 4 + 2] / 255 - mean[2]) / std[2];
    }
    const feeds = { image: new this.ort.Tensor('float32', data, [1, 3, S, S]) };
    let out: any;
    try { out = await this.enc.run(feeds); }
    catch (e) {
      // the GPU backend can fail on a layer at run time: start again on the CPU
      if (this.provider !== 'GPU') throw e;
      try { await this.enc.release(); } catch { /* ignore */ }
      this.enc = await Sam2.makeEnc(this.ort, this.encBytes, ['wasm']); this.provider = 'CPU';
      out = await this.enc.run(feeds);
    }
    return { image_embed: out.image_embed, high_res_feats_0: out.high_res_feats_0, high_res_feats_1: out.high_res_feats_1 };
  }

  /** Foreground points (0..1 of the frame) -> alpha 0..255 (MASK x MASK) and the model's own quality score. */
  async segment(e: Embed, pts: Prompt[]): Promise<{ alpha: Uint8Array; iou: number }> {
    const list = pts.length >= 2 ? pts.slice(0, 2) : [pts[0], pts[0]];
    const coords = new Float32Array([list[0].x * S, list[0].y * S, list[1].x * S, list[1].y * S]);
    const out = await this.dec.run({
      image_embed: e.image_embed, high_res_feats_0: e.high_res_feats_0, high_res_feats_1: e.high_res_feats_1,
      point_coords: new this.ort.Tensor('float32', coords, [1, 2, 2]),
      point_labels: new this.ort.Tensor('float32', new Float32Array([1, 1]), [1, 2]),
      mask_input: new this.ort.Tensor('float32', new Float32Array(MASK * MASK), [1, 1, MASK, MASK]),
      has_mask_input: new this.ort.Tensor('float32', new Float32Array([0]), [1]),
    });
    const masks = out.masks.data as Float32Array, ious = out.iou_predictions.data as Float32Array;
    const n = ious.length; let best = 0;
    for (let i = 1; i < n; i++) if (ious[i] > ious[best]) best = i;
    const off = best * MASK * MASK, alpha = new Uint8Array(MASK * MASK);
    for (let i = 0; i < alpha.length; i++) alpha[i] = Math.round(255 / (1 + Math.exp(-1.6 * masks[off + i])));
    return { alpha, iou: ious[best] };
  }

  async dispose(): Promise<void> {
    try { await this.enc.release(); await this.dec.release(); } catch { /* ignore */ }
  }
}

/** Share of the frame the mask covers, and where its centre is (0..1). */
export function maskStats(a: Uint8Array): { area: number; cx: number; cy: number } {
  let sum = 0, sx = 0, sy = 0;
  for (let y = 0; y < MASK; y++) for (let x = 0; x < MASK; x++) { const v = a[y * MASK + x] / 255; if (v > 0.5) { sum++; sx += x; sy += y; } }
  return { area: sum / (MASK * MASK), cx: sum ? sx / sum / MASK : 0.5, cy: sum ? sy / sum / MASK : 0.5 };
}
