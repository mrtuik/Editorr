import type { Settings } from '../core/types';
import { saveSettings } from '../core/store';
import { bezier, type ZoomShape } from '../core/autocut';
import { h, icon } from '../ui';
import { chips } from './faceOptions';

const PRESETS: { name: string; e: number[] }[] = [
  { name: 'Linear', e: [0, 0, 1, 1] },
  { name: 'Smooth', e: [0.42, 0, 0.58, 1] },
  { name: 'Ease in', e: [0.42, 0, 1, 1] },
  { name: 'Ease out', e: [0, 0, 0.58, 1] },
  { name: 'Punch', e: [0.16, 1, 0.3, 1] },
  { name: 'Snap', e: [0.8, 0, 0.2, 1] },
  { name: 'Bounce', e: [0.34, 1.56, 0.64, 1] },
];
const Y0 = -0.5, Y1 = 1.5;

function slider(label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, onInput: (v: number) => void): HTMLElement {
  const val = h('b', {}, fmt(value));
  const r = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), class: 'at-range', 'aria-label': label }) as HTMLInputElement;
  r.addEventListener('input', () => { const v = Number(r.value); val.textContent = fmt(v); onInput(v); });
  return h('div', { class: 'at-sec' }, h('div', { class: 'at-label-row' }, h('div', { class: 'at-label' }, label), val), r);
}

/** Auto zoom: amount, speed in / out, hold, and a graph editor for the easing curve. Resolves with the shape, or null when closed. */
export function zoomShapeFrom(s: Settings): ZoomShape {
  return {
    amount: s.zoomAmount ?? 1.15, inMs: s.zoomInMs ?? 300, holdMs: s.zoomHoldMs ?? 1200, outMs: s.zoomOutMs ?? 300,
    ease: s.zoomEase && s.zoomEase.length === 4 ? [...s.zoomEase] : [0.42, 0, 0.58, 1],
  };
}

export function askAutoZoom(s: Settings, o: { title?: string; hint?: string; cta?: string } = {}): Promise<ZoomShape | null> {
  const save = () => { void saveSettings(s); };
  s.zoomEase = s.zoomEase && s.zoomEase.length === 4 ? s.zoomEase : [0.42, 0, 0.58, 1];
  return new Promise((resolve) => {
    const done = (v: ZoomShape | null) => { sheet.classList.add('out'); setTimeout(() => { box.remove(); resolve(v); }, 180); };
    const cv = h('canvas', { class: 'zg-cv', width: '520', height: '360' }) as HTMLCanvasElement;
    const presetRow = h('div', { class: 'schips' });
    const W = 520, H = 360, PAD = 28;
    const px = (x: number) => PAD + x * (W - PAD * 2);
    const py = (y: number) => H - PAD - ((y - Y0) / (Y1 - Y0)) * (H - PAD * 2);
    const unx = (X: number) => Math.max(0, Math.min(1, (X - PAD) / (W - PAD * 2)));
    const uny = (Y: number) => Math.max(Y0, Math.min(Y1, Y0 + ((H - PAD - Y) / (H - PAD * 2)) * (Y1 - Y0)));
    const draw = () => {
      const g = cv.getContext('2d')!;
      const e = s.zoomEase!;
      g.clearRect(0, 0, W, H);
      g.fillStyle = '#141416'; g.fillRect(0, 0, W, H);
      g.strokeStyle = '#2a2a2c'; g.lineWidth = 1;
      for (const y of [0, 1]) { g.beginPath(); g.moveTo(px(0), py(y)); g.lineTo(px(1), py(y)); g.stroke(); }
      for (const x of [0, 1]) { g.beginPath(); g.moveTo(px(x), py(Y0)); g.lineTo(px(x), py(Y1)); g.stroke(); }
      g.strokeStyle = '#3a3a3c'; g.setLineDash([6, 6]); g.beginPath(); g.moveTo(px(0), py(0)); g.lineTo(px(1), py(1)); g.stroke(); g.setLineDash([]);
      g.strokeStyle = '#8a8a8c'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(px(0), py(0)); g.lineTo(px(e[0]), py(e[1])); g.moveTo(px(1), py(1)); g.lineTo(px(e[2]), py(e[3])); g.stroke();
      g.strokeStyle = '#C6F277'; g.lineWidth = 4; g.beginPath();
      for (let i = 0; i <= 60; i++) { const u = i / 60, v = bezier(e, u); if (i === 0) g.moveTo(px(u), py(v)); else g.lineTo(px(u), py(v)); }
      g.stroke();
      g.fillStyle = '#fff';
      for (const [x, y] of [[e[0], e[1]], [e[2], e[3]]]) { g.beginPath(); g.arc(px(x), py(y), 12, 0, 6.3); g.fill(); }
      g.fillStyle = '#8a8a8c'; g.font = '20px Roboto, sans-serif'; g.fillText('time', W - 64, H - 6); g.fillText('zoom', 6, 22);
    };
    const drawPresets = () => {
      const e = s.zoomEase!;
      presetRow.replaceChildren(...PRESETS.map((p) => h('button', {
        class: 'chip' + (p.e.every((v, i) => Math.abs(v - e[i]) < 0.001) ? ' on' : ''),
        onclick: () => { s.zoomEase = [...p.e]; save(); draw(); drawPresets(); },
      }, p.name)));
    };
    let drag = -1;
    const pos = (ev: PointerEvent) => { const r = cv.getBoundingClientRect(); return { X: ((ev.clientX - r.left) / r.width) * W, Y: ((ev.clientY - r.top) / r.height) * H }; };
    cv.addEventListener('pointerdown', (ev) => {
      const { X, Y } = pos(ev), e = s.zoomEase!;
      const d0 = Math.hypot(X - px(e[0]), Y - py(e[1])), d1 = Math.hypot(X - px(e[2]), Y - py(e[3]));
      drag = Math.min(d0, d1) < 60 ? (d0 <= d1 ? 0 : 1) : -1;
      if (drag >= 0) cv.setPointerCapture(ev.pointerId);
    });
    cv.addEventListener('pointermove', (ev) => {
      if (drag < 0) return;
      const { X, Y } = pos(ev), e = s.zoomEase!;
      e[drag * 2] = Math.round(unx(X) * 100) / 100; e[drag * 2 + 1] = Math.round(uny(Y) * 100) / 100;
      draw();
    });
    const end = () => { if (drag >= 0) { drag = -1; save(); drawPresets(); } };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);

    const ms = (v: number) => `${(v / 1000).toFixed(2)} s`;
    const strengthRow = chips<'soft' | 'medium' | 'strong'>('Amount', 'How far it zooms in. Drag the slider for an exact value.',
      [['soft', 'Soft'], ['medium', 'Medium'], ['strong', 'Strong']], s.zoomStrength ?? 'medium', (v) => { s.zoomStrength = v; s.zoomAmount = v === 'soft' ? 1.08 : v === 'strong' ? 1.25 : 1.15; save(); });
    const sheet = h('div', { class: 'at-sheet', role: 'dialog' },
      h('div', { class: 'at-handle' }),
      h('div', { class: 'at-head' }, h('button', { class: 'at-back', 'aria-label': 'Close', onclick: () => done(null) }, icon('back', 20)), h('div', { class: 'at-title' }, o.title ?? 'Auto zoom'), h('span', { class: 'at-head-gap' })),
      h('div', { class: 'at-body' },
        h('div', { class: 'at-hint' }, o.hint ?? 'A zoom-in on loud, strong moments (big words, laughs), on the person who is on screen.'),
        strengthRow,
        slider('Zoom amount', 1.03, 1.5, 0.01, s.zoomAmount ?? 1.15, (v) => `${Math.round((v - 1) * 100)}%`, (v) => { s.zoomAmount = v; save(); }),
        slider('Zoom in time', 100, 1000, 50, s.zoomInMs ?? 300, ms, (v) => { s.zoomInMs = v; save(); }),
        slider('Hold', 0, 3000, 100, s.zoomHoldMs ?? 1200, ms, (v) => { s.zoomHoldMs = v; save(); }),
        slider('Zoom out time', 100, 1000, 50, s.zoomOutMs ?? 300, ms, (v) => { s.zoomOutMs = v; save(); }),
        h('div', { class: 'at-sec' }, h('div', { class: 'at-label' }, 'Graph'),
          h('div', { class: 'at-hint' }, 'Drag the two white points. Up = faster zoom, flat = slow start. Above the top line makes a small bounce. Zoom out uses the same curve backwards.'),
          cv, presetRow)),
      h('div', { class: 'at-foot' }, h('button', { class: 'btn primary at-go', onclick: () => done({
        amount: s.zoomAmount ?? 1.15, inMs: s.zoomInMs ?? 300, holdMs: s.zoomHoldMs ?? 1200, outMs: s.zoomOutMs ?? 300, ease: [...(s.zoomEase as number[])],
      }) }, icon('wand', 20), o.cta ?? 'Apply')));
    const box = h('div', { class: 'at-scrim', onclick: (e: Event) => { if (e.target === box) done(null); } }, sheet);
    document.body.append(box);
    draw(); drawPresets();
  });
}
