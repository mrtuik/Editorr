#!/usr/bin/env node
/**
 * Ports motion DATA (keyframes, duration, easing) from open-motion (MIT, see THIRD_PARTY.md) into
 * src/core/visuals/motionPresets.json. Nothing of the web app, server, agent or DB is copied.
 *
 * usage: node scripts/port-open-motion.mjs <path to open-motion-main>
 *
 * Open-motion templates are demo scenes (several elements, px/% units, big loops), so each template is reduced to ONE
 * component and fitted to a whole card: px -> share of the short side (720 px reference), % -> half of that share,
 * entrance <= 900 ms, exit <= 600 ms, hold loops damped so the card only breathes.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
if (!root) { console.error('usage: node scripts/port-open-motion.mjs <open-motion-main dir>'); process.exit(1); }
const dir = path.join(root, 'open-motion/src/motion/templates');
if (!fs.existsSync(dir)) { console.error('templates folder not found: ' + dir); process.exit(1); }

/** our id -> [open-motion file, group, component index or -1 = best scoring] */
const MAP = {
  fade: ['fade', 'entrance', -1], slideUp: ['slide', 'entrance', 0], scaleIn: ['scale', 'entrance', -1],
  elasticScale: ['elasticScale', 'entrance', -1], blurReveal: ['blurReveal', 'entrance', 0], reveal3d: ['reveal3d', 'entrance', -1],
  curtainRise: ['curtainRise', 'entrance', 1], kineticText: ['kineticText', 'entrance', 0], textReveal: ['textReveal', 'entrance', 1],
  wipe: ['pageTransition', 'entrance', 1],
  float: ['float', 'emphasis', 0], pulse: ['pulse', 'emphasis', -1], heartbeat: ['heartbeat', 'emphasis', 0],
  breathingLight: ['breathingLight', 'emphasis', 0], shimmer: ['shimmer', 'emphasis', 0], neonPulse: ['neonPulse', 'emphasis', 0],
  fadeOut: ['fadeOut', 'exit', -1], slideOut: ['slideOut', 'exit', -1], slideUpExit: ['slideUpExit', 'exit', -1],
  sinkExit: ['sinkExit', 'exit', -1], collapseDown: ['collapseDown', 'exit', -1], zoomOut: ['zoomOut', 'exit', -1],
  dissolve: ['dissolveOut', 'exit', -1],
};
// open-motion preset names are kept as they are: src/core/visuals/ease.ts evaluates the same cubic-bezier table
const EASE = Object.fromEntries(['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'ease-in-quad', 'ease-out-quad', 'ease-in-out-quad',
  'ease-in-cubic', 'ease-out-cubic', 'ease-in-out-cubic', 'bounce', 'back', 'elastic', 'snappy', 'smooth', 'soft'].map((k) => [k, k]));
const REF = 720, r3 = (n) => Math.round(n * 1000) / 1000, clamp = (n, a, b) => Math.max(a, Math.min(b, n));

function parseVal(v) {
  const m = /^\s*"?(-?[\d.]+)(px|%|deg)?"?\s*$/.exec(v); if (!m) return null;
  return { n: parseFloat(m[1]), u: m[2] || '' };
}
function parseComponents(src) {
  const parts = src.split(/\bdraft\(/).slice(1);
  return parts.map((t) => {
    const num = (k, d) => { const m = new RegExp(k + ':\\s*([\\d.]+)').exec(t); return m ? parseFloat(m[1]) : d; };
    const str = (k, d) => { const m = new RegExp(k + ':\\s*"?(\\w+)"?').exec(t); return m ? m[1] : d; };
    const easing = (/easingPreset\("([^"]+)"\)/.exec(t) || [])[1] || 'ease-out';
    const kfs = [...t.matchAll(/kf\(\s*([\d.]+)\s*,\s*\{([^}]*)\}\s*\)/g)].map((m) => {
      const props = {};
      for (const p of m[2].split(',')) {
        const kv = /^\s*(\w+)\s*:\s*(.+?)\s*$/.exec(p); if (!kv) continue;
        const val = parseVal(kv[2]); if (val) props[kv[1]] = val;
      }
      return { offset: parseFloat(m[1]), props };
    });
    return { durationMs: num('durationMs', 800), delayMs: num('delayMs', 0), easing, iter: str('iterationCount', '1'), dir: str('direction', 'normal'), kfs };
  });
}
const KEYS = ['opacity', 'translateX', 'translateY', 'scale', 'scaleY', 'blur', 'rotate', 'rotateY', 'rotateX'];
const score = (c) => c.durationMs > 0 ? c.kfs.reduce((s, k) => s + Object.keys(k.props).filter((p) => KEYS.includes(p)).length, 0) : -1;

/** one open-motion keyframe -> our props (share of short side, scale, degrees, opacity, blur share) */
function conv(props, cap) {
  const o = {};
  const len = (p) => p.u === '%' ? (p.n / 100) * 0.5 : p.n / REF;
  if (props.translateX) o.x = clamp(len(props.translateX), -cap, cap);
  if (props.translateY) o.y = clamp(len(props.translateY), -cap, cap);
  if (props.scale) o.s = props.scale.n; else if (props.scaleY) o.s = props.scaleY.n;
  if (props.rotate) o.r = clamp(props.rotate.n, -15, 15);
  if (props.rotateY || props.rotateX) o.r = clamp(((props.rotateY || props.rotateX).n) * 0.04, -4, 4);
  if (props.opacity) o.o = clamp(props.opacity.n, 0, 1);
  if (props.blur) o.b = clamp(props.blur.n / REF, 0, 0.03);
  if (o.s !== undefined) o.s = clamp(o.s, 0.3, 1.3);
  return o;
}
const NEUTRAL = { x: 0, y: 0, s: 1, r: 0, o: 1, b: 0 };

const out = [];
for (const [id, [file, group, idx]] of Object.entries(MAP)) {
  const f = path.join(dir, file + '.ts');
  if (!fs.existsSync(f)) { console.warn('missing template: ' + file); continue; }
  const comps = parseComponents(fs.readFileSync(f, 'utf8'));
  let c = idx >= 0 ? comps[idx] : null;
  if (!c || !c.kfs.length || score(c) < 0) c = [...comps].sort((a, b) => score(b) - score(a))[0];
  if (!c || !c.kfs.length) { console.warn('no keyframes: ' + file); continue; }
  const hold = group === 'emphasis';
  let kfs = c.kfs.map((k) => ({ offset: k.offset, properties: conv(k.props, hold ? 0.008 : group === 'exit' ? 0.1 : 0.14) }));
  let durationMs = c.durationMs;
  if (hold) {
    // loop: alternate -> out and back; then damp so the card only breathes, and make last == first
    if (c.dir === 'alternate' && kfs.at(-1) && JSON.stringify(kfs[0].properties) !== JSON.stringify(kfs.at(-1).properties)) {
      const m = kfs.slice(0, -1).reverse().map((k) => ({ offset: 1 - k.offset, properties: k.properties }));
      kfs = [...kfs.map((k) => ({ offset: k.offset / 2, properties: k.properties })), ...m.map((k) => ({ offset: 0.5 + k.offset / 2, properties: k.properties }))];
    }
    const base = { ...NEUTRAL, ...kfs[0].properties };
    let maxS = 0, maxO = 0;
    for (const k of kfs) { maxS = Math.max(maxS, Math.abs((k.properties.s ?? 1) - base.s)); maxO = Math.max(maxO, Math.abs((k.properties.o ?? 1) - base.o)); }
    const ks = maxS > 0 ? Math.min(1, 0.03 / maxS) : 1, ko = maxO > 0 ? Math.min(1, 0.06 / maxO) : 1;
    kfs = kfs.map((k, i) => {
      const p = {}, q = k.properties;
      if (q.s !== undefined) p.s = r3(1 + (q.s - base.s) * ks);
      if (q.o !== undefined) p.o = r3(1 - Math.abs(q.o - base.o) * ko);
      if (q.x !== undefined) p.x = r3(q.x - (kfs[0].properties.x ?? 0));
      if (q.y !== undefined) p.y = r3(q.y - (kfs[0].properties.y ?? 0));
      return { offset: k.offset, properties: p };
    });
    const first = kfs[0].properties; kfs[kfs.length - 1] = { offset: 1, properties: { ...first } };
    // a gleam that only moves a highlight (shimmer) has no card motion left: give it a tiny sway so it is not dead
    if (kfs.every((k) => Object.values(k.properties).every((v) => v === 0 || v === 1))) { kfs = [{ offset: 0, properties: { x: 0 } }, { offset: 0.5, properties: { x: 0.003 } }, { offset: 1, properties: { x: 0 } }]; }
    durationMs = clamp(durationMs, 1100, 4000);
  } else if (group === 'entrance') {
    durationMs = Math.min(durationMs, 900);
    kfs[kfs.length - 1] = { offset: 1, properties: { ...NEUTRAL, ...Object.fromEntries(Object.keys(kfs.at(-1).properties).map((k) => [k, NEUTRAL[k]])) } };
  } else {
    durationMs = Math.min(durationMs, 600);
    kfs[0] = { offset: 0, properties: Object.fromEntries(Object.keys(kfs[0].properties).map((k) => [k, NEUTRAL[k]])) };
    for (const k of kfs) if (k.properties.s !== undefined) k.properties.s = clamp(k.properties.s, 0.5, 1.3);
    kfs.at(-1).properties.o = 0;
  }
  kfs = kfs.map((k) => ({ offset: r3(k.offset), properties: Object.fromEntries(Object.entries(k.properties).map(([a, b]) => [a, r3(b)])) }));
  out.push({ id, group, durationMs: Math.round(durationMs), delayMs: 0, easing: EASE[c.easing] ?? 'out', keyframes: kfs, source: `open-motion/${file}` });
}
const dest = path.join(path.dirname(new URL(import.meta.url).pathname), '../src/core/visuals/motionPresets.json');
fs.writeFileSync(dest, JSON.stringify(out, null, 1) + '\n');
console.log(`ported ${out.length}/${Object.keys(MAP).length} presets -> ${path.relative(process.cwd(), dest)}`);
