import { FACE_SAMPLE_MS, trackAnchor, type FaceScan } from '../core/faces';
import { h, icon } from '../ui';

/**
 * Bottom sheet: shows one frame of a video with a box on every detected person. Tap a person to follow them.
 * Resolves with the chosen point, null for "main person (auto)", or undefined when cancelled.
 */
export function pickFace(
  title: string,
  url: string,
  scan: FaceScan,
  current: { x: number; y: number } | null | undefined,
): Promise<{ x: number; y: number } | null | undefined> {
  return new Promise((resolve) => {
    const done = (v: { x: number; y: number } | null | undefined) => {
      sheet.classList.add('out');
      setTimeout(() => { box.remove(); video.removeAttribute('src'); video.load(); resolve(v); }, 180);
    };

    // the moment with the most people in view
    let bestI = 0, bestN = -1;
    for (let i = 0; i < scan.n; i++) {
      let c = 0;
      for (const t of scan.tracks) if (!Number.isNaN(t.cx[i])) c++;
      if (c > bestN) { bestN = c; bestI = i; }
    }

    const canvas = h('canvas', { class: 'fp-canvas' }) as HTMLCanvasElement;
    const stage = h('div', { class: 'fp-stage', style: `aspect-ratio:${scan.aspect}` }, canvas);
    const hint = h('div', { class: 'at-hint' }, 'Tap the person to follow.');

    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.preload = 'auto'; video.src = url;
    const draw = () => {
      canvas.width = 640; canvas.height = Math.max(2, Math.round(640 / scan.aspect));
      try { canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height); } catch { /* show boxes on black */ }
    };
    video.onloadeddata = () => {
      const t = (scan.startMs + bestI * FACE_SAMPLE_MS) / 1000;
      const fin = () => { video.removeEventListener('seeked', fin); draw(); };
      video.addEventListener('seeked', fin);
      try { video.currentTime = Math.min(video.duration || t, Math.max(0, t)); } catch { fin(); }
    };

    const med = (a: Float32Array) => { const v = Array.from(a).filter((x) => !Number.isNaN(x)).sort((x, y) => x - y); return v[Math.floor(v.length / 2)]; };
    scan.tracks.forEach((t, k) => {
      const here = !Number.isNaN(t.cx[bestI]);
      const cx = here ? t.cx[bestI] : med(t.cx), cy = here ? t.cy[bestI] : med(t.cy);
      const w = here ? t.w[bestI] : med(t.w), hh = here ? t.h[bestI] : med(t.h);
      const a = trackAnchor(t);
      const on = !!current && Math.hypot(a.x - current.x, a.y - current.y) < 0.12;
      stage.append(h('button', {
        class: 'fp-box' + (on ? ' on' : ''),
        'aria-label': `Person ${k + 1}`,
        style: `left:${(cx - w / 2) * 100}%;top:${(cy - hh / 2) * 100}%;width:${w * 100}%;height:${hh * 100}%`,
        onclick: () => done(a),
      }, h('span', {}, `Person ${k + 1}`)));
    });

    const sheet = h('div', { class: 'at-sheet', role: 'dialog' },
      h('div', { class: 'at-handle' }),
      h('div', { class: 'at-head' },
        h('button', { class: 'at-back', 'aria-label': 'Cancel', onclick: () => done(undefined) }, icon('back', 20)),
        h('div', { class: 'at-title' }, title),
        h('span', { class: 'at-head-gap' })),
      h('div', { class: 'at-body' }, hint, stage),
      h('div', { class: 'at-foot' },
        h('button', { class: 'btn at-go', onclick: () => done(null) }, 'Main person (auto)')));
    const box = h('div', { class: 'at-scrim', onclick: (e: Event) => { if (e.target === box) done(undefined); } }, sheet);
    document.body.append(box);
  });
}
