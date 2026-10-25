/**
 * The dynamics half of Enhanced Audio, as AudioWorklet source text: de-esser -> compressor -> output gain -> brickwall limiter.
 * Plain JavaScript on purpose (it runs inside the audio thread). The Java FxProcessor in EditorrNativePlugin.java is the same
 * algorithm line by line, so the exported video sounds like the preview. Change both together.
 */
export const FX_WORKLET_NAME = 'editorr-fx-dyn';

export const FX_WORKLET_SRC = `
class EditorrFxDyn extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cfg = null;
    this.k = null;            // derived constants
    this.bp = [];             // de-esser band-pass state per channel [x1,x2,y1,y2]
    this.grC = 0; this.grD = 0; this.lim = 1;
    this.port.onmessage = (e) => { this.cfg = e.data; this.derive(); };
  }
  derive() {
    const c = this.cfg, sr = sampleRate, k = {};
    const co = (ms) => Math.exp(-1 / (sr * Math.max(0.0001, ms / 1000)));
    k.deOn = !!c.deOn;
    k.deThr = -10 - c.deAmount * 0.35;               // dB, band level above this gets pulled down
    k.deRatio = 6;
    k.deAtt = co(1); k.deRel = co(40);
    const w0 = 2 * Math.PI * Math.min(c.deF, sr * 0.49) / sr, cs = Math.cos(w0), sn = Math.sin(w0), al = sn / (2 * 1.2);
    const a0 = 1 + al;                                // band-pass, 0 dB peak, Q 1.2
    k.b0 = al / a0; k.b2 = -al / a0; k.a1 = -2 * cs / a0; k.a2 = (1 - al) / a0;
    k.compOn = !!c.compOn;
    k.thr = c.thr; k.ratio = Math.max(1, c.ratio); k.knee = 6;
    k.att = co(c.attack); k.rel = co(c.release);
    k.makeupLin = Math.pow(10, c.makeup / 20);
    k.outLin = Math.pow(10, c.outGain / 20);
    k.ceil = Math.pow(10, c.ceiling / 20);
    k.limRel = co(50);
    this.k = k;
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length || !out || !out.length) return true;
    const nch = Math.min(inp.length, out.length), n = inp[0].length;
    for (let c = 0; c < nch; c++) out[c].set(inp[c]);
    if (!this.k) return true;
    const k = this.k;
    while (this.bp.length < nch) this.bp.push([0, 0, 0, 0]);
    const band = [0, 0], rest = [0, 0];
    for (let i = 0; i < n; i++) {
      if (k.deOn) {
        let lv = 0;
        for (let c = 0; c < nch; c++) {
          const x = out[c][i], s = this.bp[c];
          const y = k.b0 * x + k.b2 * s[1] - k.a1 * s[2] - k.a2 * s[3];   // b1 = 0
          s[1] = s[0]; s[0] = x; s[3] = s[2]; s[2] = y;
          band[c] = y; rest[c] = x - y;
          const a = Math.abs(y); if (a > lv) lv = a;
        }
        const over = 20 * Math.log10(lv + 1e-9) - k.deThr;
        const target = over > 0 ? over * (1 - 1 / k.deRatio) : 0;
        this.grD = target > this.grD ? this.grD * k.deAtt + (1 - k.deAtt) * target : this.grD * k.deRel + (1 - k.deRel) * target;
        const gd = Math.exp(-this.grD * 0.11512925464970229);
        for (let c = 0; c < nch; c++) out[c][i] = rest[c] + band[c] * gd;
      }
      if (k.compOn) {
        let lv = 0;
        for (let c = 0; c < nch; c++) { const a = Math.abs(out[c][i]); if (a > lv) lv = a; }
        const over = 20 * Math.log10(lv + 1e-9) - k.thr;
        let target = 0;
        if (2 * over > k.knee) target = over * (1 - 1 / k.ratio);
        else if (2 * over > -k.knee) { const t = over + k.knee / 2; target = (1 - 1 / k.ratio) * t * t / (2 * k.knee); }
        this.grC = target > this.grC ? this.grC * k.att + (1 - k.att) * target : this.grC * k.rel + (1 - k.rel) * target;
        const g = Math.exp(-this.grC * 0.11512925464970229) * k.makeupLin;
        for (let c = 0; c < nch; c++) out[c][i] *= g;
      }
      let pk = 0;
      for (let c = 0; c < nch; c++) { const v = out[c][i] * k.outLin; out[c][i] = v; const a = Math.abs(v); if (a > pk) pk = a; }
      const t = pk > k.ceil ? k.ceil / pk : 1;
      this.lim = t < this.lim ? t : t + (this.lim - t) * k.limRel;
      for (let c = 0; c < nch; c++) {
        let v = out[c][i] * this.lim;
        if (v > k.ceil) v = k.ceil; else if (v < -k.ceil) v = -k.ceil;
        out[c][i] = v;
      }
    }
    return true;
  }
}
registerProcessor('${FX_WORKLET_NAME}', EditorrFxDyn);
`;
