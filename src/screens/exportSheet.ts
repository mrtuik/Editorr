import { app } from '../app';
import { h, icon } from '../ui';
import { saveSettings } from '../core/store';
import { FPS_STEPS, RES_STEPS, recommendedMbps, resLabel, type Project } from '../core/types';
import { estimateMb, fmtSize, mbpsToPos, posToMbps, resolveExport, sourceLimits } from '../core/exportOpts';

/** Short label for the chip next to the Export button, e.g. "1080P" or "4K". */
export function resChipText(p: Project): string {
  return resLabel(resolveExport(p, app.settings).res).toUpperCase();
}

/**
 * CapCut-style export settings: resolution, frame rate, bitrate, estimated file size.
 * Values are saved to Settings, so the Export screen uses them as they are.
 */
export function openExportSheet(p: Project, opts: { onChange: () => void; onExport: () => void }): void {
  const st = app.settings;
  const { maxRes, maxFps } = sourceLimits(p);
  const save = () => { saveSettings(st); opts.onChange(); };

  const resLabels = RES_STEPS.map(resLabel);
  const fpsLabels = FPS_STEPS.map(String);
  let resIdx = 0, fpsIdx = 0;

  const resDots = h('div', { class: 'sg-dots' });
  const fpsDots = h('div', { class: 'sg-dots' });
  const resHint = h('span', { class: 'tg-h' }, '');
  const fpsHint = h('span', { class: 'tg-h' }, '');
  const brHint = h('div', { class: 'tg-h xs-hint' }, '');
  const brVal = h('span', { class: 'rs-val' });
  const brIn = h('input', { type: 'range', min: '0', max: '100', step: '1', class: 'at-range', 'aria-label': 'Bitrate' }) as HTMLInputElement;
  const sizeEl = h('div', { class: 'xs-size' }, '');
  const noteEl = h('div', { class: 'xs-note' }, '');

  function drawDots(box: HTMLElement, labels: string[], cur: number, off: (i: number) => boolean, pick: (i: number) => void) {
    box.replaceChildren(...labels.map((l, i) =>
      h('button', { class: 'sg-d' + (i === cur ? ' on' : ''), 'aria-label': l, disabled: off(i) ? 'true' : undefined, onclick: () => pick(i) }, i === cur ? l : '')));
  }

  function refresh() {
    const o = resolveExport(p, st);
    resIdx = Math.max(0, RES_STEPS.indexOf(o.res));
    fpsIdx = Math.max(0, FPS_STEPS.indexOf(o.fps));
    drawDots(resDots, resLabels, resIdx, (i) => RES_STEPS[i]! > maxRes, (i) => {
      st.resolution = RES_STEPS[i]!;
      st.bitrateMbps = 0; // bitrate goes back to the recommended value for the new size
      save(); refresh();
    });
    drawDots(fpsDots, fpsLabels, fpsIdx, (i) => FPS_STEPS[i]! > maxFps, (i) => {
      st.fps = FPS_STEPS[i]!;
      st.bitrateMbps = 0;
      save(); refresh();
    });
    brIn.value = String(Math.round(mbpsToPos(o.mbps)));
    brVal.replaceChildren(h('b', {}, String(o.mbps)), h('i', {}, 'Mbps'));
    resHint.textContent = o.res === 1080 ? 'High definition' : o.res >= 1440 ? 'Ultra high definition' : o.res === 720 ? 'Standard definition' : 'Small size';
    fpsHint.textContent = o.fps >= 50 ? 'Smoother playback' : 'Standard';
    const rec = recommendedMbps(o.res, o.fps);
    brHint.textContent = `Recommended for this video: ${rec} Mbps`;
    sizeEl.textContent = `${o.mbps} Mbps · ${o.res === 1440 ? '2K' : o.res === 2160 ? '4K' : o.res + 'p'} · ${o.fps} fps  |  Estimated file size: ${fmtSize(estimateMb(p, o.mbps))}`;
    const limited = maxRes < RES_STEPS[RES_STEPS.length - 1]! || maxFps < FPS_STEPS[FPS_STEPS.length - 1]!;
    noteEl.textContent = limited ? `Your videos are ${resLabel(maxRes)} / ${maxFps} fps, so higher values are not available.` : '';
  }

  brIn.addEventListener('input', () => {
    const o = resolveExport(p, st);
    const m = posToMbps(Number(brIn.value));
    st.bitrateMbps = m === recommendedMbps(o.res, o.fps) ? 0 : m;
    save();
    brVal.replaceChildren(h('b', {}, String(m)), h('i', {}, 'Mbps'));
    const o2 = resolveExport(p, st);
    sizeEl.textContent = `${o2.mbps} Mbps · ${o2.res === 1440 ? '2K' : o2.res === 2160 ? '4K' : o2.res + 'p'} · ${o2.fps} fps  |  Estimated file size: ${fmtSize(estimateMb(p, o2.mbps))}`;
  });

  const dotRow = (title: string, hint: HTMLElement, dots: HTMLElement) =>
    h('div', { class: 'xs-card' }, h('div', { class: 'sg-row' }, h('div', { class: 'sg-text' }, h('span', { class: 'rs-l' }, title), hint), dots));

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
      dotRow('Resolution', resHint, resDots),
      dotRow('Frame rate', fpsHint, fpsDots),
      h('div', { class: 'xs-card' }, h('div', { class: 'rs' }, h('span', { class: 'rs-l' }, 'Bitrate'), brVal, brIn), brHint),
      sizeEl, noteEl,
      h('button', { class: 'exportbtn xs-go', onclick: () => { close(); opts.onExport(); } }, 'Export')));
  document.body.append(root);
  refresh();
}
