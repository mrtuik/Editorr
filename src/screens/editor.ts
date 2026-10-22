import { app } from '../app';
import { peaks } from '../core/audio';
import { detectSpeakers, lastMethod, lastSeparationDb, lastUsedLips, lastVoiceQuality } from '../core/speaker';
import { motionToActivity, scanMotion } from '../core/motion';
import { History, runtime, saveProject } from '../core/store';
import { EditorrNative, fileSrc, isNative, tick } from '../core/native';
import { deleteSegment, mergeWithPrev, moveBoundary, segmentAt, splitAt, updateSegment } from '../core/timeline';
import { Corner, LayoutStyle, PopupSize, Role, Segment, segmentColor, STYLE_LABEL } from '../core/types';
import { confirmDialog, fmtTime, h, ICON, icon, iconButton, progressBar, toast } from '../ui';
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
  let playWall = 0;
  let playBase = 0;

  function syncVideos(force = false) {
    const t = playMs / 1000;
    const drift = playing ? 0.4 : 0.05;
    if (force || Math.abs(hostV.currentTime - t) > drift) { try { hostV.currentTime = t; } catch { /* ignore */ } }
    if (playing && hostV.paused && t < hostV.duration) hostV.play().catch(() => {});
    const ct = (playMs + p.offsetMs) / 1000;
    if (ct < 0 || !(ct < constV.duration)) { if (!constV.paused) constV.pause(); }
    else {
      if (force || Math.abs(constV.currentTime - ct) > drift) { try { constV.currentTime = ct; } catch { /* ignore */ } }
      if (playing && constV.paused) constV.play().catch(() => {});
    }
  }

  function setPlaying(on: boolean) {
    playing = on;
    if (on) {
      if (playMs >= p.durationMs - 50) playMs = 0;
      playWall = performance.now(); playBase = playMs;
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

  // ---------- Preview copy for formats the WebView cannot play ----------
  const banner = h('div', { class: 'banner', style: 'display:none' });
  preview.append(banner);
  const proxying: Record<string, boolean> = {};
  async function ensurePlayable(role: Role, v: HTMLVideoElement) {
    if (!isNative()) return;
    const path = role === 'host' ? runtime.hostPath : runtime.constPath;
    if (!path) return;
    const label = role === 'host' ? 'Host' : 'Constant';
    const check = async () => {
      const broken = !!v.error || (v.readyState >= 1 && v.videoWidth === 0);
      if (!broken || proxying[role]) return;
      proxying[role] = true;
      banner.style.display = '';
      banner.textContent = `${label} video format is not supported for preview. Making a preview copy...`;
      try {
        const sub = await EditorrNative.addListener('proxyProgress', (e: { path?: string; percent: number }) => {
          if (e.path === path) banner.textContent = `Preparing ${label} preview ${Math.round(e.percent)}%`;
        });
        const r = await EditorrNative.makeProxy({ path, height: 480 });
        sub.remove().catch(() => {});
        v.src = fileSrc(r.proxyPath);
        v.load();
        v.addEventListener('loadedmetadata', () => { syncVideos(true); }, { once: true });
        banner.style.display = 'none';
        toast(`${label} preview ready`);
      } catch (e) {
        banner.textContent = `${label} preview failed: ${(e as Error).message}`;
      }
    };
    v.addEventListener('error', check);
    v.addEventListener('loadedmetadata', check);
    window.setTimeout(check, 4000);
  }
  ensurePlayable('host', hostV);
  ensurePlayable('constant', constV);

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

  function drawGlyph(g: CanvasRenderingContext2D, s: Segment, cx: number, cy: number) {
    g.fillStyle = '#000000'; g.strokeStyle = '#000000'; g.lineWidth = 2;
    if (s.style === 'one') {
      g.beginPath(); g.arc(cx, cy - 4, 4, 0, 6.3); g.fill();
      g.beginPath(); g.arc(cx, cy + 10, 8, Math.PI, 0); g.fill();
    } else if (s.style === 'side') { g.fillRect(cx - 9, cy - 6, 8, 12); g.fillRect(cx + 1, cy - 6, 8, 12); }
    else if (s.style === 'updown') { g.fillRect(cx - 8, cy - 9, 16, 8); g.fillRect(cx - 8, cy + 1, 16, 8); }
    else { g.strokeRect(cx - 9, cy - 6, 18, 12); g.fillRect(cx + 1, cy + 1, 7, 4); }
  }
  let actSrc: [Float32Array | undefined, Float32Array | undefined] = [undefined, undefined];
  let actH: Float32Array | undefined, actC: Float32Array | undefined;
  function drawMotion(g: CanvasRenderingContext2D) {
    if (!runtime.hostMotion || !runtime.constMotion) return;
    if (actSrc[0] !== runtime.hostMotion || actSrc[1] !== runtime.constMotion) {
      actSrc = [runtime.hostMotion, runtime.constMotion];
      actH = motionToActivity(runtime.hostMotion); actC = motionToActivity(runtime.constMotion);
    }
    const rows = layoutRows();
    const bars = (arr: Float32Array, y: number, hgt: number) => {
      g.fillStyle = 'rgba(245,158,11,.85)';
      for (let x = 0; x < W; x += 3) {
        const ms = msOf(x); if (ms < 0 || ms > p.durationMs) continue;
        const v = Math.max(0, Math.min(1.5, arr[Math.round(ms / 100)] ?? 0)) / 1.5;
        const bh = v * hgt * 0.4; if (bh > 0.5) g.fillRect(x, y + hgt - bh, 2, bh);
      }
    };
    bars(actH!, rows.host[0], rows.host[1]); bars(actC!, rows.cons[0], rows.cons[1]);
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
    drawWave(g, hostPeaks, 0, rows.host[0], rows.host[1], '#FFFFFF');
    drawWave(g, constPeaks, p.offsetMs, rows.cons[0], rows.cons[1], '#22C55E');
    g.fillStyle = '#FFFFFF'; g.beginPath(); g.arc(9, rows.host[0] + 9, 4, 0, 6.3); g.fill();
    g.fillStyle = '#22C55E'; g.beginPath(); g.arc(9, rows.cons[0] + 9, 4, 0, 6.3); g.fill();
    drawMotion(g);

    // layout track
    const [ly, lh] = rows.lay;
    for (const s of p.segments) {
      const x1 = xOf(s.startMs), x2 = xOf(s.endMs);
      if (x2 < 0 || x1 > W) continue;
      g.fillStyle = segmentColor(s);
      g.beginPath(); g.roundRect(x1 + 0.5, ly, Math.max(2, x2 - x1 - 1), lh, 6); g.fill();
      if (s.id === selectedId) {
        g.strokeStyle = '#000000'; g.lineWidth = 3;
        g.beginPath(); g.roundRect(x1 + 2.5, ly + 2, Math.max(2, x2 - x1 - 5), lh - 4, 4); g.stroke();
        g.strokeStyle = '#FFFFFF'; g.lineWidth = 2;
        g.beginPath(); g.roundRect(x1 - 0.5, ly - 2, Math.max(2, x2 - x1 + 1), lh + 4, 7); g.stroke();
      }
      if (x2 - x1 > 30) drawGlyph(g, s, Math.max(x1, 0) + 16, ly + lh / 2);
    }

    // playhead (fixed at center)
    g.fillStyle = '#FFFFFF'; g.fillRect(W / 2 - 1, 0, 2, H);
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

  // ---------- Controls (CapCut style) ----------
  const timeText = h('div', { class: 'timeText' }, '');
  const playBtn = h('button', { class: 'btn iconbtn playbtn', 'aria-label': 'Play', onclick: () => setPlaying(!playing) }, icon('play')) as HTMLButtonElement;
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

  const controls = h('div', { class: 'controls cc' },
    h('div', { class: 'left' }, timeText),
    playBtn,
    h('div', { class: 'right' }, undoBtn, redoBtn, fsBtn));

  // ---------- Bottom toolbar (icons only) ----------
  type Bar = 'root' | 'layout' | 'main' | 'audio';
  let bar: Bar = 'root';
  const toolbar = h('div', { class: 'toolbar' });
  let tipEl: HTMLElement | null = null;
  function tip(label: string) {
    tipEl?.remove();
    tipEl = h('div', { class: 'tip' }, label);
    document.body.append(tipEl);
    const me = tipEl;
    setTimeout(() => me.remove(), 1000);
  }
  function tool(name: keyof typeof ICON, label: string, run: () => void, o: { sel?: boolean; cls?: string; ring?: string; disabled?: boolean } = {}) {
    const b = h('button', { class: 'tool' + (o.sel ? ' sel' : '') + (o.cls ? ' ' + o.cls : ''), 'aria-label': label, title: label, disabled: !!o.disabled,
      onclick: () => { tip(label); run(); } }, icon(name, 26));
    if (o.ring) b.append(h('i', { class: 'ring', style: `background:${o.ring}` }));
    return b;
  }
  const sepEl = () => h('div', { class: 'sep' });
  const backTool = () => h('button', { class: 'tool back', 'aria-label': 'Back', onclick: () => { bar = 'root'; renderBar(); } }, icon('back', 24));

  function selected(): Segment | undefined { return p.segments.find((s) => s.id === selectedId); }
  function select(id: string) { selectedId = id; renderBar(); draw(); }

  function edit(next: Segment[]) { hist.push(p.segments); p.segments = next; afterEdit(); }
  function afterEdit() { applyLayout(segmentAt(p.segments, playMs)); if (!selected()) selectedId = segmentAt(p.segments, playMs)?.id ?? null; renderBar(); draw(); updateBtns(); scheduleSave(); }

  function setStyle(st: LayoutStyle) {
    const s = selected() ?? segmentAt(p.segments, playMs);
    if (!s) return;
    selectedId = s.id;
    edit(updateSegment(p.segments, s.id, { style: st })); tick();
  }
  function patch(pt: Partial<Segment>) { const s = selected(); if (s) edit(updateSegment(p.segments, s.id, pt)); }

  function doAutoSwitch(useLips: boolean) {
    const motion = useLips && runtime.hostMotion && runtime.constMotion ? { host: runtime.hostMotion, constant: runtime.constMotion } : undefined;
    const segs = detectSpeakers(runtime.hostPcm!, runtime.constPcm!, p.offsetMs, p.durationMs, app.settings, p.mainAudio, motion);
    edit(segs); selectedId = segs[0]?.id ?? null; afterEdit();
    if (segs.length <= 1) toast('Could not tell the two people apart. Try the lips scan or cut by hand.');
    else if (lastUsedLips) toast(`Auto switch with lips + voice: ${segs.length} segments. Undo to go back.`);
    else if (lastMethod === 'voice') toast(`Auto switch by voice: ${segs.length} segments (quality ${lastVoiceQuality.toFixed(1)}). Wrong way round? Tap swap.`);
    else toast(`Auto switch by mic loudness: ${segs.length} segments (${lastSeparationDb.toFixed(1)} dB). Undo to go back.`);
  }

  let scanning = false, scanCancel = false;
  async function doSmartSwitch() {
    if (scanning) return;
    if (!runtime.hostMotion || !runtime.constMotion) {
      scanning = true; scanCancel = false;
      setPlaying(false);
      const pb = progressBar();
      const box = h('div', { class: 'scanbox' }, icon('lips', 22), pb.el, iconButton('close', 'Cancel scan', () => { scanCancel = true; }));
      preview.append(box);
      try {
        const dur = p.durationMs;
        const a = await scanMotion(hostV.currentSrc || hostV.src, 0, dur, (x) => pb.set(x / 2), () => scanCancel);
        const b = a ? await scanMotion(constV.currentSrc || constV.src, p.offsetMs, dur, (x) => pb.set(50 + x / 2), () => scanCancel) : null;
        if (a && b) { runtime.hostMotion = a; runtime.constMotion = b; }
      } catch { /* fall through */ }
      box.remove(); scanning = false;
      if (!runtime.hostMotion || !runtime.constMotion) {
        if (scanCancel) { toast('Scan cancelled'); return; }
        toast('Could not read the video frames for the lips scan. Using voice only.');
        doAutoSwitch(false); return;
      }
      draw();
    }
    doAutoSwitch(true);
  }

  function doSwap() {
    edit(p.segments.map((s) => ({ ...s, main: (s.main === 'host' ? 'constant' : 'host') as Role })));
  }
  function doSplit() { edit(splitAt(p.segments, playMs)); selectedId = segmentAt(p.segments, playMs)?.id ?? null; tick(); }
  function doMerge() { const s = selected(); if (s) { edit(mergeWithPrev(p.segments, s.id)); selectedId = null; afterEdit(); } }
  async function doDelete() {
    const s = selected(); if (!s || p.segments.length <= 1) { toast('Cannot delete the only segment.'); return; }
    if (await confirmDialog('Delete segment?', 'The neighbouring segment will fill the gap.')) { edit(deleteSegment(p.segments, s.id)); selectedId = null; afterEdit(); }
  }
  function openMenu() { bar = 'root'; renderBar(); tick(); }

  function setAudio(role: Role) {
    p.mainAudio = role;
    hostV.muted = role !== 'host';
    constV.muted = role !== 'constant';
    renderBar(); scheduleSave(); tick();
  }

  function renderBar() {
    const s = selected();
    const rows: Node[] = [];
    if (bar === 'root') {
      rows.push(
        tool('wand', 'Auto switch (voice)', () => doAutoSwitch(false), { cls: 'accent' }),
        tool('lips', 'Auto switch with lips (smart)', doSmartSwitch, { cls: 'accent' }),
        sepEl(),
        tool('scissors', 'Split at playhead', doSplit),
        tool('layout', 'Layout', () => { bar = 'layout'; renderBar(); }),
        tool('user', 'Who is on screen', () => { bar = 'main'; renderBar(); }),
        tool('volume', 'Audio source', () => { bar = 'audio'; renderBar(); }),
        tool('merge', 'Merge with previous', doMerge),
        tool('trash', 'Delete segment', doDelete),
        tool('swap', 'Swap Host and Constant', doSwap),
        sepEl(),
        tool('zoomOut', 'Zoom out timeline', () => { pxPerSec = Math.max(4, pxPerSec / 1.5); draw(); }),
        tool('zoomIn', 'Zoom in timeline', () => { pxPerSec = Math.min(300, pxPerSec * 1.5); draw(); }),
      );
    } else if (bar === 'layout') {
      rows.push(backTool());
      (['one', 'side', 'updown', 'popup'] as LayoutStyle[]).forEach((st) => rows.push(tool(st, STYLE_LABEL[st], () => setStyle(st), { sel: s?.style === st })));
      if (s?.style === 'popup') {
        rows.push(sepEl());
        (['tl', 'tr', 'bl', 'br'] as Corner[]).forEach((c) => rows.push(tool(({ tl: 'cTL', tr: 'cTR', bl: 'cBL', br: 'cBR' } as const)[c], `Corner ${c}`, () => patch({ corner: c }), { sel: s.corner === c })));
        rows.push(sepEl());
        (['S', 'M', 'L'] as PopupSize[]).forEach((z) => rows.push(tool(({ S: 'sizeS', M: 'sizeM', L: 'sizeL' } as const)[z], `Size ${z}`, () => patch({ size: z }), { sel: s.size === z })));
      }
    } else if (bar === 'main') {
      rows.push(backTool(),
        tool('user', 'Host on screen', () => patch({ main: 'host' as Role }), { sel: s?.main === 'host', cls: 'person host', disabled: !s || s.style === 'side' || s.style === 'updown' }),
        tool('user', 'Constant on screen', () => patch({ main: 'constant' as Role }), { sel: s?.main === 'constant', cls: 'person const', disabled: !s || s.style === 'side' || s.style === 'updown' }),
        sepEl(),
        tool('swap', 'Swap Host and Constant', doSwap));
    } else {
      rows.push(backTool(),
        tool('volume', 'Use Host audio', () => setAudio('host'), { sel: p.mainAudio === 'host', ring: '#FFFFFF' }),
        tool('volume', 'Use Constant audio', () => setAudio('constant'), { sel: p.mainAudio === 'constant', ring: '#22C55E' }));
    }
    toolbar.replaceChildren(...rows);
  }
  function updateBtns() { undoBtn.disabled = !hist.canUndo; redoBtn.disabled = !hist.canRedo; }

  function scheduleSave() { clearTimeout(saveTimer); saveTimer = window.setTimeout(() => saveProject(p), 600); }

  // ---------- Main loop ----------
  function refresh(followVideo: boolean) {
    if (followVideo) playMs = hostV.currentTime * 1000;
    const seg = segmentAt(p.segments, playMs);
    if (seg && seg.id !== lastSegId) { lastSegId = seg.id; }
    applyLayout(seg);
    timeText.innerHTML = `<b>${fmtTime(playMs)}</b> / ${fmtTime(p.durationMs)}`;
    draw();
  }
  function loop() {
    if (playing) {
      playMs = playBase + (performance.now() - playWall);
      if (playMs >= p.durationMs - 30) { playMs = p.durationMs; setPlaying(false); refresh(false); }
      else { refresh(false); syncVideos(false); }
    }
    raf = requestAnimationFrame(loop);
  }

  const proj = h('h1', {}, p.name);
  const el = h('div', { class: 'screen' },
    h('div', { class: 'topbar ed' },
      iconButton('back', 'Back', () => { saveProject(p); app.go('home'); }),
      proj,
      h('button', { class: 'exportbtn', 'aria-label': 'Export', title: 'Export', onclick: () => { setPlaying(false); saveProject(p); app.go('export'); } }, icon('export', 20))),
    preview, controls, tl, toolbar);

  requestAnimationFrame(() => {
    selectedId = segmentAt(p.segments, 0)?.id ?? null;
    renderBar(); updateBtns();
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
