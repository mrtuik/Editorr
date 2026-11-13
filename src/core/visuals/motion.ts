/**
 * Motion presets in the open-motion data shape (keyframes [{offset, properties}], durationMs, delayMs, easing).
 * motionPresets.json holds the real keyframes ported from open-motion (MIT, see THIRD_PARTY.md) by
 * scripts/port-open-motion.mjs. The hand-written list below only fills ids open-motion has no single template for
 * (slideDown/Left/Right, slowFade, none); a ported id always wins.
 */
import PORTED from './motionPresets.json';
import { easeFn } from './ease';
import { pickText } from './textAnim';
import type { EaseName, MotionPreset, MotionProps, MotionSelection, VisualTheme } from './types';

export { easeFn };
const EASE = { get: (n: EaseName) => easeFn(n) };

const NEUTRAL: MotionProps = { x: 0, y: 0, s: 1, r: 0, o: 1, b: 0 };
type P = Partial<MotionProps>;
const mk = (id: string, group: MotionPreset['group'], durationMs: number, easing: EaseName, from: P, to: P, mid?: P, delayMs = 0): MotionPreset => ({
  id, group, durationMs, delayMs, easing,
  keyframes: [{ offset: 0, properties: from }, ...(mid ? [{ offset: 0.5, properties: mid }] : []), { offset: 1, properties: to }],
});

const HAND: MotionPreset[] = [
  // entrance
  mk('fade', 'entrance', 380, 'out', { o: 0 }, { o: 1 }),
  mk('slideUp', 'entrance', 460, 'out', { o: 0, y: 0.06 }, { o: 1, y: 0 }),
  mk('slideDown', 'entrance', 460, 'out', { o: 0, y: -0.06 }, { o: 1, y: 0 }),
  mk('slideLeft', 'entrance', 460, 'out', { o: 0, x: 0.08 }, { o: 1, x: 0 }),
  mk('slideRight', 'entrance', 460, 'out', { o: 0, x: -0.08 }, { o: 1, x: 0 }),
  mk('scaleIn', 'entrance', 420, 'out', { o: 0, s: 0.9 }, { o: 1, s: 1 }),
  mk('elasticScale', 'entrance', 640, 'elastic', { o: 0, s: 0.6 }, { o: 1, s: 1 }),
  mk('blurReveal', 'entrance', 560, 'out', { o: 0, b: 0.012 }, { o: 1, b: 0 }),
  mk('reveal3d', 'entrance', 560, 'out', { o: 0, s: 0.92, r: -3, y: 0.03 }, { o: 1, s: 1, r: 0, y: 0 }),
  mk('curtainRise', 'entrance', 600, 'expo', { o: 0, y: 0.14 }, { o: 1, y: 0 }),
  mk('kineticText', 'entrance', 420, 'back', { o: 0, s: 1.25, b: 0.008 }, { o: 1, s: 1, b: 0 }),
  mk('textReveal', 'entrance', 520, 'out', { o: 0, y: 0.025, b: 0.004 }, { o: 1, y: 0, b: 0 }),
  mk('wipe', 'entrance', 420, 'inOut', { o: 0, x: -0.12 }, { o: 1, x: 0 }),
  mk('slowFade', 'entrance', 700, 'inOut', { o: 0 }, { o: 1 }),
  // hold (small, loops by modulo)
  mk('none', 'emphasis', 1000, 'linear', {}, {}),
  mk('float', 'emphasis', 2400, 'inOut', { y: 0 }, { y: 0 }, { y: -0.006 }),
  mk('pulse', 'emphasis', 1400, 'inOut', { s: 1 }, { s: 1 }, { s: 1.015 }),
  mk('heartbeat', 'emphasis', 1100, 'out', { s: 1 }, { s: 1 }, { s: 1.025 }),
  mk('breathingLight', 'emphasis', 2600, 'inOut', { o: 1 }, { o: 1 }, { o: 0.94 }),
  mk('shimmer', 'emphasis', 1800, 'inOut', { x: 0 }, { x: 0 }, { x: 0.003 }),
  mk('neonPulse', 'emphasis', 1200, 'inOut', { s: 1, o: 1 }, { s: 1, o: 1 }, { s: 1.01, o: 0.95 }),
  // exit
  mk('fadeOut', 'exit', 260, 'out', { o: 1 }, { o: 0 }),
  mk('slideOut', 'exit', 300, 'inOut', { o: 1, x: 0 }, { o: 0, x: 0.08 }),
  mk('slideUpExit', 'exit', 300, 'inOut', { o: 1, y: 0 }, { o: 0, y: -0.06 }),
  mk('sinkExit', 'exit', 320, 'inOut', { o: 1, y: 0, s: 1 }, { o: 0, y: 0.05, s: 0.96 }),
  mk('collapseDown', 'exit', 300, 'inOut', { o: 1, s: 1, y: 0 }, { o: 0, s: 0.85, y: 0.04 }),
  mk('zoomOut', 'exit', 320, 'inOut', { o: 1, s: 1 }, { o: 0, s: 1.12 }),
  mk('dissolve', 'exit', 360, 'linear', { o: 1, b: 0 }, { o: 0, b: 0.01 }),
];

const ported = (PORTED as unknown as (MotionPreset & { source?: string })[]).map(({ source: _s, ...p }) => p as MotionPreset);
const portedIds = new Set(ported.map(p => p.id));
export const MOTION_PRESETS: MotionPreset[] = [...ported, ...HAND.filter(p => !portedIds.has(p.id))];
const BY_ID = new Map(MOTION_PRESETS.map(p => [p.id, p]));
export const motionIds = (group?: MotionPreset['group']) => MOTION_PRESETS.filter(p => !group || p.group === group).map(p => p.id);
export const getPreset = (id: string): MotionPreset => BY_ID.get(id) ?? BY_ID.get('fade')!;

/** Props of a preset at `tMs` after its own start (delay included). Clamped: before = first keyframe, after = last. */
export function sampleMotion(m: MotionPreset, tMs: number): MotionProps {
  const raw = (tMs - m.delayMs) / m.durationMs;
  const u = EASE.get(m.easing)(Math.max(0, Math.min(1, raw)));
  const kf = m.keyframes;
  let a = kf[0], b = kf[kf.length - 1];
  for (let i = 0; i < kf.length - 1; i++) if (u >= kf[i].offset && u <= kf[i + 1].offset) { a = kf[i]; b = kf[i + 1]; break; }
  const span = Math.max(1e-6, b.offset - a.offset), k = a === b ? 1 : (u - a.offset) / span;
  const out = { ...NEUTRAL };
  for (const key of Object.keys(NEUTRAL) as (keyof MotionProps)[]) {
    const va = a.properties[key] ?? kf[0].properties[key] ?? NEUTRAL[key];
    const vb = b.properties[key] ?? kf[kf.length - 1].properties[key] ?? NEUTRAL[key];
    out[key] = va + (vb - va) * k;
  }
  return out;
}

/** Whole-card props at `t` ms into a visual that lasts `durMs`: entrance, then the hold loop, then the exit at the end. */
export function visualMotionAt(sel: MotionSelection, t: number, durMs: number): MotionProps {
  const mi = getPreset(sel.in), mh = getPreset(sel.hold), mo = getPreset(sel.out);
  const outStart = Math.max(mi.durationMs, durMs - mo.durationMs);
  if (t >= outStart) return sampleMotion(mo, t - outStart);
  if (t < mi.durationMs + mi.delayMs) return sampleMotion(mi, t);
  const loop = ((t - mi.durationMs) % mh.durationMs) / mh.durationMs;
  // a hold preset runs from -> mid -> to (from == to), so the loop never jumps
  return sampleMotion({ ...mh, easing: 'linear', delayMs: 0, durationMs: 1000 }, loop * 1000);
}

/** 0..1 progress for the things inside a template (count-up, bars growing, typing). Settles a little after the entrance. */
export function innerProgress(sel: MotionSelection, t: number): number {
  const span = Math.max(800, getPreset(sel.in).durationMs + 450);
  return Math.max(0, Math.min(1, t / span));
}

export const motionCss = (m: MotionProps, short: number) =>
  `opacity:${m.o.toFixed(3)};transform:translate(${(m.x * short).toFixed(1)}px,${(m.y * short).toFixed(1)}px) scale(${m.s.toFixed(4)}) rotate(${m.r.toFixed(2)}deg);` +
  (m.b > 0.0005 ? `filter:blur(${(m.b * short).toFixed(1)}px);` : '');

/** Pick in/hold/out from a theme's lists. `index` rotates; the entrance never repeats the previous visual's. */
export function pickMotion(theme: VisualTheme, index: number, prevIn?: string, prevText?: string): MotionSelection {
  const ins = theme.motionSet.in;
  let inn = ins[index % ins.length];
  if (inn === prevIn && ins.length > 1) inn = ins[(index + 1) % ins.length];
  const hs = theme.motionSet.hold, os = theme.motionSet.out;
  return { in: inn, hold: hs[index % hs.length], out: os[index % os.length], text: pickText(theme.motionSet.text, index, prevText) };
}
