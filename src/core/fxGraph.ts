import { dynCfg, HPF_Q_DB, type FxChain } from './fx';
import { FX_WORKLET_NAME, FX_WORKLET_SRC } from './fxWorklet';

/** Load the dynamics worklet into an AudioContext. false = this WebView cannot (the plain compressor nodes are used instead). */
export async function loadFxWorklet(ctx: BaseAudioContext): Promise<boolean> {
  try {
    if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') return false;
    const url = URL.createObjectURL(new Blob([FX_WORKLET_SRC], { type: 'application/javascript' }));
    try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    return true;
  } catch { return false; }
}

/**
 * One Enhanced Audio chain in the preview:
 *   input -> dry ------------------------------------------> output   (original sound)
 *   input -> highpass -> chest -> mud -> presence -> crisp -> air -> [de-esser, compressor, gain, limiter] -> wet -> output
 * Switching between the two (A/B, or the effect off) is a short fade, so there are no clicks.
 */
export class FxNode {
  readonly input: GainNode;
  readonly output: GainNode;
  private dry: GainNode;
  private wet: GainNode;
  private hp: BiquadFilterNode;
  private chest: BiquadFilterNode;
  private mud: BiquadFilterNode;
  private pres: BiquadFilterNode;
  private crisp: BiquadFilterNode;
  private air: BiquadFilterNode;
  private dynIn: GainNode;
  private dynOut: GainNode;
  private dyn: AudioWorkletNode | null = null;
  private fb: { comp: DynamicsCompressorNode; gain: GainNode; lim: DynamicsCompressorNode } | null = null;
  private last: { chain: FxChain; bypass: boolean } | null = null;

  constructor(private ctx: AudioContext) {
    this.input = ctx.createGain(); this.output = ctx.createGain();
    this.dry = ctx.createGain(); this.wet = ctx.createGain();
    this.wet.gain.value = 0;
    const bq = (type: BiquadFilterType) => { const f = ctx.createBiquadFilter(); f.type = type; return f; };
    this.hp = bq('highpass'); this.hp.Q.value = HPF_Q_DB;
    this.chest = bq('peaking'); this.mud = bq('peaking'); this.pres = bq('peaking'); this.crisp = bq('peaking'); this.air = bq('highshelf');
    this.dynIn = ctx.createGain(); this.dynOut = ctx.createGain();
    this.input.connect(this.dry); this.dry.connect(this.output);
    this.input.connect(this.hp);
    this.hp.connect(this.chest); this.chest.connect(this.mud); this.mud.connect(this.pres); this.pres.connect(this.crisp); this.crisp.connect(this.air); this.air.connect(this.dynIn);
    this.dynIn.connect(this.dynOut); // until the worklet is ready
    this.dynOut.connect(this.wet); this.wet.connect(this.output);
  }

  /** Put the dynamics stage in place once we know if the worklet loaded. */
  attachDyn(workletOk: boolean): void {
    const ctx = this.ctx;
    try { this.dynIn.disconnect(this.dynOut); } catch { /* not connected */ }
    if (workletOk) {
      try {
        this.dyn = new AudioWorkletNode(ctx, FX_WORKLET_NAME, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
        this.dynIn.connect(this.dyn); this.dyn.connect(this.dynOut);
      } catch { this.dyn = null; }
    }
    if (!this.dyn) {
      // fallback: the browser's own compressor + a hard limiter (close, not identical)
      const comp = ctx.createDynamicsCompressor(), gain = ctx.createGain(), lim = ctx.createDynamicsCompressor();
      lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.05;
      this.dynIn.connect(comp); comp.connect(gain); gain.connect(lim); lim.connect(this.dynOut);
      this.fb = { comp, gain, lim };
    }
    if (this.last) this.update(this.last.chain, this.last.bypass);
  }

  /** Push the settings. bypass = hear the original (A/B, preview only). */
  update(chain: FxChain, bypass: boolean): void {
    this.last = { chain, bypass };
    const t = this.ctx.currentTime, ramp = 0.015;
    const on = chain.on && !bypass;
    this.dry.gain.setTargetAtTime(on ? 0 : 1, t, 0.01);
    this.wet.gain.setTargetAtTime(on ? 1 : 0, t, 0.01);
    this.hp.frequency.setTargetAtTime(chain.hpf.on ? chain.hpf.f : 1, t, ramp);
    const peak = (n: BiquadFilterNode, b: { f: number; g: number; q: number }) => {
      n.frequency.setTargetAtTime(b.f, t, ramp); n.gain.setTargetAtTime(b.g, t, ramp); n.Q.setTargetAtTime(b.q, t, ramp);
    };
    peak(this.chest, chain.chest); peak(this.mud, chain.mud); peak(this.pres, chain.presence); peak(this.crisp, chain.crisp);
    this.air.frequency.setTargetAtTime(chain.air.f, t, ramp); this.air.gain.setTargetAtTime(chain.air.g, t, ramp);
    const d = dynCfg(chain);
    if (this.dyn) this.dyn.port.postMessage(d);
    if (this.fb) {
      this.fb.comp.threshold.value = d.thr; this.fb.comp.ratio.value = d.compOn ? Math.max(1, d.ratio) : 1;
      this.fb.comp.attack.value = d.attack / 1000; this.fb.comp.release.value = d.release / 1000;
      this.fb.gain.gain.value = Math.pow(10, ((d.compOn ? d.makeup : 0) + d.outGain) / 20);
      this.fb.lim.threshold.value = d.ceiling;
    }
  }
}
