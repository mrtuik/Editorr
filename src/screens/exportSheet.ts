import { app } from '../app';
import { h, icon } from '../ui';
import { saveSettings } from '../core/store';
import { FPS_STEPS, RES_STEPS, recommendedMbps, resLabel, type Project } from '../core/types';
import { BITRATE_TICKS, estimateMb, fmtSize, mbpsToPos, posToMbps, resolveExport, sourceLimits } from '../core/exportOpts';

/** Short label for the chip next to the Export button, e.g. "1080P" or "4K". */
export function resChipText(p: Project): string {
  return resLabel(resolveExport(p, app.settings).res).toUpperCase();
}

function paint(input: HTMLInputElement) {
  const min = Number(input.min), max = Number(input.max), v = Number(input.value);
  input.style.setProperty('--fill', `${((v - min) / (max - min)) * 100}%`);
}

/**
 * CapCut-style export settings: resolution, frame rate, bitrate, estimated file size.
 * Values are saved to Settings, so the Export screen uses them as they are.
 */
export function openExportSheet(p: Project, opts: { onChange: () => void; onExport: () => void }): void {
  const st = app.settings;
  const { maxRes, maxFps } = sourceLimits(p);
  const save = () => { saveSettings(st); opts.onChange(); };

  const tickRow = (labels: string[], off: (i: number) => boolean) =>
    h('div', { class: 'xs-ticks' }, ...labels.map((l, i) => h('span', { class: off(i) ? 'off' : '' }, l)));

  // ---- resolution
  const resVal = h('div', { class: 'xs-val' }, '');
  const resIn = h('input', { type: 'range', min: '0', max: String(RES_STEPS.length - 1), step: '1', class: 'xs-range' }) as HTMLInputElement;
  // ---- frame rate
  const fpsVal = h('div', { class: 'xs-val' }, '');
  const fpsIn = h('input', { type: 'range', min: '0', max: String(FPS_STEPS.length - 1), step: '1', class: 'xs-range' }) as HTMLInputElement;
  // ---- bitrate
  const brVal = h('div', { class: 'xs-val' }, '');
  const brIn = h('input', { type: 'range', min: '0', max: '100', step: '1', class: 'xs-range' }) as HTMLInputElement;
  const sizeEl = h('div', { class: 'xs-size' }, '');
  const noteEl = h('div', { class: 'xs-note' }, '');

  function refresh() {
    const o = resolveExport(p, st);
    resIn.value = String(RES_STEPS.indexOf(o.res));
    fpsIn.value = String(Math.max(0, FPS_STEPS.indexOf(o.fps)));
    brIn.value = String(Math.round(mbpsToPos(o.mbps)));
    [resIn, fpsIn, brIn].forEach(paint);
    resVal.textContent = o.res === 1080 ? 'High definition' : o.res >= 1440 ? 'Ultra high definition' : o.res === 720 ? 'Standard definition' : 'Small size';
    fpsVal.textContent = o.fps >= 50 ? 'Smoother playback' : 'Standard';
    const rec = recommendedMbps(o.res, o.fps);
    brVal.textContent = `Recommended for this video (${rec})`;
    sizeEl.textContent = `${o.mbps} Mbps · ${o.res === 1440 ? '2K' : o.res === 2160 ? '4K' : o.res + 'p'} · ${o.fps} fps  |  Estimated file size: ${fmtSize(estimateMb(p, o.mbps))}`;
    const limited = maxRes < RES_STEPS[RES_STEPS.length - 1] || maxFps < FPS_STEPS[FPS_STEPS.length - 1];
    noteEl.textContent = limited ? `Your videos are ${resLabel(maxRes)} / ${maxFps} fps, so higher values are not available.` : '';
  }

  resIn.addEventListener('input', () => {
    const i = Math.min(Number(resIn.value), RES_STEPS.indexOf(maxRes));
    st.resolution = RES_STEPS[Math.max(0, i)];
    st.bitrateMbps = 0; // bitrate goes back to the recommended value for the new size
    save(); refresh();
  });
  fpsIn.addEventListener('input', () => {
    const allowed = FPS_STEPS.filter((f) => f <= maxFps);
    const i = Math.min(Number(fpsIn.value), Math.max(0, allowed.length - 1));
    st.fps = allowed.length ? FPS_STEPS[i] : FPS_STEPS[0];
    st.bitrateMbps = 0;
    save(); refresh();
  });
  brIn.addEventListener('input', () => {
    const o = resolveExport(p, st);
    const m = posToMbps(Number(brIn.value));
    st.bitrateMbps = m === recommendedMbps(o.res, o.fps) ? 0 : m;
    save(); refresh();
  });

  const row = (title: string, val: HTMLElement, input: HTMLElement, ticks: HTMLElement) =>
    h('div', { class: 'xs-row' }, h('div', { class: 'xs-head' }, h('div', { class: 'xs-title' }, title), val), input, ticks);

  const close = () => {
    root.remove();
    app.onBack = prevBack;
  };
  const prevBack = app.onBack;
  app.onBack = () => { close(); return true; };

  const root = h('div', { class: 'xs-backdrop', onclick: (e: Event) => { if (e.target === root) close(); } },
    h('div', { class: 'xs-sheet', role: 'dialog', 'aria-label': 'Export settings' },
      h('div', { class: 'xs-top' },
        h('div', { class: 'xs-tab' }, 'Export settings'),
        h('button', { class: 'xs-close', 'aria-label': 'Close', onclick: close }, icon('close', 20))),
      row('Resolution', resVal, resIn, tickRow(RES_STEPS.map(resLabel), (i) => RES_STEPS[i] > maxRes)),
      row('Frame rate', fpsVal, fpsIn, tickRow(FPS_STEPS.map(String), (i) => FPS_STEPS[i] > maxFps)),
      row('Bitrate (Mbps)', brVal, brIn, tickRow(BITRATE_TICKS.map(String), () => false)),
      sizeEl, noteEl,
      h('button', { class: 'exportbtn xs-go', onclick: () => { close(); opts.onExport(); } }, 'Export')));
  document.body.append(root);
  refresh();
}
