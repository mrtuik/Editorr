import type { Range } from '../core/timeline';
import { app } from '../app';
import { h, icon, slider } from '../ui';

export interface SilenceItem { r: Range; orig: Range; on: boolean }

const clock = (ms: number) => { const t = Math.max(0, ms) / 1000, m = Math.floor(t / 60); return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`; };
const secs = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

/**
 * Review of the silences Detect found, as a bottom sheet that leaves the preview and timeline visible.
 * Each silence can be played (with a little speech before and after), switched off, or made shorter / longer
 * with Start and End sliders. Everything is written straight into `items`; `onChange` redraws the red marks.
 */
export function openSilenceSheet(o: {
  items: SilenceItem[]; durationMs: number;
  onChange: () => void; seek: (ms: number) => void; playRange: (a: number, b: number) => void; stop: () => void; onClose: () => void;
}): void {
  const { items } = o;
  let open = -1;
  const list = h('div', { class: 'ss-list' });
  const sum = h('div', { class: 'at-hint ss-sum' }, '');

  const total = () => items.filter((i) => i.on).reduce((a, i) => a + (i.r.endMs - i.r.startMs), 0);
  const paintSum = () => {
    const n = items.filter((i) => i.on).length;
    sum.textContent = `${n} of ${items.length} will be cut · ${secs(total())} removed`;
  };

  function row(it: SilenceItem, n: number): HTMLElement {
    const dur = h('span', { class: 'ss-d' }, secs(it.r.endMs - it.r.startMs));
    const when = h('span', { class: 'ss-t' }, `${clock(it.r.startMs)} – ${clock(it.r.endMs)}`);
    const upd = () => { dur.textContent = secs(it.r.endMs - it.r.startMs); when.textContent = `${clock(it.r.startMs)} – ${clock(it.r.endMs)}`; paintSum(); o.onChange(); };
    const chk = h('button', {
      class: 'ss-chk' + (it.on ? ' on' : ''), role: 'checkbox', 'aria-checked': String(it.on), 'aria-label': `Cut silence ${n + 1}`,
      onclick: () => { it.on = !it.on; o.onChange(); render(); },
    }, it.on ? icon('check', 14) : '');
    const main = h('button', {
      class: 'ss-main', onclick: () => { open = open === n ? -1 : n; o.stop(); o.seek(it.r.startMs); render(); },
    }, h('b', {}, `#${n + 1}`), when, dur);
    const play = h('button', {
      class: 'ss-play', 'aria-label': 'Play this silence with a little speech around it',
      onclick: () => o.playRange(Math.max(0, it.r.startMs - 700), Math.min(o.durationMs, it.r.endMs + 700)),
    }, icon('play', 18));
    const kids: Node[] = [h('div', { class: 'ss-top' }, chk, main, play)];
    if (open === n) {
      const prev = items[n - 1]?.r.endMs ?? 0, next = items[n + 1]?.r.startMs ?? o.durationMs;
      const sMin = Math.max(prev, it.orig.startMs - 800), sMax = it.orig.endMs - 100;
      const eMin = it.orig.startMs + 100, eMax = Math.min(next, it.orig.endMs + 800);
      kids.push(h('div', { class: 'ss-adj' },
        slider('Start', sMin, Math.max(sMin + 50, sMax), 50, it.r.startMs, (v) => `${(v / 1000).toFixed(2)} s`, (v) => {
          it.r.startMs = Math.min(v, it.r.endMs - 100); o.stop(); o.seek(it.r.startMs); upd();
        }),
        slider('End', eMin, Math.max(eMin + 50, eMax), 50, it.r.endMs, (v) => `${(v / 1000).toFixed(2)} s`, (v) => {
          it.r.endMs = Math.max(v, it.r.startMs + 100); o.stop(); o.seek(it.r.endMs); upd();
        }),
        h('div', { class: 'at-hint' }, 'Move Start later or End earlier to keep more of the pause. Move them the other way to cut more.'),
        h('button', { class: 'btn', style: 'min-height:44px;width:100%', onclick: () => { it.r.startMs = it.orig.startMs; it.r.endMs = it.orig.endMs; o.onChange(); render(); } }, 'Reset this one')));
    }
    return h('div', { class: 'ss-item' + (it.on ? '' : ' off') + (open === n ? ' open' : '') }, ...kids);
  }

  function render() {
    list.replaceChildren(...(items.length ? items.map(row) : [h('div', { class: 'at-hint' }, 'No silence found.')]));
    paintSum();
  }

  const setAll = (on: boolean) => { items.forEach((i) => { i.on = on; }); o.onChange(); render(); };
  const prevBack = app.onBack;
  const close = () => { o.stop(); app.onBack = prevBack; sheet.classList.add('out'); setTimeout(() => box.remove(), 150); o.onClose(); };
  app.onBack = () => { close(); return true; };

  const sheet = h('div', { class: 'at-sheet ss', role: 'dialog', 'aria-label': 'Review silences' },
    h('div', { class: 'at-handle' }),
    h('div', { class: 'at-head' }, h('button', { class: 'at-back', 'aria-label': 'Close', onclick: close }, icon('back', 20)), h('div', { class: 'at-title' }, 'Review silences'), h('span', { class: 'at-head-gap' })),
    h('div', { class: 'at-body' },
      sum,
      h('div', { class: 'ss-bar' },
        h('button', { class: 'btn', onclick: () => setAll(true) }, 'Select all'),
        h('button', { class: 'btn', onclick: () => setAll(false) }, 'Select none')),
      list),
    h('div', { class: 'at-foot' }, h('button', { class: 'btn primary at-go', onclick: close }, icon('check', 20), 'Done')));
  const box = h('div', { class: 'at-scrim clear' }, sheet);
  document.body.append(box);
  render();
}

// ====================================================================== Silence studio (video + timeline of what will be cut)
export interface StudioFrames { count: number; frames: (HTMLImageElement | undefined)[]; aspect: number }
export interface StudioOpts {
  items: SilenceItem[]; durationMs: number;
  getMs: () => number; seek: (ms: number) => void;
  isPlaying: () => boolean; setPlaying: (on: boolean) => void;
  frames: () => StudioFrames | undefined;
  peaks: () => Float32Array | undefined; peaksPerSec: number;
  /** a cut was switched on / off */
  onToggle: () => void;
}

const FILM_H = 58, WAVE_H = 40, RULER_H = 18, BLOCK_Y = RULER_H;

/**
 * The review timeline: a strip of video pictures with the waveform under it, and every silence drawn on top as a red block with a
 * round tick (tap = cut / keep). Drag the strip left or right under the white line to go back and forth; the preview follows.
 * Play skips the parts that are marked for cutting, so you hear the result before you remove anything.
 */
export function buildSilenceStudio(o: StudioOpts): { el: HTMLElement; update: (ms: number) => void; dispose: () => void } {
  const dur = Math.max(1, o.durationMs);
  const pps = Math.max(8, Math.min(70, 12000 / (dur / 1000)));     // px per second, strip never wider than 12000 px
  const W = Math.round((dur / 1000) * pps);
  let skip = true, ignore = 0, disposed = false;

  const scroller = h('div', { class: 'ssd-scroll' }) as HTMLElement;
  const inner = h('div', { class: 'ssd-inner', style: `width:${W}px;height:${RULER_H + FILM_H + WAVE_H}px` });
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = RULER_H + FILM_H + WAVE_H; cv.style.cssText = `width:${W}px;height:${cv.height}px;display:block`;
  inner.append(cv);
  scroller.append(inner);

  const mm = (ms: number) => { const t = Math.floor(ms / 1000); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
  function drawStrip() {
    const g = cv.getContext('2d'); if (!g) return;
    g.fillStyle = '#0c0c0e'; g.fillRect(0, 0, W, cv.height);
    // ruler
    g.fillStyle = '#8a8a90'; g.font = '11px sans-serif'; g.textBaseline = 'top';
    const step = pps >= 40 ? 1 : pps >= 20 ? 2 : pps >= 10 ? 5 : 10;
    for (let s = 0; s * 1000 <= dur; s += step) {
      const x = Math.round(s * pps);
      g.fillRect(x, RULER_H - 5, 1, 5);
      if (s % (step * 2) === 0 || step >= 5) g.fillText(mm(s * 1000), x + 3, 1);
    }
    // pictures
    const fr = o.frames();
    if (fr && fr.count) {
      const fw = W / fr.count;
      for (let i = 0; i < fr.count; i++) {
        const im = fr.frames[i]; if (!im) { g.fillStyle = '#18181b'; g.fillRect(i * fw, RULER_H, fw, FILM_H); continue; }
        const sc = Math.max(fw / im.naturalWidth, FILM_H / im.naturalHeight);
        g.save(); g.beginPath(); g.rect(i * fw, RULER_H, fw + 1, FILM_H); g.clip();
        g.drawImage(im, i * fw + (fw - im.naturalWidth * sc) / 2, RULER_H + (FILM_H - im.naturalHeight * sc) / 2, im.naturalWidth * sc, im.naturalHeight * sc);
        g.restore();
      }
    } else { g.fillStyle = '#18181b'; g.fillRect(0, RULER_H, W, FILM_H); }
    // waveform
    const pk = o.peaks();
    const y0 = RULER_H + FILM_H;
    g.fillStyle = '#111114'; g.fillRect(0, y0, W, WAVE_H);
    if (pk && pk.length) {
      let mx = 0; for (let i = 0; i < pk.length; i++) if (pk[i]! > mx) mx = pk[i]!;
      g.fillStyle = '#6b6b73';
      for (let x = 0; x < W; x += 2) {
        const i = Math.min(pk.length - 1, Math.floor((x / pps) * o.peaksPerSec));
        const v = Math.min(1, (pk[i] ?? 0) / (mx || 1)), hh = Math.max(1, v * (WAVE_H - 6));
        g.fillRect(x, y0 + (WAVE_H - hh) / 2, 1.5, hh);
      }
    }
  }

  const blocks = h('div', { class: 'ssd-blocks' });
  inner.append(blocks);
  function drawBlocks() {
    blocks.replaceChildren(...o.items.map((it, n) => {
      const l = (it.r.startMs / 1000) * pps, w = Math.max(6, ((it.r.endMs - it.r.startMs) / 1000) * pps);
      const tick = h('span', { class: 'ssd-tick' }, it.on ? icon('check', 12) : '');
      const b = h('button', {
        class: 'ssd-blk' + (it.on ? ' on' : ''), style: `left:${l}px;width:${w}px;top:${BLOCK_Y}px;height:${FILM_H + WAVE_H}px`,
        'aria-label': `Silence ${n + 1}: ${it.on ? 'will be cut' : 'kept'}. Tap to switch`, 'aria-pressed': String(it.on),
        onclick: () => { it.on = !it.on; o.onToggle(); drawBlocks(); paintSum(); },
      }, tick);
      return b;
    }));
  }

  const sum = h('div', { class: 'ssd-sum' });
  function paintSum() {
    const on = o.items.filter((i) => i.on);
    const ms = on.reduce((a, i) => a + (i.r.endMs - i.r.startMs), 0);
    sum.textContent = o.items.length ? `${on.length} of ${o.items.length} silent parts will be cut · ${(ms / 1000).toFixed(1)} s removed · after: ${mm(Math.max(0, dur - ms))}` : 'No silence found.';
  }

  const timeLbl = h('span', { class: 'ssd-time' }, '0:00');
  const playBtn = h('button', { class: 'ssd-play', 'aria-label': 'Play', onclick: () => o.setPlaying(!o.isPlaying()) }, icon('play', 22));
  const skipBtn = h('button', { class: 'ssd-skip on', role: 'switch', 'aria-checked': 'true', onclick: () => { skip = !skip; skipBtn.classList.toggle('on', skip); skipBtn.setAttribute('aria-checked', String(skip)); } }, 'Skip cuts');
  const prevBtn = h('button', { class: 'ssd-nav', 'aria-label': 'Previous silent part', onclick: () => jump(-1) }, '‹');
  const nextBtn = h('button', { class: 'ssd-nav', 'aria-label': 'Next silent part', onclick: () => jump(1) }, '›');
  function jump(dir: number) {
    const ms = o.getMs();
    const t = dir > 0 ? o.items.find((i) => i.r.startMs > ms + 200) : [...o.items].reverse().find((i) => i.r.startMs < ms - 400);
    if (t) { o.setPlaying(false); o.seek(Math.max(0, t.r.startMs - 300)); }
  }
  const head = h('div', { class: 'ssd-head' }, prevBtn, playBtn, nextBtn, timeLbl, h('span', { class: 'grow' }), skipBtn);
  const wrap = h('div', { class: 'ssd-wrap' }, scroller, h('div', { class: 'ssd-line' }));
  const el = h('div', { class: 'ssd' }, head, wrap, sum);

  scroller.addEventListener('scroll', () => {
    if (performance.now() < ignore) return;
    o.seek((scroller.scrollLeft / pps) * 1000);
  }, { passive: true });

  function update(ms: number) {
    if (disposed) return;
    const left = Math.round((ms / 1000) * pps);
    if (Math.abs(scroller.scrollLeft - left) > 1) { ignore = performance.now() + 120; scroller.scrollLeft = left; }
    timeLbl.textContent = `${mm(ms)} / ${mm(dur)}`;
    playBtn.replaceChildren(icon(o.isPlaying() ? 'pause' : 'play', 22));
  }
  // half a screen of empty room on both sides so 0:00 and the end can reach the white line
  const padPx = () => Math.round((scroller.clientWidth || 360) / 2);
  const setPad = () => { inner.style.margin = `0 ${padPx()}px`; };
  requestAnimationFrame(() => { setPad(); update(o.getMs()); });

  const timer = window.setInterval(() => {
    if (disposed) return;
    if (skip && o.isPlaying()) {
      const ms = o.getMs();
      const it = o.items.find((i) => i.on && ms >= i.r.startMs && ms < i.r.endMs - 30);
      if (it) o.seek(it.r.endMs);
    }
    update(o.getMs());
  }, 60);
  let redraws = 0;
  const redraw = window.setInterval(() => { drawStrip(); if (++redraws > 14) window.clearInterval(redraw); }, 700);
  drawStrip(); drawBlocks(); paintSum();
  return { el, update, dispose: () => { disposed = true; window.clearInterval(timer); window.clearInterval(redraw); } };
}
