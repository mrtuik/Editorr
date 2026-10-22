import { app } from '../app';
import { peaks } from '../core/audio';
import { History, runtime, saveProject } from '../core/store';
import { tick } from '../core/native';
import { deleteSegment, mergeWithPrev, moveBoundary, segmentAt, splitAt, updateSegment } from '../core/timeline';
import { Corner, LayoutStyle, PopupSize, Role, Segment, segmentColor, STYLE_LABEL } from '../core/types';
import { actionSheet, confirmDialog, fmtTime, h, icon, iconButton, toast } from '../ui';
import { PEAKS_PER_SEC } from './sync';

const SHORT: Record<LayoutStyle, string> = { one: '', side: 'Side', updown: 'Up/Down', popup: 'Popup' };

export function editorScreen() {
  const p = app.project;
  const hist = new History();
  let playMs = 0;
  let playing = false;
  let selectedId: string | null = null;
  let pxPerSec = 30;
  let raf = 0;
  let saveTimer = 0;

  if (!runtime.hostUrl || !runtime.constUrl || !runtime.hostPcm || !runtime.constPcm) {
    return { el: h('div', { class: 'screen' }, h('div', { class: 'content' }, h('div', { class: 'err' }, 'Videos are not loaded. Go back and import them again.'), h('button', { class: 'btn', onclick: () => app.go('import') }, 'Import')) ) };
  }

  const hostPeaks = peaks(runtime.hostPcm, Math.ceil((runtime.hostPcm.length / 16000) * PEAKS_PER_SEC));
  const constPeaks = peaks(runtime.constPcm, Math.ceil((runtime.constPcm.length / 16000) * PEAKS_PER_SEC));

  // ---------- Preview ----------
  const hostV = h('video', { src: runtime.hostUrl, playsInline: true, preload: 'auto', 'aria-label': 'Host video' }) as HTMLVideoElement;
  const constV = h('video', { src: runtime.constUrl, playsInline: true, preload: 'auto', 'aria-label': 'Constant video' }) as HTMLVideoElement;
  hostV.muted = p.mainAudio !== 'host';
  constV.muted = p.mainAudio !== 'constant';
  const stage = h('div', { class: 'stage' }, hostV, constV);
  const preview = h('div', { class: 'preview' }, stage);

  const POP: Record<PopupSize, number> = { S: 24, M: 32, L: 42 };
  function place(v: HTMLVideoElement, x: number, y: number, w: number, hh: number, pop = false) {
    v.style.display = 'block';
    v.style.left = `${x}%`; v.style.top = `${y}%`; v.style.width = `${w}%`; v.style.height = `${hh}%`;
    v.style.zIndex = pop ? '2' : '1';
    v.classList.toggle('pop', pop);
  }
  function hide(v: HTMLVideoElement) { v.style.display = 'none'; }

  function applyLayout(seg: Segment | undefined) {
    if (!seg) return;
    const main = seg.main === 'host' ? hostV : constV;
    const other = seg.main === 'host' ? constV : hostV;
    if (seg.style === 'one') { place(main, 0, 0, 100, 100); hide(other); }
    else if (seg.style === 'side') { place(hostV, 0, 0, 50, 100); place(constV, 50, 0, 50, 100); }
    else if (seg.style === 'updown') { place(hostV, 0, 0, 100, 50); place(constV, 0, 50, 100, 50); }
    else {
      place(main, 0, 0, 100, 100);
      const w = POP[seg.size];
      const heightPct = w; // box is 16:9 inside a 16:9 stage, so height% == width%
      const m = 3;
      const x = seg.corner === 'tl' || seg.corner === 'bl' ? m : 100 - w - m;
      const y = seg.corner === 'tl' || seg.corner === 'tr' ? m * 1.6 : 100 - heightPct - m * 1.6;
      place(other, x, y, w, heightPct, true);
    }
  }

  let lastSegId = '';
  function syncVideos(force = false) {
    const t = playMs / 1000;
    if (force || Math.abs(hostV.currentTime - t) > 0.2) hostV.currentTime = t;
    const ct = (playMs + p.offsetMs) / 1000;
    if (ct < 0 || ct > constV.duration) { constV.pause(); }
    else {
      if (force || Math.abs(constV.currentTime - ct) > 0.15) constV.currentTime = ct;
      if (playing && constV.paused) constV.play().catch(() => {});
    }
  }

  function setPlaying(on: boolean) {
    playing = on;
    if (on) {
      if (playMs >= p.durationMs - 50) playMs = 0;
      syncVideos(true);
      hostV.play().catch(() => {}); constV.play().catch(() => {});
    } else { hostV.pause(); constV.pause(); }
    playBtn.replaceChildren(icon(on ? 'pause' : 'play'));
    playBtn.setAttribute('aria-label', on ? 'Pause' : 'Play');
  }

  function seek(ms: number) {
    playMs = Math.max(0, Math.min(p.durationMs, ms));
    syncVideos(true);
    refresh(false);
  }

  // ---------- Timeline canvas ----------
  const canvas = h('canvas') as HTMLCanvasElement;
  const tl = h('div', { class: 'timeline' }, canvas);
  const RULER = 20;
  let W = 0, H = 0;

  function layoutRows() {
    const rem = H - RULER - 6;
    const wave = Math.max(24, rem * 0.26);
    return { ruler: [0, RULER], host: [RULER + 2, wave], cons: [RULER + 4 + wave, wave], lay: [RULER + 6 + wave * 2, rem - wave * 2] };
  }
  const xOf = (ms: number) => W / 2 + ((ms - playMs) / 1000) * pxPerSec;
  const msOf = (x: number) => playMs + ((x - W / 2) / pxPerSec) * 1000;

  function drawWave(g: CanvasRenderingContext2D, arr: Float32Array, shiftMs: number, y: number, hgt: number, color: string) {
    g.fillStyle = color;
    const mid = y + hgt / 2;
    for (let x = 0; x < W; x += 2) {
      const ms = msOf(x);
      if (ms < 0 || ms > p.durationMs) continue;
      const idx = Math.round(((ms + shiftMs) / 1000) * PEAKS_PER_SEC);
      const v = arr[idx];
      if (v === undefined) continue;
      const bh = Math.max(1, v * hgt * 0.95);
      g.fillRect(x, mid - bh / 2, 1.5, bh);
    }
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const cw = tl.clientWidth, ch = tl.clientHeight;
    if (!cw || !ch) return;
    if (W !== cw || H !== ch) { W = cw; H = ch; canvas.width = W * dpr; canvas.height = H * dpr; }
    const g = canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const rows = layoutRows();

    // ruler
    g.fillStyle = '#A0A0A0'; g.font = '10px Roboto, sans-serif'; g.textBaseline = 'middle';
    const stepSec = pxPerSec >= 120 ? 1 : pxPerSec >= 50 ? 5 : pxPerSec >= 20 ? 10 : pxPerSec >= 10 ? 30 : 60;
    const startS = Math.max(0, Math.floor(msOf(0) / 1000 / stepSec) * stepSec);
    for (let s = startS; s * 1000 <= Math.min(p.durationMs, msOf(W)); s += stepSec) {
      const x = xOf(s * 1000);
      g.fillStyle = '#262626'; g.fillRect(x, RULER - 6, 1, 6);
      g.fillStyle = '#A0A0A0'; g.fillText(fmtTime(s * 1000), x + 3, 8);
    }

    // waves
    g.fillStyle = '#111111';
    g.fillRect(0, rows.host[0], W, rows.host[1]); g.fillRect(0, rows.cons[0], W, rows.cons[1]);
    drawWave(g, hostPeaks, 0, rows.host[0], rows.host[1], '#3B82F6');
    drawWave(g, constPeaks, p.offsetMs, rows.cons[0], rows.cons[1], '#22C55E');
    g.fillStyle = '#A0A0A0'; g.font = '10px Roboto, sans-serif';
    g.fillText('Host', 4, rows.host[0] + 8); g.fillText('Constant', 4, rows.cons[0] + 8);

    // layout track
    const [ly, lh] = rows.lay;
    for (const s of p.segments) {
      const x1 = xOf(s.startMs), x2 = xOf(s.endMs);
      if (x2 < 0 || x1 > W) continue;
      g.fillStyle = segmentColor(s);
      g.beginPath(); g.roundRect(x1 + 0.5, ly, Math.max(2, x2 - x1 - 1), lh, 6); g.fill();
      if (s.id === selectedId) {
        g.strokeStyle = '#FFFFFF'; g.lineWidth = 2;
        g.beginPath(); g.roundRect(x1 + 1.5, ly + 1, Math.max(2, x2 - x1 - 3), lh - 2, 5); g.stroke();
      }
      if (x2 - x1 > 44) {
        g.fillStyle = '#000000'; g.font = '600 11px Roboto, sans-serif';
        const label = s.style === 'one' ? (s.main === 'host' ? 'Host' : 'Const') : SHORT[s.style];
        g.fillText(label, Math.max(x1, 0) + 6, ly + lh / 2);
      }
    }

    // playhead (fixed at center)
    g.fillStyle = '#3B82F6'; g.fillRect(W / 2 - 1, 0, 2, H);
    g.beginPath(); g.moveTo(W / 2 - 6, 0); g.lineTo(W / 2 + 6, 0); g.lineTo(W / 2, 8); g.fill();
  }

  // ---------- Gestures ----------
  type Ptr = { x: number; y: number };
  const ptrs = new Map<number, Ptr>();
  let mode: 'none' | 'scrub' | 'boundary' | 'pinch' = 'none';
  let startX = 0, startY = 0, startT = 0, moved = false, boundaryIdx = -1, pinchDist = 0, pinchZoom = 0, lpTimer = 0;

  function localX(e: PointerEvent) { return e.clientX - tl.getBoundingClientRect().left; }
  function localY(e: PointerEvent) { return e.clientY - tl.getBoundingClientRect().top; }
  function hitSegment(x: number, y: number): Segment | undefined {
    const [ly, lh] = layoutRows().lay;
    if (y < ly - 4 || y > ly + lh + 4) return undefined;
    const ms = msOf(x);
    return p.segments.find((s) => ms >= s.startMs && ms < s.endMs);
  }
  function hitBoundary(x: number, y: number): number {
    const [ly, lh] = layoutRows().lay;
    if (y < ly - 6 || y > ly + lh + 6) return -1;
    for (let i = 0; i < p.segments.length - 1; i++) if (Math.abs(xOf(p.segments[i].endMs) - x) < 16) return i;
    return -1;
  }

  tl.addEventListener('pointerdown', (e) => {
    tl.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: localX(e), y: localY(e) });
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y); pinchZoom = pxPerSec; mode = 'pinch';
      clearTimeout(lpTimer); return;
    }
    if (playing) setPlaying(false);
    startX = localX(e); startY = localY(e); startT = Date.now(); moved = false;
    const bi = hitBoundary(startX, startY);
    if (bi >= 0) { mode = 'boundary'; boundaryIdx = bi; hist.push(p.segments); }
    else mode = 'scrub';
    clearTimeout(lpTimer);
    lpTimer = window.setTimeout(() => {
      if (moved || mode !== 'scrub') return;
      const s = hitSegment(startX, startY);
      if (s) { select(s.id); openMenu(); }
    }, 550);
  });

  tl.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const x = localX(e);
    const prev = ptrs.get(e.pointerId)!;
    ptrs.set(e.pointerId, { x, y: localY(e) });
    if (mode === 'pinch' && ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      pxPerSec = Math.max(4, Math.min(300, pinchZoom * (d / (pinchDist || 1))));
      draw(); return;
    }
    if (Math.abs(x - startX) > 8) { moved = true; clearTimeout(lpTimer); }
    if (mode === 'scrub') {
      playMs = Math.max(0, Math.min(p.durationMs, playMs - ((x - prev.x) / pxPerSec) * 1000));
      syncVideos(true);
      refresh(false);
    } else if (mode === 'boundary') {
      p.segments = moveBoundary(p.segments, boundaryIdx, msOf(x));
      applyLayout(segmentAt(p.segments, playMs));
      draw();
    }
  });

  const end = (e: PointerEvent) => {
    ptrs.delete(e.pointerId);
    clearTimeout(lpTimer);
    if (ptrs.size === 1 && mode === 'pinch') { mode = 'none'; return; }
    if (ptrs.size > 0) return;
    if (mode === 'scrub' && !moved && Date.now() - startT < 400) {
      const s = hitSegment(startX, startY);
      if (s) { select(s.id); tick(); }
    }
    if (mode === 'boundary') scheduleSave();
    mode = 'none';
  };
  tl.addEventListener('pointerup', end);
  tl.addEventListener('pointercancel', end);

  // ---------- Controls ----------
  const timeText = h('div', { class: 'timeText' }, '');
  const playBtn = iconButton('play', 'Play', () => setPlaying(!playing));
  const undoBtn = iconButton('undo', 'Undo', () => { const r = hist.undo(p.segments); if (r) { p.segments = r; afterEdit(); } });
  const redoBtn = iconButton('redo', 'Redo', () => { const r = hist.redo(p.segments); if (r) { p.segments = r; afterEdit(); } });
  const fsBtn = iconButton('full', 'Full screen preview', () => {
    stage.classList.toggle('full');
    if (stage.classList.contains('full')) {
      stage.addEventListener('click', exitFull, { once: true });
      (screen.orientation as any)?.lock?.('landscape').catch(() => {});
    }
  });
  function exitFull() { stage.classList.remove('full'); (screen.orientation as any)?.unlock?.(); }

  const controls = h('div', { class: 'controls' },
    iconButton('back10', 'Back 10 seconds', () => seek(playMs - 10000)),
    playBtn,
    iconButton('fwd10', 'Forward 10 seconds', () => seek(playMs + 10000)),
    timeText, undoBtn, redoBtn, fsBtn);

  // ---------- Style bar + options ----------
  const styleBtns = (['one', 'side', 'updown', 'popup'] as LayoutStyle[]).map((st) =>
    h('button', { class: 'btn', 'aria-label': STYLE_LABEL[st], onclick: () => setStyle(st) }, icon(st, 22), STYLE_LABEL[st]));
  const styleBar = h('div', { class: 'stylebar' }, ...styleBtns);
  const opts = h('div', { class: 'popopts' });

  function selected(): Segment | undefined { return p.segments.find((s) => s.id === selectedId); }
  function select(id: string) { selectedId = id; renderOpts(); draw(); updateStyleBar(); }

  function edit(next: Segment[]) { hist.push(p.segments); p.segments = next; afterEdit(); }
  function afterEdit() { applyLayout(segmentAt(p.segments, playMs)); if (!selected()) selectedId = segmentAt(p.segments, playMs)?.id ?? null; renderOpts(); updateStyleBar(); draw(); updateBtns(); scheduleSave(); }

  function setStyle(st: LayoutStyle) {
    const s = selected() ?? segmentAt(p.segments, playMs);
    if (!s) return;
    selectedId = s.id;
    edit(updateSegment(p.segments, s.id, { style: st })); tick();
  }
  function patch(pt: Partial<Segment>) { const s = selected(); if (s) edit(updateSegment(p.segments, s.id, pt)); }

  function doSplit() { edit(splitAt(p.segments, playMs)); selectedId = segmentAt(p.segments, playMs)?.id ?? null; tick(); }
  function doMerge() { const s = selected(); if (s) { edit(mergeWithPrev(p.segments, s.id)); selectedId = null; afterEdit(); } }
  async function doDelete() {
    const s = selected(); if (!s || p.segments.length <= 1) { toast('Cannot delete the only segment.'); return; }
    if (await confirmDialog('Delete segment?', 'The neighbouring segment will fill the gap.')) { edit(deleteSegment(p.segments, s.id)); selectedId = null; afterEdit(); }
  }
  function openMenu() {
    actionSheet([
      { label: 'Split at playhead', run: doSplit },
      { label: 'Merge with previous', run: doMerge },
      { label: 'Delete segment', danger: true, run: doDelete },
    ]);
  }

  function optBtn(label: string, on: boolean, run: () => void, aria?: string) {
    return h('button', { class: 'btn small' + (on ? ' primary' : ''), style: on ? 'flex:none' : '', 'aria-label': aria ?? label, onclick: run }, label);
  }
  function renderOpts() {
    const s = selected();
    const rows: Node[] = [
      optBtn('Split', false, doSplit, 'Split at playhead'),
      optBtn('Merge', false, doMerge, 'Merge with previous'),
      optBtn('Delete', false, doDelete),
    ];
    if (s && (s.style === 'one' || s.style === 'popup')) {
      rows.push(optBtn('Main: Host', s.main === 'host', () => patch({ main: 'host' as Role })));
      rows.push(optBtn('Main: Const', s.main === 'constant', () => patch({ main: 'constant' as Role })));
    }
    if (s && s.style === 'popup') {
      (['tl', 'tr', 'bl', 'br'] as Corner[]).forEach((c) => rows.push(optBtn({ tl: 'Top L', tr: 'Top R', bl: 'Bot L', br: 'Bot R' }[c], s.corner === c, () => patch({ corner: c }), `Popup corner ${c}`)));
      (['S', 'M', 'L'] as PopupSize[]).forEach((z) => rows.push(optBtn(z, s.size === z, () => patch({ size: z }), `Popup size ${z}`)));
    }
    opts.replaceChildren(...rows);
  }
  function updateStyleBar() {
    const s = selected();
    (['one', 'side', 'updown', 'popup'] as LayoutStyle[]).forEach((st, i) => styleBtns[i].classList.toggle('sel', s?.style === st));
  }
  function updateBtns() { undoBtn.disabled = !hist.canUndo; redoBtn.disabled = !hist.canRedo; }

  function scheduleSave() { clearTimeout(saveTimer); saveTimer = window.setTimeout(() => saveProject(p), 600); }

  // ---------- Main loop ----------
  function refresh(followVideo: boolean) {
    if (followVideo) playMs = hostV.currentTime * 1000;
    const seg = segmentAt(p.segments, playMs);
    if (seg && seg.id !== lastSegId) { lastSegId = seg.id; }
    applyLayout(seg);
    timeText.textContent = `${fmtTime(playMs)} / ${fmtTime(p.durationMs)}`;
    draw();
  }
  function loop() {
    if (playing) {
      if (hostV.currentTime * 1000 >= p.durationMs - 30) { setPlaying(false); }
      else { refresh(true); syncVideos(false); }
    }
    raf = requestAnimationFrame(loop);
  }

  const proj = h('h1', {}, p.name);
  const el = h('div', { class: 'screen' },
    h('div', { class: 'topbar' },
      iconButton('back', 'Back', () => { saveProject(p); app.go('home'); }),
      proj,
      h('button', { class: 'btn small', style: 'background:var(--accent);border-color:var(--accent)', onclick: () => { setPlaying(false); saveProject(p); app.go('export'); } }, 'Export')),
    preview, controls, tl, opts, styleBar);

  requestAnimationFrame(() => {
    selectedId = segmentAt(p.segments, 0)?.id ?? null;
    renderOpts(); updateStyleBar(); updateBtns();
    hostV.addEventListener('loadedmetadata', () => seek(0), { once: true });
    refresh(false);
    loop();
  });
  window.addEventListener('resize', draw);

  return {
    el,
    destroy: () => {
      cancelAnimationFrame(raf); clearTimeout(saveTimer); saveProject(p);
      hostV.pause(); constV.pause();
      window.removeEventListener('resize', draw);
    },
  };
}
