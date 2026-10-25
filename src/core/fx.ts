/**
 * Enhanced Audio: 5-band parametric EQ + de-esser + compressor + limiter.
 *
 * ONE definition of the sound, used three times so preview and export match:
 *  - preview: Web Audio BiquadFilterNodes (EQ) + an AudioWorklet (dynamics), see fxGraph.ts
 *  - export:  the same biquad formulas + the same dynamics maths in Java (FxProcessor in EditorrNativePlugin.java)
 *  - graph:   the same biquad formulas draw the response curve (fxSheet.ts)
 */
import type { Project, Role } from './types';

export type FxTarget = 'host' | 'constant' | 'master';
export const FX_TARGETS: [FxTarget, string][] = [['host', 'Host'], ['constant', 'Guest'], ['master', 'Master']];

export interface FxBand { f: number; g: number; q: number }
export interface FxChain {
  /** Saved on/off. The A/B "original" button in the sheet is preview-only and is never exported. */
  on: boolean;
  /** Band 1: low-cut (high-pass, 12 dB/oct). */
  hpf: { on: boolean; f: number };
  /** Band 2: warmth / mud (peaking). */
  mud: FxBand;
  /** Band 3: presence / speech (peaking). */
  presence: FxBand;
  /** Band 4: crispness (peaking). */
  crisp: FxBand;
  /** Band 5: air (high-shelf). */
  air: { f: number; g: number };
  /** Compressor: threshold dB, ratio x:1, attack ms, release ms, makeup dB. */
  comp: { on: boolean; thr: number; ratio: number; attack: number; release: number; makeup: number };
  /** De-esser: amount 0..100 (how hard sharp S / SH is pulled down), centre frequency Hz. */
  deess: { on: boolean; amount: number; f: number };
  /** Output gain dB and brickwall limiter ceiling dBFS. */
  out: { gain: number; ceiling: number };
  /** Name of the preset this started from (label only). */
  preset?: string;
}
export interface FxState { host: FxChain; constant: FxChain; master: FxChain }

/** Slider / drag limits, shared by the UI. */
export const FX_RANGE = {
  hpf: { f: [50, 120] }, mud: { f: [150, 500], g: [-12, 12], q: [0.3, 4] },
  presence: { f: [1000, 4000], g: [-12, 12], q: [0.3, 4] }, crisp: { f: [4000, 8000], g: [-12, 12], q: [0.3, 4] },
  air: { f: [8000, 16000], g: [-12, 12] },
} as const;

/** Web Audio high-pass "Q" is in dB. -3.0103 dB = Q 0.7071 (Butterworth), the same as the Java side and FFmpeg. */
export const HPF_Q_DB = 20 * Math.log10(Math.SQRT1_2);

export function defaultChain(): FxChain {
  return {
    on: false,
    hpf: { on: false, f: 80 },
    mud: { f: 320, g: 0, q: 1.4 },
    presence: { f: 2800, g: 0, q: 1 },
    crisp: { f: 5500, g: 0, q: 1.2 },
    air: { f: 10000, g: 0 },
    comp: { on: false, thr: -18, ratio: 3, attack: 10, release: 120, makeup: 0 },
    deess: { on: false, amount: 30, f: 6500 },
    out: { gain: 0, ceiling: -1 },
  };
}
export const cloneChain = (c: FxChain): FxChain => JSON.parse(JSON.stringify(c));

/** Preset shape without on/preset, written compactly. */
type P = [hpf: number, mud: [number, number, number], pres: [number, number, number], crisp: [number, number, number], air: [number, number],
  comp: [number, number, number, number, number] | null, deess: number | null];
function build(name: string, a: P): FxChain {
  const c = defaultChain();
  c.on = true; c.preset = name;
  c.hpf = { on: true, f: a[0] };
  c.mud = { f: a[1][0], g: a[1][1], q: a[1][2] };
  c.presence = { f: a[2][0], g: a[2][1], q: a[2][2] };
  c.crisp = { f: a[3][0], g: a[3][1], q: a[3][2] };
  c.air = { f: a[4][0], g: a[4][1] };
  if (a[5]) c.comp = { on: true, thr: a[5][0], ratio: a[5][1], attack: a[5][2], release: a[5][3], makeup: a[5][4] };
  if (a[6] != null) c.deess = { on: true, amount: a[6], f: 6500 };
  return c;
}

export const BUILT_IN: { name: string; hint: string; chain: FxChain }[] = [
  { name: 'Cinematic Studio', hint: 'Deep and crisp, like a film voice-over', chain: build('Cinematic Studio', [80, [320, -3.5, 1.4], [2800, 2.5, 1], [5000, 1.5, 1.2], [10000, 3], [-18, 3, 10, 120, 2], 30]) },
  { name: 'Warm Podcast', hint: 'Warm low end, gentle levelling', chain: build('Warm Podcast', [70, [180, 2, 0.8], [2500, 1, 0.9], [5500, 0.5, 1], [9000, 1], [-20, 2.5, 15, 150, 1], 20]) },
  { name: 'Crisp & Clear', hint: 'Sharp dialogue, great for phone mics', chain: build('Crisp & Clear', [100, [300, -4, 1.4], [3200, 3.5, 1.1], [6000, 2.5, 1.2], [12000, 3], [-22, 3.5, 5, 90, 3], 45]) },
  { name: 'Radio Broadcast', hint: 'Deep lows, tight dynamics, controlled highs', chain: build('Radio Broadcast', [60, [180, 3, 0.9], [2500, 2, 1], [5000, -1, 1.2], [10000, 1.5], [-24, 5, 8, 100, 4], 35]) },
  { name: 'Clean & Intimate', hint: 'Close, soft and natural', chain: build('Clean & Intimate', [90, [350, -2.5, 1.2], [2000, 1, 0.8], [5000, 0.5, 1], [11000, 2], [-16, 2, 15, 150, 1], 25]) },
];

// ---------------------------------------------------------------- your own presets (saved on this phone)
const KEY = 'editorr.fxPresets';
export interface CustomPreset { name: string; chain: FxChain }
export function loadCustom(): CustomPreset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((x) => x && typeof x.name === 'string' && x.chain).map((x) => ({ name: x.name, chain: mergeChain(x.chain) })) : [];
  } catch { return []; }
}
export function saveCustom(list: CustomPreset[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage full or blocked: presets just are not kept */ }
}

/** Fill anything missing (older projects, hand-edited presets) from the defaults. */
export function mergeChain(src: Partial<FxChain> | undefined): FxChain {
  const d = defaultChain();
  if (!src) return d;
  return {
    on: !!src.on, preset: src.preset,
    hpf: { ...d.hpf, ...src.hpf }, mud: { ...d.mud, ...src.mud }, presence: { ...d.presence, ...src.presence },
    crisp: { ...d.crisp, ...src.crisp }, air: { ...d.air, ...src.air }, comp: { ...d.comp, ...src.comp },
    deess: { ...d.deess, ...src.deess }, out: { ...d.out, ...src.out },
  };
}

/** The project's Enhanced Audio settings (created on first use, old projects have none). */
export function getFx(p: Project): FxState {
  const f = p.fx;
  if (!f) { p.fx = { host: defaultChain(), constant: defaultChain(), master: defaultChain() }; return p.fx; }
  f.host = mergeChain(f.host); f.constant = mergeChain(f.constant); f.master = mergeChain(f.master);
  return f;
}
export const fxActive = (p: Project): boolean => !!p.fx && (p.fx.host?.on || p.fx.constant?.on || p.fx.master?.on);

/** Same sound? (ignores the on switch and the label) */
export function sameSound(a: FxChain, b: FxChain): boolean {
  const strip = (c: FxChain) => { const x = cloneChain(c) as Partial<FxChain>; delete x.on; delete x.preset; return JSON.stringify(x); };
  return strip(a) === strip(b);
}

// ---------------------------------------------------------------- biquad maths (RBJ cookbook = Web Audio spec)
export interface Coef { b0: number; b1: number; b2: number; a1: number; a2: number }
export type StageKind = 'highpass' | 'peaking' | 'highshelf';

export function coef(kind: StageKind, sr: number, f: number, gDb: number, q: number): Coef {
  const w0 = (2 * Math.PI * Math.min(f, sr * 0.49)) / sr, cs = Math.cos(w0), sn = Math.sin(w0);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  if (kind === 'highpass') {
    const al = sn / (2 * Math.SQRT1_2);
    b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al;
  } else if (kind === 'peaking') {
    const A = Math.pow(10, gDb / 40), al = sn / (2 * q);
    b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A;
  } else {
    // high shelf, shelf slope S = 1 (what Web Audio uses)
    const A = Math.pow(10, gDb / 40), al = (sn / 2) * Math.SQRT2, t = 2 * Math.sqrt(A) * al;
    b0 = A * ((A + 1) + (A - 1) * cs + t); b1 = -2 * A * ((A - 1) + (A + 1) * cs); b2 = A * ((A + 1) + (A - 1) * cs - t);
    a0 = (A + 1) - (A - 1) * cs + t; a1 = 2 * ((A - 1) - (A + 1) * cs); a2 = (A + 1) - (A - 1) * cs - t;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** The EQ stages of a chain that really do something. */
export function eqStages(c: FxChain): { kind: StageKind; f: number; g: number; q: number }[] {
  const s: { kind: StageKind; f: number; g: number; q: number }[] = [];
  if (c.hpf.on) s.push({ kind: 'highpass', f: c.hpf.f, g: 0, q: Math.SQRT1_2 });
  if (c.mud.g !== 0) s.push({ kind: 'peaking', ...c.mud });
  if (c.presence.g !== 0) s.push({ kind: 'peaking', ...c.presence });
  if (c.crisp.g !== 0) s.push({ kind: 'peaking', ...c.crisp });
  if (c.air.g !== 0) s.push({ kind: 'highshelf', f: c.air.f, g: c.air.g, q: 1 });
  return s;
}

/** Gain in dB of one stage at frequency hz. */
export function stageDb(k: Coef, hz: number, sr: number): number {
  const w = (2 * Math.PI * hz) / sr, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = k.b0 + k.b1 * c1 + k.b2 * c2, ni = -(k.b1 * s1 + k.b2 * s2);
  const dr = 1 + k.a1 * c1 + k.a2 * c2, di = -(k.a1 * s1 + k.a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di) + 1e-30);
}
/** Whole EQ curve (dB) at the given frequencies. */
export function eqResponse(c: FxChain, freqs: number[], sr = 48000): number[] {
  const ks = eqStages(c).map((s) => coef(s.kind, sr, s.f, s.g, s.q));
  return freqs.map((hz) => ks.reduce((a, k) => a + stageDb(k, hz, sr), 0));
}

// ---------------------------------------------------------------- dynamics settings for the worklet / Java
export interface DynCfg {
  deOn: boolean; deAmount: number; deF: number;
  compOn: boolean; thr: number; ratio: number; attack: number; release: number; makeup: number;
  outGain: number; ceiling: number;
}
export function dynCfg(c: FxChain): DynCfg {
  return {
    deOn: c.deess.on && c.deess.amount > 0, deAmount: c.deess.amount, deF: c.deess.f,
    compOn: c.comp.on, thr: c.comp.thr, ratio: c.comp.ratio, attack: c.comp.attack, release: c.comp.release, makeup: c.comp.makeup,
    outGain: c.out.gain, ceiling: c.out.ceiling,
  };
}

// ---------------------------------------------------------------- export
/** What the Android export gets: the voice chain (the mic that is the audio source) and the master chain. Off chains are left out. */
export function fxForExport(p: Project): { voice?: FxChain; master?: FxChain } | undefined {
  if (!fxActive(p)) return undefined;
  const f = getFx(p), role: Role = p.mainAudio;
  const out: { voice?: FxChain; master?: FxChain } = {};
  if (f[role].on) out.voice = f[role];
  if (f.master.on) out.master = f.master;
  return out.voice || out.master ? out : undefined;
}

const n = (v: number, d = 2) => String(Math.round(v * 10 ** d) / 10 ** d);
/**
 * The same chain as an FFmpeg -af string (reference / copy-paste for desktop tools).
 * The phone export does NOT run FFmpeg: it runs the same maths in the Media3 audio processor.
 */
export function fxToFfmpeg(c: FxChain): string {
  const f: string[] = [];
  if (c.hpf.on) f.push(`highpass=f=${n(c.hpf.f, 0)}:poles=2`);
  for (const b of [c.mud, c.presence, c.crisp]) if (b.g !== 0) f.push(`equalizer=f=${n(b.f, 0)}:t=q:w=${n(b.q)}:g=${n(b.g, 1)}`);
  if (c.air.g !== 0) f.push(`highshelf=f=${n(c.air.f, 0)}:g=${n(c.air.g, 1)}`);
  if (c.deess.on && c.deess.amount > 0) f.push(`deesser=i=${n(c.deess.amount / 100)}`);
  if (c.comp.on) f.push(`acompressor=threshold=${n(Math.pow(10, c.comp.thr / 20), 4)}:ratio=${n(c.comp.ratio)}:attack=${n(c.comp.attack, 0)}:release=${n(c.comp.release, 0)}:makeup=${n(Math.pow(10, c.comp.makeup / 20), 3)}`);
  if (c.out.gain !== 0) f.push(`volume=${n(c.out.gain, 1)}dB`);
  f.push(`alimiter=limit=${n(Math.pow(10, c.out.ceiling / 20), 4)}`);
  return f.join(',');
}
