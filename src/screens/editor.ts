import { app, type Intent } from '../app';
import { peaks, PEAKS_PER_SEC } from '../core/audio';
import { detectSpeakers, lastMethod, lastSeparationDb, lastUsedLips, lastVoiceQuality } from '../core/speaker';
import { motionToActivity, scanMotion } from '../core/motion';
import { History, runtime, saveProject, saveSettings, type Snapshot } from '../core/store';
import { detectSilence } from '../core/silence';
import { fileSrc, isNative, tick } from '../core/native';
import { ensureAudio, nextPaint, runAutoSwitch, runSync } from '../core/pipeline';
import { ensureProxy, needsProxy } from '../core/proxy';
import { makeStrip, type Strip } from '../core/thumbs';
import { endTask, onTasks, startTask, updateTask, type Task } from '../core/tasks';
import {
  coverage, defaultSegments, deleteSegment, dropSlivers, fitSegmentsToDuration, intersectRanges, isKept, keptMs, mergeWithPrev,
  moveBoundary, nextKeptStart, overlapDuration, segmentAt, splitAt, subtractRanges, updateSegment, type Range,
} from '../core/timeline';
import { Aspect, ASPECTS, aspectValue, Corner, CropState, LayoutStyle, NO_CROP, PopupSize, Role, Segment, segmentColor, SilenceSens, STYLE_LABEL } from '../core/types';
import { actionSheet, confirmDialog, fmtClock, h, ICON, icon, iconButton, progressBar, spinner, toast } from '../ui';

type Panel = 'none' | 'ratio' | 'crop' | 'silence' | 'sync' | 'layout' | 'main' | 'audio';

// ---- timeline geometry (CSS px) ----
const G = 46;            // left column with the lane icons (like CapCut)
const RULER = 26;
const LANE = 44;         // one video clip row
const LAY = 36;          // layout row
const GAP = 4;
const HOST_Y = RULER + GAP;
const CONST_Y = HOST_Y + LANE + GAP;
const LAY_Y = CONST_Y + LANE + GAP;
const TL_H = LAY_Y + LAY + 8;
const CYAN = '#19e6c1';

export function editorScreen() {
  const p = app.project;
  const hist = new History();
  let playMs = 0;
  let playing = false;
  let selectedId: string | null = null;
  let selClip: Role | null = null;
  let pxPerSec = 30;
  let raf = 0;
  let saveTimer = 0;
  let destroyed = false;
  let syncReady = p.segments.length > 0;
  let hasAudioError = false;

  if (!runtime.hostUrl || !runtime.constUrl || !p.host || !p.constant) {
    return { el: h('div', { class: 'screen' }, h('div', { class: 'content' }, h('div', { class: 'err' }, 'Videos are not loaded. Go back and add them again.'), h('button', { class: 'btn', onclick: () => app.go('import') }, 'Add videos'))) };
  }
  const hostDur = p.host.durationMs, constDur = p.constant.durationMs;
  if (!p.durationMs) p.durationMs = overlapDuration(hostDur, constDur, p.offsetMs);

  // waveforms appear when the audio has been read (they are not saved with the project)
  let hostPeaks: Float32Array | undefined;
  let constPeaks: Float32Array | undefined;
  const audioReady = () => !!(runtime.hostPcm && runtime.constPcm);
  function computePeaks() {
    if (runtime.hostPcm) hostPeaks = peaks(runtime.hostPcm, Math.ceil((runtime.hostPcm.length / 16000) * PEAKS_PER_SEC));
    if (runtime.constPcm) constPeaks = peaks(runtime.constPcm, Math.ceil((runtime.constPcm.length / 16000) * PEAKS_PER_SEC));
  }
  computePeaks();

  // ======================================================================= Preview
  const hostV = h('video', { playsInline: true, preload: 'auto', 'aria-label': 'Host video' }) as HTMLVideoElement;
  const constV = h('video', { playsInline: true, preload: 'auto', 'aria-label': 'Constant video' }) as HTMLVideoElement;
  hostV.muted = p.mainAudio !== 'host';
  constV.muted = p.mainAudio !== 'constant';
  const hostCell = h('div', { class: 'cell' }, hostV);
  const constCell = h('div', { class: 'cell' }, constV);
  const stage = h('div', { class: 'stage' }, hostCell, constCell);
  const guideV = h('div', { class: 'guide v' });
  const guideH = h('div', { class: 'guide h' });
  const pillsEl = h('div', { class: 'pills' });
  const preview = h('div', { class: 'preview' }, stage, guideV, guideH, pillsEl);

  /** Fit the stage (project aspect ratio) inside the preview area, like a real editor. */
  function fitStage() {
    const full = stage.classList.contains('full');
    const cw = full ? window.innerWidth : preview.clientWidth;
    const ch = full ? window.innerHeight : preview.clientHeight;
    if (!cw || !ch) return;
    const ar = aspectValue(p.aspect);
    const w = Math.min(cw, ch * ar);
    stage.style.width = `${Math.floor(w)}px`;
    stage.style.height = `${Math.floor(w / ar)}px`;
  }
  const ro = new ResizeObserver(() => { fitStage(); layoutCrop(); });
  ro.observe(preview);

  /** Crop = zoom + move inside the frame. Same math is used by the exporter. */
  function applyCrop(role: Role) {
    const c = role === 'host' ? p.cropHost : p.cropConst;
    const v = role === 'host' ? hostV : constV;
    const z = Math.max(1, c.zoom);
    v.style.transform = z <= 1.001 ? '' : `translate(${c.x * (z - 1) * 50}%, ${c.y * (z - 1) * 50}%) scale(${z})`;
  }
  applyCrop('host'); applyCrop('constant');

  const POP: Record<PopupSize, number> = { S: 24, M: 32, L: 42 };
  function place(v: HTMLElement, x: number, y: number, w: number, hh: number, pop = false) {
    v.style.display = 'block';
    v.style.left = `${x}%`; v.style.top = `${y}%`; v.style.width = `${w}%`; v.style.height = `${hh}%`;
    v.style.zIndex = pop ? '2' : '1';
    v.classList.toggle('pop', pop);
  }
  function hide(v: HTMLElement) { v.style.display = 'none'; }

  function applyLayout(seg: Segment | undefined) {
    if (!seg) { place(hostCell, 0, 0, 100, 100); hide(constCell); return; } // nothing decided yet: show the Host
    const main = seg.main === 'host' ? hostCell : constCell;
    const other = seg.main === 'host' ? constCell : hostCell;
    if (seg.style === 'one') { place(main, 0, 0, 100, 100); hide(other); }
    else if (seg.style === 'side') { place(hostCell, 0, 0, 50, 100); place(constCell, 50, 0, 50, 100); }
    else if (seg.style === 'updown') { place(hostCell, 0, 0, 100, 50); place(constCell, 0, 50, 100, 50); }
    else {
      place(main, 0, 0, 100, 100);
      const w = POP[seg.size];
      const heightPct = w; // the small box has the same shape as the stage, so height% == width%
      const m = 3;
      const x = seg.corner === 'tl' || seg.corner === 'bl' ? m : 100 - w - m;
      const y = seg.corner === 'tl' || seg.corner === 'tr' ? m * 1.6 : 100 - heightPct - m * 1.6;
      place(other, x, y, w, heightPct, true);
    }
  }

  // ---------- video sources: original, or a small preview copy when the phone's format is heavy ----------
  const ready: Record<Role, boolean> = { host: false, constant: false };
  const failed: Record<Role, boolean> = { host: false, constant: false };
  const proxying: Record<Role, boolean> = { host: false, constant: false };
  const usingProxy: Record<Role, boolean> = { host: false, constant: false };
  const vid = (r: Role) => (r === 'host' ? hostV : constV);
  const label = (r: Role) => (r === 'host' ? 'Host' : 'Constant');

  function setSource(role: Role, url: string) {
    const v = vid(role);
    ready[role] = false;
    v.src = url;
    v.load();
    v.addEventListener('loadedmetadata', () => {
      ready[role] = true;
      if (!destroyed) { seekVideo(v, role === 'host' ? playMs / 1000 : (playMs + p.offsetMs) / 1000); updatePlayState(); requestDraw(); }
    }, { once: true });
  }

  /** Make the small preview copy (shows a pill), then switch that video to it. Keeps the play position. */
  async function useProxy(role: Role, wasPlaying = false) {
    const path = role === 'host' ? runtime.hostPath : runtime.constPath;
    const meta = role === 'host' ? p.host : p.constant;
    if (!path || proxying[role]) return;
    proxying[role] = true;
    const id = `proxy-${role}`;
    startTask(id, `Optimizing ${label(role)} preview`, 0);
    try {
      const url = await ensureProxy(path, meta, (n) => updateTask(id, undefined, n));
      if (destroyed) return;
      usingProxy[role] = true;
      if (role === 'host') p.proxyHost = true; else p.proxyConst = true;
      scheduleSave();
      setSource(role, url);
      if (wasPlaying) vid(role).addEventListener('loadedmetadata', () => { if (!destroyed) setPlaying(true); }, { once: true });
    } catch (e) {
      failed[role] = true;
      ready[role] = true; // do not block playing forever
      toast(`${label(role)} video: could not make a smooth preview. ${(e as Error).message || ''}`.trim());
    } finally {
      proxying[role] = false;
      endTask(id);
      if (!destroyed) updatePlayState();
    }
  }

  function startSource(role: Role) {
    const meta = role === 'host' ? p.host : p.constant;
    const flagged = role === 'host' ? p.proxyHost : p.proxyConst;
    const url = role === 'host' ? runtime.hostUrl! : runtime.constUrl!;
    const v = vid(role);
    v.addEventListener('error', () => {
      if (destroyed) return;
      if (isNative() && !usingProxy[role] && !proxying[role]) {
        // the WebView could not play it (or stopped halfway): pause cleanly, make a preview copy, carry on where we were
        const was = playing;
        if (playing) setPlaying(false);
        useProxy(role, was);
      } else if (!proxying[role] && !failed[role]) {
        failed[role] = true; ready[role] = true; updatePlayState();
        toast(`${label(role)} video cannot be played in the preview. Export may still work.`);
      }
    });
    if (isNative() && (flagged || needsProxy(meta))) useProxy(role); // before playing: no stall in the middle of a video
    else setSource(role, url);
  }

  // ---------- seeking (never queue seeks: only the latest one counts) ----------
  const pendingSeek = new Map<HTMLVideoElement, number>();
  function seekVideo(v: HTMLVideoElement, t: number) {
    if (!isFinite(t) || t < 0) return;
    const dur = isFinite(v.duration) ? v.duration : Infinity;
    t = Math.min(t, Math.max(0, dur - 0.05));
    if (v.readyState < 1) return; // metadata not there yet; loadedmetadata seeks again
    if (v.seeking) { pendingSeek.set(v, t); return; }
    try { v.currentTime = t; } catch { /* ignore */ }
  }
  for (const v of [hostV, constV]) {
    v.addEventListener('seeked', () => {
      const t = pendingSeek.get(v);
      if (t === undefined) return;
      pendingSeek.delete(v);
      try { v.currentTime = t; } catch { /* ignore */ }
    });
  }

  let lastConstSeek = 0;
  /** Keep the Constant video on its sync position. While playing, only correct real drift. */
  function syncConst(force = false) {
    const ct = (playMs + p.offsetMs) / 1000;
    const inRange = ct >= 0 && ct < (isFinite(constV.duration) ? constV.duration : Infinity);
    constV.style.visibility = inRange ? '' : 'hidden';
    if (!inRange) { if (!constV.paused) constV.pause(); return; }
    const now = performance.now();
    const drift = Math.abs(constV.currentTime - ct);
    if (force || (drift > (playing ? 0.35 : 0.05) && now - lastConstSeek > 700)) { lastConstSeek = now; seekVideo(constV, ct); }
    if (playing && constV.paused && ready.constant) constV.play().catch(() => {});
  }
  function syncHost(force = false) {
    const t = playMs / 1000;
    if (force || Math.abs(hostV.currentTime - t) > 0.05) seekVideo(hostV, t);
  }

  const firstStart = () => (p.segments.length ? Math.min(...p.segments.map((s) => s.startMs)) : 0);
  const lastEnd = () => (p.segments.length ? Math.max(...p.segments.map((s) => s.endMs)) : p.durationMs);

  function playReason(): string | null {
    if (!syncReady) return 'Still syncing the two videos...';
    if (!ready.host || (!ready.constant && !failed.constant)) {
      return proxying.host || proxying.constant ? 'Still preparing the preview...' : 'The videos are still loading...';
    }
    return null;
  }

  function setPlaying(on: boolean) {
    if (on && playReason()) { toast(playReason()!); on = false; }
    playing = on;
    if (on) {
      if (playMs >= lastEnd() - 50) playMs = firstStart();
      if (!isKept(p.segments, playMs) && p.segments.length) { const nx = nextKeptStart(p.segments, playMs); if (nx !== null) playMs = nx; }
      syncHost(true); syncConst(true);
      hostV.play().catch(() => {});
    } else { hostV.pause(); constV.pause(); }
    updatePlayState();
  }

  function seek(ms: number) {
    playMs = Math.max(0, Math.min(p.durationMs, ms));
    syncHost(true); syncConst(true);
    refresh();
  }

  // ---------- pills over the preview (like CapCut's "Applying 2 features") ----------
  let offTasks: () => void = () => {};

  /** Small picture for the Home screen. */
  function captureThumb() {
    try {
      if (!hostV.videoWidth) return;
      const c = document.createElement('canvas'); c.width = 240; c.height = 240;
      const g = c.getContext('2d')!;
      const s = Math.min(hostV.videoWidth, hostV.videoHeight);
      g.drawImage(hostV, (hostV.videoWidth - s) / 2, (hostV.videoHeight - s) / 2, s, s, 0, 0, 240, 240);
      p.thumb = c.toDataURL('image/jpeg', 0.6);
      scheduleSave();
    } catch { /* thumbnail is optional */ }
  }
  if (!p.thumb) hostV.addEventListener('loadeddata', () => window.setTimeout(captureThumb, 500), { once: true });

  // ======================================================================= Timeline canvas
  const canvas = h('canvas') as HTMLCanvasElement;
  const tl = h('div', { class: 'timeline' }, canvas);
  tl.style.height = `${TL_H}px`;
  let W = 0, H = 0;
  let pendingCuts: Range[] = [];
  let snapMs: number | null = null; // cyan guide while a clip snaps

  let hostStrip: Strip | undefined, constStrip: Strip | undefined;
  let drawQueued = false;
  function requestDraw() { if (drawQueued || destroyed) return; drawQueued = true; requestAnimationFrame(() => { drawQueued = false; draw(); }); }

  const xOf = (ms: number) => W / 2 + ((ms - playMs) / 1000) * pxPerSec;
  const msOf = (x: number) => playMs + ((x - W / 2) / pxPerSec) * 1000;
  const minPx = () => Math.max(0.4, ((W || 360) * 0.9) / Math.max(1, p.durationMs / 1000));

  function rrect(g: CanvasRenderingContext2D, x: number, y: number, w: number, hh: number, r: number) {
    g.beginPath(); g.roundRect(x, y, Math.max(1, w), hh, r);
  }

  /** One video clip: picture strip, waveform, name. `x1` = where the video's own 0:00 sits on the timeline. */
  function drawClip(g: CanvasRenderingContext2D, role: Role, x1: number, y: number, durMs: number, strip: Strip | undefined, arr: Float32Array | undefined, color: string) {
    const x2 = x1 + (durMs / 1000) * pxPerSec;
    if (x2 < G || x1 > W) return;
    const vx1 = Math.max(x1, G), vx2 = Math.min(x2, W);
    g.save();
    rrect(g, x1, y, x2 - x1, LANE, 6); g.clip();
    g.fillStyle = role === 'host' ? '#1d1d1d' : '#14231a'; g.fillRect(x1, y, x2 - x1, LANE);
    // picture strip
    if (strip) {
      const tw = Math.max(20, Math.round(LANE * strip.aspect));
      const k0 = Math.max(0, Math.floor((vx1 - x1) / tw)), k1 = Math.floor((vx2 - x1) / tw);
      for (let k = k0; k <= k1; k++) {
        const tMs = ((k + 0.5) * tw / pxPerSec) * 1000;
        const idx = Math.max(0, Math.min(strip.count - 1, Math.floor((tMs / durMs) * strip.count)));
        const img = strip.frames[idx] ?? strip.frames.find((f) => !!f);
        if (img) { g.globalAlpha = strip.frames[idx] ? 1 : 0.45; g.drawImage(img, x1 + k * tw, y, tw, LANE); g.globalAlpha = 1; }
      }
    }
    // darken the lower half so the waveform reads on top of pictures
    const grad = g.createLinearGradient(0, y + LANE * 0.35, 0, y + LANE);
    grad.addColorStop(0, 'rgba(0,0,0,0)'); grad.addColorStop(1, 'rgba(0,0,0,.72)');
    g.fillStyle = grad; g.fillRect(x1, y, x2 - x1, LANE);
    // waveform (bars grow up from the bottom, like CapCut audio)
    if (arr) {
      g.fillStyle = color;
      for (let x = Math.floor(vx1); x < vx2; x += 2) {
        const localMs = ((x - x1) / pxPerSec) * 1000;
        const v = arr[Math.round((localMs / 1000) * PEAKS_PER_SEC)];
        if (v === undefined) continue;
        const bh = Math.max(1, v * LANE * 0.5);
        g.fillRect(x, y + LANE - 3 - bh, 1.5, bh);
      }
    }
    // name + length
    g.font = '600 10px Roboto, sans-serif'; g.textBaseline = 'top';
    g.fillStyle = 'rgba(0,0,0,.55)';
    const txt = `${role === 'host' ? 'Host' : 'Constant'}  ${fmtClock(durMs)}`;
    const tx = Math.max(x1, G) + 6;
    g.fillRect(tx - 3, y + 3, g.measureText(txt).width + 6, 14);
    g.fillStyle = '#fff'; g.fillText(txt, tx, y + 5);
    g.restore();
    g.strokeStyle = 'rgba(255,255,255,.16)'; g.lineWidth = 1;
    rrect(g, x1 + 0.5, y + 0.5, x2 - x1 - 1, LANE - 1, 6); g.stroke();
    if (selClip === role) {
      g.strokeStyle = '#fff'; g.lineWidth = 2;
      rrect(g, x1 + 1, y + 1, x2 - x1 - 2, LANE - 2, 6); g.stroke();
    }
  }

  function drawGlyph(g: CanvasRenderingContext2D, s: Segment, cx: number, cy: number) {
    g.save(); g.translate(cx, cy); g.scale(0.62, 0.62); cx = 0; cy = 0;
    g.fillStyle = '#000000'; g.strokeStyle = '#000000'; g.lineWidth = 2;
    if (s.style === 'one') {
      g.beginPath(); g.arc(cx, cy - 4, 4, 0, 6.3); g.fill();
      g.beginPath(); g.arc(cx, cy + 10, 8, Math.PI, 0); g.fill();
    } else if (s.style === 'side') { g.fillRect(cx - 9, cy - 6, 8, 12); g.fillRect(cx + 1, cy - 6, 8, 12); }
    else if (s.style === 'updown') { g.fillRect(cx - 8, cy - 9, 16, 8); g.fillRect(cx - 8, cy + 1, 16, 8); }
    else { g.strokeRect(cx - 9, cy - 6, 18, 12); g.fillRect(cx + 1, cy + 1, 7, 4); }
    g.restore();
  }

  let actSrc: [Float32Array | undefined, Float32Array | undefined] = [undefined, undefined];
  let actH: Float32Array | undefined, actC: Float32Array | undefined;
  function drawMotion(g: CanvasRenderingContext2D) {
    if (!runtime.hostMotion || !runtime.constMotion) return;
    if (actSrc[0] !== runtime.hostMotion || actSrc[1] !== runtime.constMotion) {
      actSrc = [runtime.hostMotion, runtime.constMotion];
      actH = motionToActivity(runtime.hostMotion); actC = motionToActivity(runtime.constMotion);
    }
    const bars = (arr: Float32Array, y: number) => {
      g.fillStyle = 'rgba(245,158,11,.9)';
      for (let x = G; x < W; x += 3) {
        const ms = msOf(x); if (ms < 0 || ms > p.durationMs) continue;
        const v = Math.max(0, Math.min(1.5, arr[Math.round(ms / 100)] ?? 0)) / 1.5;
        const bh = v * LANE * 0.35; if (bh > 0.5) g.fillRect(x, y + LANE - 2 - bh, 2, bh);
      }
    };
    bars(actH!, HOST_Y); bars(actC!, CONST_Y);
  }

  const personGlyph = (g: CanvasRenderingContext2D, cx: number, cy: number, color: string) => {
    g.fillStyle = color;
    g.beginPath(); g.arc(cx, cy - 4, 4, 0, 6.3); g.fill();
    g.beginPath(); g.arc(cx, cy + 9, 7.5, Math.PI, 0); g.fill();
  };
  const speakerGlyph = (g: CanvasRenderingContext2D, cx: number, cy: number, color: string, on: boolean) => {
    g.fillStyle = color; g.strokeStyle = color; g.lineWidth = 1.5; g.lineCap = 'round';
    g.beginPath(); g.moveTo(cx - 5, cy - 2.5); g.lineTo(cx - 2, cy - 2.5); g.lineTo(cx + 1.5, cy - 5.5); g.lineTo(cx + 1.5, cy + 5.5); g.lineTo(cx - 2, cy + 2.5); g.lineTo(cx - 5, cy + 2.5); g.closePath(); g.fill();
    if (on) { g.beginPath(); g.arc(cx + 2, cy, 4.5, -0.9, 0.9); g.stroke(); }
    else { g.beginPath(); g.moveTo(cx + 4, cy - 3.5); g.lineTo(cx + 9, cy + 3.5); g.moveTo(cx + 9, cy - 3.5); g.lineTo(cx + 4, cy + 3.5); g.stroke(); }
  };

  const stepFor = () => [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600].find((s) => s * pxPerSec >= 72) ?? 3600;

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const cw = tl.clientWidth, ch = tl.clientHeight;
    if (!cw || !ch) return;
    if (W !== cw || H !== ch || canvas.width !== Math.round(cw * dpr)) { W = cw; H = ch; canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
    const g = canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    // ---- ruler: 00:00 • 00:01 • (labels with a dot half way)
    const step = stepFor();
    const startS = Math.max(0, Math.floor(msOf(G) / 1000 / step) * step - step);
    g.font = '10px Roboto, sans-serif'; g.textBaseline = 'middle';
    for (let s = startS; s * 1000 <= Math.min(p.durationMs + step * 1000, msOf(W)); s += step) {
      const x = xOf(s * 1000);
      g.fillStyle = '#8a8a8a'; g.fillText(fmtClock(s * 1000), x + 3, RULER / 2);
      g.fillRect(x, RULER - 6, 1, 6);
      const mx = x + (step * pxPerSec) / 2;
      g.beginPath(); g.arc(mx, RULER / 2, 1.4, 0, 6.3); g.fill();
    }

    // ---- clips. Host starts at 0. Constant starts where its own 0:00 lands: -offset.
    drawClip(g, 'host', xOf(0), HOST_Y, hostDur, hostStrip, hostPeaks, 'rgba(255,255,255,.9)');
    drawClip(g, 'constant', xOf(-p.offsetMs), CONST_Y, constDur, constStrip, constPeaks, '#4ade80');
    drawMotion(g);

    // ---- layout lane
    g.fillStyle = '#0d0d0d'; g.fillRect(G, LAY_Y, W - G, LAY);
    {
      const kept = coverage(p.segments);
      const holes: Range[] = [];
      let at = 0;
      for (const r of kept) { if (r.startMs > at) holes.push({ startMs: at, endMs: r.startMs }); at = r.endMs; }
      if (kept.length && at < p.durationMs) holes.push({ startMs: at, endMs: p.durationMs });
      for (const r of holes) {
        const x1 = Math.max(G, xOf(r.startMs)), x2 = Math.min(W, xOf(r.endMs));
        if (x2 - x1 < 2) continue;
        g.save(); g.beginPath(); g.rect(x1, LAY_Y, x2 - x1, LAY); g.clip();
        g.strokeStyle = '#3a3a3a'; g.lineWidth = 1;
        for (let k = x1 - LAY; k < x2; k += 6) { g.beginPath(); g.moveTo(k, LAY_Y + LAY); g.lineTo(k + LAY, LAY_Y); g.stroke(); }
        g.restore();
      }
    }
    for (const s of p.segments) {
      const x1 = xOf(s.startMs), x2 = xOf(s.endMs);
      if (x2 < G || x1 > W) continue;
      g.fillStyle = segmentColor(s);
      rrect(g, x1 + 0.5, LAY_Y + 1, x2 - x1 - 1, LAY - 2, 6); g.fill();
      if (s.id === selectedId) {
        g.strokeStyle = '#FFFFFF'; g.lineWidth = 2;
        rrect(g, x1 + 1, LAY_Y + 1, x2 - x1 - 2, LAY - 2, 6); g.stroke();
      }
      if (x2 - x1 > 24) drawGlyph(g, s, Math.max(x1, G) + 14, LAY_Y + LAY / 2);
    }

    // silence found but not cut yet
    if (pendingCuts.length) {
      g.fillStyle = 'rgba(239,68,68,.38)';
      for (const r of pendingCuts) {
        const x1 = Math.max(G, xOf(r.startMs)), x2 = Math.min(W, xOf(r.endMs));
        if (x2 > x1) g.fillRect(x1, HOST_Y, x2 - x1, LAY_Y + LAY - HOST_Y);
      }
    }

    // sync snap guide
    if (snapMs !== null) {
      const sx = xOf(snapMs);
      g.fillStyle = CYAN; g.fillRect(sx - 0.75, HOST_Y - 2, 1.5, LANE * 2 + GAP + 4);
    }

    // ---- left column (lane icons), drawn over the clips
    g.fillStyle = '#000'; g.fillRect(0, RULER, G, H - RULER);
    g.fillStyle = '#262626'; g.fillRect(G - 1, RULER, 1, H - RULER);
    const audioHost = p.mainAudio === 'host';
    personGlyph(g, 14, HOST_Y + LANE / 2 - 1, '#ffffff');
    speakerGlyph(g, 34, HOST_Y + LANE / 2, audioHost ? '#ffffff' : '#666', audioHost);
    personGlyph(g, 14, CONST_Y + LANE / 2 - 1, '#4ade80');
    speakerGlyph(g, 34, CONST_Y + LANE / 2, !audioHost ? '#4ade80' : '#666', !audioHost);
    g.strokeStyle = '#d6d6d6'; g.fillStyle = '#d6d6d6'; g.lineWidth = 1.6;
    const lx = 16, ly = LAY_Y + LAY / 2;
    g.strokeRect(lx - 7, ly - 7, 6, 6); g.strokeRect(lx + 1, ly - 7, 6, 6); g.strokeRect(lx - 7, ly + 1, 6, 6); g.strokeRect(lx + 1, ly + 1, 6, 6);

    // ---- time (top left, like CapCut): 00:34 / 10:22
    const cur = fmtClock(playMs), tot = ` / ${fmtClock(p.durationMs)}`;
    const kept = keptMs(p.segments);
    const note = p.segments.length && p.durationMs - kept > 500 ? `  (${fmtClock(kept)} kept)` : '';
    g.font = '11px Roboto, sans-serif';
    const wCur = g.measureText(cur).width, wTot = g.measureText(tot).width, wNote = g.measureText(note).width;
    g.fillStyle = '#000'; g.fillRect(0, 0, 12 + wCur + wTot + wNote, RULER);
    g.textBaseline = 'middle';
    g.fillStyle = '#fff'; g.fillText(cur, 8, RULER / 2);
    g.fillStyle = '#8a8a8a'; g.fillText(tot + note, 8 + wCur, RULER / 2);

    // ---- playhead (fixed at the center)
    g.fillStyle = '#FFFFFF'; g.fillRect(W / 2 - 1, 0, 2, H);
  }

  // ======================================================================= Gestures
  type Ptr = { x: number; y: number };
  const ptrs = new Map<number, Ptr>();
  let mode: 'none' | 'scrub' | 'boundary' | 'pinch' | 'clip' = 'none';
  let startX = 0, startY = 0, startT = 0, moved = false, boundaryIdx = -1, pinchDist = 0, pinchZoom = 0, lpTimer = 0;
  let clipStartMs0 = 0, clipPushed = false, clipBefore: Snapshot | null = null;

  const localX = (e: PointerEvent) => e.clientX - tl.getBoundingClientRect().left;
  const localY = (e: PointerEvent) => e.clientY - tl.getBoundingClientRect().top;
  type Lane = 'ruler' | 'host' | 'const' | 'lay' | 'none';
  function laneAt(y: number): Lane {
    if (y < RULER) return 'ruler';
    if (y < HOST_Y + LANE + GAP / 2) return 'host';
    if (y < CONST_Y + LANE + GAP / 2) return 'const';
    if (y < LAY_Y + LAY + 6) return 'lay';
    return 'none';
  }
  function hitSegment(x: number): Segment | undefined {
    const ms = msOf(x);
    return p.segments.find((s) => ms >= s.startMs && ms < s.endMs);
  }
  function hitBoundary(x: number, y: number): number {
    if (y < LAY_Y - 8 || y > LAY_Y + LAY + 8) return -1;
    for (let i = 0; i < p.segments.length - 1; i++) {
      if (Math.abs(p.segments[i].endMs - p.segments[i + 1].startMs) > 1) continue; // cut part between them
      if (Math.abs(xOf(p.segments[i].endMs) - x) < 16) return i;
    }
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
    const lane = laneAt(startY);
    const bi = startX >= G ? hitBoundary(startX, startY) : -1;
    if (bi >= 0) { mode = 'boundary'; boundaryIdx = bi; hist.push(snap()); }
    else if (lane === 'const' && selClip === 'constant' && startX >= G) {
      // the green clip is selected: dragging it moves it (that is how you sync by hand)
      mode = 'clip'; clipStartMs0 = -p.offsetMs; clipPushed = false; clipBefore = structuredClone(snap());
    }
    else mode = 'scrub';
    clearTimeout(lpTimer);
    lpTimer = window.setTimeout(() => {
      if (moved || mode !== 'scrub' || laneAt(startY) !== 'lay' || startX < G) return;
      const s = hitSegment(startX);
      if (s) { selectSeg(s.id); tick(); }
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
      pxPerSec = Math.max(minPx(), Math.min(300, pinchZoom * (d / (pinchDist || 1))));
      draw(); return;
    }
    if (Math.abs(x - startX) > 8) { moved = true; clearTimeout(lpTimer); }
    if (mode === 'scrub') {
      playMs = Math.max(0, Math.min(p.durationMs, playMs - ((x - prev.x) / pxPerSec) * 1000));
      syncHost(true); syncConst(true);
      refresh();
    } else if (mode === 'boundary') {
      p.segments = moveBoundary(p.segments, boundaryIdx, msOf(x));
      applyLayout(segmentAt(p.segments, playMs));
      draw();
    } else if (mode === 'clip' && moved) {
      if (!clipPushed) { clipPushed = true; hist.push(clipBefore!); }
      let start = clipStartMs0 + ((x - startX) / pxPerSec) * 1000;
      // snap: Constant start = Host start, = playhead, or both videos end together
      const thr = (8 / pxPerSec) * 1000;
      snapMs = null;
      for (const c of [0, playMs, hostDur - constDur]) {
        if (Math.abs(c - start) <= thr) { if (snapMs !== c) tick(); start = c; snapMs = c; break; }
      }
      p.offsetMs = Math.round(-start);
      syncConst(true);
      draw();
      renderPanelSoft();
    }
  });

  const end = (e: PointerEvent) => {
    ptrs.delete(e.pointerId);
    clearTimeout(lpTimer);
    if (ptrs.size === 1 && mode === 'pinch') { mode = 'none'; return; }
    if (ptrs.size > 0) return;
    if (mode === 'scrub' && !moved && Date.now() - startT < 400) onTap(startX, startY);
    if (mode === 'boundary') scheduleSave();
    if (mode === 'clip') {
      snapMs = null;
      if (clipPushed) commitOffset(clipBefore!.durationMs);
      draw();
    }
    mode = 'none';
  };
  tl.addEventListener('pointerup', end);
  tl.addEventListener('pointercancel', end);

  function onTap(x: number, y: number) {
    const lane = laneAt(y);
    if (x < G) {
      // left column: tap the speaker to use that video's sound
      if (lane === 'host') setAudio('host');
      else if (lane === 'const') setAudio('constant');
      return;
    }
    if (lane === 'lay' || lane === 'ruler' || lane === 'none') {
      const s = lane === 'lay' ? hitSegment(x) : undefined;
      if (s) { if (panel !== 'none') closePanel(); selectSeg(s.id); tick(); }
      else if (lane !== 'ruler') { selClip = null; selectedId = null; renderBar(); draw(); }
      return;
    }
    // a video clip: tap selects it; tapping the green clip opens Sync
    if (lane === 'const') {
      const cx1 = xOf(-p.offsetMs), cx2 = cx1 + (constDur / 1000) * pxPerSec;
      if (x >= cx1 && x <= cx2) { selClip = 'constant'; selectedId = null; tick(); openPanel('sync'); return; }
    } else {
      const hx2 = xOf(0) + (hostDur / 1000) * pxPerSec;
      if (x >= xOf(0) && x <= hx2) { if (panel !== 'none') closePanel(); selClip = 'host'; selectedId = null; renderBar(); draw(); tick(); return; }
    }
    selClip = null; renderBar(); draw();
  }

  // ======================================================================= Controls (CapCut layout)
  const playBtn = h('button', { class: 'playbtn', 'aria-label': 'Play', onclick: () => setPlaying(!playing) }) as HTMLButtonElement;
  const undoBtn = iconButton('undo', 'Undo', () => { const r = hist.undo(snap()); if (r) restore(r); });
  const redoBtn = iconButton('redo', 'Redo', () => { const r = hist.redo(snap()); if (r) restore(r); });
  const fsBtn = iconButton('full', 'Full screen preview', () => {
    stage.classList.toggle('full');
    fitStage();
    if (stage.classList.contains('full')) {
      stage.addEventListener('click', exitFull, { once: true });
      (screen.orientation as any)?.lock?.('landscape').catch(() => {});
    }
  });
  function exitFull() { stage.classList.remove('full'); fitStage(); (screen.orientation as any)?.unlock?.(); }

  function updatePlayState() {
    const busy = !!playReason();
    playBtn.classList.toggle('wait', busy && !playing);
    playBtn.replaceChildren(busy && !playing ? spinner(22) : icon(playing ? 'pause' : 'play', 24));
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  const controls = h('div', { class: 'edcontrols' },
    h('div', { class: 'left' }, fsBtn),
    playBtn,
    h('div', { class: 'right' }, undoBtn, redoBtn));

  // ---------- history ----------
  const snap = (): Snapshot => ({ segments: p.segments, offsetMs: p.offsetMs, durationMs: p.durationMs });
  function restore(s: Snapshot) {
    p.segments = s.segments; p.offsetMs = s.offsetMs; p.durationMs = s.durationMs;
    playMs = Math.min(playMs, p.durationMs);
    syncHost(true); syncConst(true);
    afterEdit();
  }
  function edit(next: Segment[]) { hist.push(snap()); p.segments = next; afterEdit(); }
  function afterEdit() {
    applyLayout(segmentAt(p.segments, playMs));
    if (!selected()) selectedId = selClip ? null : segmentAt(p.segments, playMs)?.id ?? null;
    renderBar(); refresh(); updateBtns(); scheduleSave();
    if (panel === 'sync') renderPanel();
  }
  function updateBtns() { undoBtn.disabled = !hist.canUndo; redoBtn.disabled = !hist.canRedo; }

  /** The offset changed (drag, nudge, auto sync): the edit gets longer or shorter, so the segments follow. */
  function commitOffset(oldDuration: number) {
    const nd = overlapDuration(hostDur, constDur, p.offsetMs);
    p.segments = fitSegmentsToDuration(p.segments, oldDuration, nd);
    p.durationMs = nd;
    playMs = Math.min(playMs, nd);
    if (!selected() && !selClip) selectedId = segmentAt(p.segments, playMs)?.id ?? null;
    syncConst(true);
    updateBtns(); scheduleSave(); refresh();
    if (panel === 'sync') renderPanel();
  }

  // ======================================================================= Bottom toolbar (icon + label)
  const toolbar = h('div', { class: 'toolbar' });
  function tool(name: keyof typeof ICON, text: string, run: () => void, o: { sel?: boolean; cls?: string; ring?: string; disabled?: boolean } = {}) {
    const b = h('button', { class: 'tool' + (o.sel ? ' sel' : '') + (o.cls ? ' ' + o.cls : ''), 'aria-label': text, disabled: !!o.disabled, onclick: run },
      icon(name, 22), h('span', {}, text));
    if (o.ring) b.append(h('i', { class: 'ring', style: `background:${o.ring}` }));
    return b;
  }
  const sepEl = () => h('div', { class: 'sep' });
  const backTool = () => h('button', { class: 'tool back', 'aria-label': 'Back', onclick: () => { selectedId = null; selClip = null; renderBar(); draw(); tick(); } }, icon('back', 20));
  /** The segment the layout tools act on: the selected one, else the one under the playhead. */
  const target = (): Segment | undefined => selected() ?? segmentAt(p.segments, playMs);

  function selected(): Segment | undefined { return p.segments.find((s) => s.id === selectedId); }
  function selectSeg(id: string) { selectedId = id; selClip = null; renderBar(); draw(); }

  function setStyle(st: LayoutStyle) {
    const s = target();
    if (!s) return;
    edit(updateSegment(p.segments, s.id, { style: st })); if (panel !== 'none') renderPanel(); tick();
  }
  function patch(pt: Partial<Segment>) { const s = target(); if (s) { edit(updateSegment(p.segments, s.id, pt)); if (panel !== 'none') renderPanel(); } }

  const needAudio = (): boolean => {
    if (audioReady()) return true;
    toast(hasAudioError ? 'This video has no readable audio, so this tool is off.' : 'Still reading the audio. Try again in a moment.');
    return false;
  };

  function doAutoSwitch(useLips: boolean) {
    if (!needAudio()) return;
    const motion = useLips && runtime.hostMotion && runtime.constMotion ? { host: runtime.hostMotion, constant: runtime.constMotion } : undefined;
    const keep = coverage(p.segments); // parts removed by silence cut stay removed
    let segs = detectSpeakers(runtime.hostPcm!, runtime.constPcm!, p.offsetMs, p.durationMs, app.settings, p.mainAudio, motion);
    const clipped = keep.length ? intersectRanges(segs, keep) : segs;
    if (clipped.length) segs = clipped;
    edit(segs); selectedId = segs[0]?.id ?? null; afterEdit();
    if (segs.length <= 1) toast('Could not tell the two people apart. Try the lips scan or cut by hand.');
    else if (lastUsedLips) toast(`Auto switch with lips + voice: ${segs.length} segments. Undo to go back.`);
    else if (lastMethod === 'voice') toast(`Auto switch by voice: ${segs.length} segments (quality ${lastVoiceQuality.toFixed(1)}). Wrong way round? Tap swap.`);
    else toast(`Auto switch by mic loudness: ${segs.length} segments (${lastSeparationDb.toFixed(1)} dB). Undo to go back.`);
  }

  let scanning = false, scanCancel = false;
  async function doSmartSwitch() {
    if (scanning || !needAudio()) return;
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

  function doSwap() { edit(p.segments.map((s) => ({ ...s, main: (s.main === 'host' ? 'constant' : 'host') as Role }))); }
  function doSplit() { edit(splitAt(p.segments, playMs)); selectedId = segmentAt(p.segments, playMs)?.id ?? null; tick(); }
  function doMerge() { const s = selected(); if (s) { edit(mergeWithPrev(p.segments, s.id)); selectedId = null; afterEdit(); } else toast('Tap a segment in the bottom row first.'); }
  async function doDelete() {
    const s = selected();
    if (!s) { toast('Tap a segment in the bottom row first.'); return; }
    if (p.segments.length <= 1) { toast('Cannot delete the only segment.'); return; }
    if (await confirmDialog('Delete segment?', 'The neighbouring segment will fill the gap.')) { edit(deleteSegment(p.segments, s.id)); selectedId = null; afterEdit(); }
  }

  function setAudio(role: Role) {
    p.mainAudio = role;
    hostV.muted = role !== 'host';
    constV.muted = role !== 'constant';
    renderBar(); draw(); scheduleSave(); tick();
  }

  function renderBar() {
    const rows: Node[] = [];
    const hasSel = !!selected() || selClip === 'host';
    if (!hasSel) {
      // nothing selected: the main tools, like CapCut's first row
      rows.push(
        tool('sync', 'Sync', () => { selClip = 'constant'; selectedId = null; openPanel('sync'); }),
        tool('wand', 'Auto switch', () => doAutoSwitch(false)),
        tool('lips', 'Lips scan', doSmartSwitch),
        tool('silence', 'Silence', () => openPanel('silence')),
        tool('layout', 'Layout', () => openPanel('layout')),
        tool('user', 'On screen', () => openPanel('main')),
        tool('volume', 'Audio', () => openPanel('audio')),
        tool('crop', 'Crop', () => openPanel('crop')),
        tool('ratio', 'Ratio', () => openPanel('ratio')),
        tool('zoomOut', 'Zoom out', () => { pxPerSec = Math.max(minPx(), pxPerSec / 1.5); draw(); }),
        tool('zoomIn', 'Zoom in', () => { pxPerSec = Math.min(300, pxPerSec * 1.5); draw(); }),
      );
    } else {
      // a clip is selected: the bar swaps to clip tools with a back chevron (CapCut)
      rows.push(backTool(),
        tool('scissors', 'Split', doSplit),
        tool('layout', 'Layout', () => openPanel('layout')),
        tool('user', 'On screen', () => openPanel('main')),
        tool('volume', 'Audio', () => openPanel('audio')),
        tool('crop', 'Crop', () => openPanel('crop')),
        tool('merge', 'Merge', doMerge),
        tool('trash', 'Delete', doDelete),
        tool('swap', 'Swap', doSwap));
    }
    toolbar.replaceChildren(...rows);
    toolbar.scrollLeft = 0;
  }

  // ======================================================================= Panels: sync, ratio, crop, silence
  let panel: Panel = 'none';
  let cropRole: Role = 'host';
  const panelEl = h('div', { class: 'panel', style: 'display:none' });

  function openPanel(n: Panel) {
    if (n === 'none') return closePanel();
    if (playing) setPlaying(false);
    panel = n;
    pendingCuts = [];
    if (n !== 'sync') selClip = null;
    if (n === 'crop') cropRole = segmentAt(p.segments, playMs)?.main ?? 'host';
    if (n === 'silence') { if (!needAudio()) { panel = 'none'; return; } runDetect(); }
    cropView.classList.toggle('on', n === 'crop');
    renderPanel(); draw(); tick();
    if (n === 'crop') requestAnimationFrame(layoutCrop);
  }
  function closePanel() {
    panel = 'none'; pendingCuts = []; snapMs = null;
    if (selClip === 'constant') selClip = null;
    cropView.classList.remove('on'); guideV.classList.remove('on'); guideH.classList.remove('on');
    renderPanel(); renderBar(); draw();
  }

  /** CapCut footer: thin divider, centered title, check on the right. */
  const pFoot = (title: string) => h('div', { class: 'pfoot' },
    h('div', { class: 'ptitle' }, title),
    h('button', { class: 'pcheck', 'aria-label': 'Done', title: 'Done', onclick: closePanel }, icon('check', 28)));
  const setPanel = (title: string, ...body: Node[]) => panelEl.replaceChildren(h('div', { class: 'pbody' }, ...body), pFoot(title));
  /** CapCut tile: rounded square with an icon, label under it. Selected = white outline. */
  const ptile = (inner: Node, label: string, run: () => void, o: { sel?: boolean; disabled?: boolean } = {}) =>
    h('button', { class: 'ptile' + (o.sel ? ' sel' : ''), disabled: !!o.disabled, 'aria-label': label, onclick: run },
      h('span', { class: 'pbox' }, inner), h('span', { class: 'plab' }, label));
  const pstrip = (...tiles: Node[]) => h('div', { class: 'pstrip' }, ...tiles);

  const secText = (ms: number) => (ms >= 60000 ? fmtClock(ms) : `${(ms / 1000).toFixed(1)} s`);

  function chipRow<T extends string | number>(opts: [T, string][], cur: T, on: (v: T) => void): HTMLElement {
    return h('div', { class: 'chips' }, ...opts.map(([v, l]) => h('button', { class: 'chip' + (v === cur ? ' on' : ''), onclick: () => on(v) }, l)));
  }

  function runDetect() {
    const s = app.settings;
    pendingCuts = detectSilence(runtime.hostPcm!, runtime.constPcm!, p.offsetMs, p.durationMs,
      { minMs: s.silenceMinMs, padMs: s.silencePadMs, sens: s.silenceSens }, coverage(p.segments));
  }

  function applySilence() {
    if (!pendingCuts.length) return;
    const removed = pendingCuts.reduce((a, r) => a + (r.endMs - r.startMs), 0);
    const count = pendingCuts.length;
    const next = dropSlivers(subtractRanges(p.segments, pendingCuts));
    if (!next.length) { toast('That would remove everything. Pick a longer silence time.'); return; }
    pendingCuts = [];
    edit(next);
    if (!isKept(p.segments, playMs)) seek(nextKeptStart(p.segments, playMs) ?? firstStart());
    runDetect();
    toast(`Removed ${secText(removed)} of silence (${count} ${count === 1 ? 'cut' : 'cuts'}). New length ${secText(keptMs(p.segments))}. Undo to go back.`, 3600);
    renderPanel(); draw();
  }

  function slider(lbl: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, on: (v: number) => void, disabled = false) {
    const val = h('div', { class: 'pval' }, fmt(value));
    const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), disabled, 'aria-label': lbl }) as HTMLInputElement;
    input.addEventListener('input', () => { const v = parseFloat(input.value); val.textContent = fmt(v); on(v); });
    return { row: h('div', { class: 'prow' }, h('div', { class: 'plabel' }, lbl), input, val), input };
  }

  // ----- sync panel -----
  const shiftText = () => { const s = -p.offsetMs; return `${s >= 0 ? '+' : '-'}${(Math.abs(s) / 1000).toFixed(3)} s`; };
  let syncNote = p.syncConfidence ? `${p.syncConfidence} confidence` : '';
  let syncNoteCls = p.syncConfidence ?? '';

  /** Move the green clip by d ms (+ = later / to the right). Undoable. */
  function nudge(d: number) {
    hist.push(snap());
    const old = p.durationMs;
    p.offsetMs -= d;
    syncNote = 'Manual'; syncNoteCls = 'Manual';
    commitOffset(old);
    updateBtns();
  }

  async function doAutoSync() {
    if (!needAudio()) return;
    hist.push(snap());
    const old = p.durationMs;
    startTask('sync', 'Syncing audio');
    await nextPaint();
    const r = runSync(p);
    endTask('sync');
    p.segments = fitSegmentsToDuration(p.segments, old, p.durationMs);
    syncNote = `${r.confidence} confidence`; syncNoteCls = r.confidence;
    commitOffset(old); updateBtns();
    toast(r.confidence === 'Low' ? 'Low confidence. Drag the green clip or use the buttons until the waves line up.' : `Synced (${r.confidence} confidence).`);
  }

  /** While dragging the clip only the numbers change (rebuilding the panel would eat the touch). */
  function renderPanelSoft() {
    const el = panelEl.querySelector('.shiftval');
    if (el) el.textContent = shiftText();
  }

  function renderPanel() {
    toolbar.style.display = panel === 'none' ? '' : 'none';
    panelEl.style.display = panel === 'none' ? 'none' : '';
    if (panel === 'none') return;
    const s = app.settings;
    const seg = target();

    if (panel === 'sync') {
      const nudges: [number, string][] = [[-1000, '-1s'], [-100, '-100ms'], [-10, '-10ms'], [10, '+10ms'], [100, '+100ms'], [1000, '+1s']];
      setPanel('Sync',
        h('div', { class: 'prow' },
          h('div', { class: 'plabel' }, 'Green clip'),
          h('b', { class: 'shiftval' }, shiftText()),
          syncNote ? h('span', { class: `badge ${syncNoteCls}` }, syncNote) : null,
          h('div', { class: 'grow' }),
          h('button', { class: 'chip', onclick: doAutoSync, disabled: !audioReady() }, icon('sync', 16), 'Auto sync')),
        h('div', { class: 'chips nudges2' }, ...nudges.map(([d, l]) => h('button', { class: 'chip', onclick: () => nudge(d) }, l))),
        h('div', { class: 'pinfo' }, 'Drag the green clip on the timeline until its waves line up with the white ones. + moves it later.'));
    } else if (panel === 'ratio') {
      const tiles = (Object.keys(ASPECTS) as Aspect[]).map((a) => {
        const [aw, ah] = ASPECTS[a]; const k = 20 / Math.max(aw, ah);
        return ptile(h('i', { class: 'rbox', style: `width:${Math.round(aw * k)}px;height:${Math.round(ah * k)}px` }), a,
          () => { p.aspect = a; fitStage(); applyLayout(segmentAt(p.segments, playMs)); scheduleSave(); renderPanel(); tick(); }, { sel: p.aspect === a });
      });
      setPanel('Ratio', pstrip(...tiles));
    } else if (panel === 'layout') {
      const tiles: Node[] = (['one', 'side', 'updown', 'popup'] as LayoutStyle[]).map((st) => ptile(icon(st, 26), STYLE_LABEL[st], () => setStyle(st), { sel: seg?.style === st, disabled: !seg }));
      if (seg?.style === 'popup') {
        tiles.push(h('div', { class: 'psep' }));
        (['tl', 'tr', 'bl', 'br'] as Corner[]).forEach((c) => tiles.push(ptile(icon(({ tl: 'cTL', tr: 'cTR', bl: 'cBL', br: 'cBR' } as const)[c], 26), ({ tl: 'Top left', tr: 'Top right', bl: 'Bottom left', br: 'Bottom right' })[c], () => patch({ corner: c }), { sel: seg.corner === c })));
        tiles.push(h('div', { class: 'psep' }));
        (['S', 'M', 'L'] as PopupSize[]).forEach((z) => tiles.push(ptile(icon(({ S: 'sizeS', M: 'sizeM', L: 'sizeL' } as const)[z], 26), `Size ${z}`, () => patch({ size: z }), { sel: seg.size === z })));
      }
      setPanel('Layout', pstrip(...tiles));
    } else if (panel === 'main') {
      const lock = !seg || seg.style === 'side' || seg.style === 'updown';
      setPanel('On screen', pstrip(
        ptile(icon('user', 26), 'Host', () => patch({ main: 'host' as Role }), { sel: seg?.main === 'host', disabled: lock }),
        ptile(icon('user', 26), 'Constant', () => patch({ main: 'constant' as Role }), { sel: seg?.main === 'constant', disabled: lock }),
        ptile(icon('swap', 26), 'Swap all', () => { doSwap(); renderPanel(); })));
    } else if (panel === 'audio') {
      setPanel('Audio', pstrip(
        ptile(icon('volume', 26), 'Host mic', () => { setAudio('host'); renderPanel(); }, { sel: p.mainAudio === 'host' }),
        ptile(icon('volume', 26), 'Constant mic', () => { setAudio('constant'); renderPanel(); }, { sel: p.mainAudio === 'constant' })));
    } else if (panel === 'crop') {
      const c: CropState = cropRole === 'host' ? p.cropHost : p.cropConst;
      const reset = h('button', { class: 'chip', onclick: () => { Object.assign(c, NO_CROP); applyCrop(cropRole); positionCropFrame(); scheduleSave(); } }, icon('trash', 16), 'Reset');
      setPanel('Crop',
        h('div', { class: 'prow' }, h('div', { class: 'plabel' }, 'Video'),
          chipRow<Role>([['host', 'Host'], ['constant', 'Constant']], cropRole, (v) => { cropRole = v; renderPanel(); layoutCrop(); }), reset),
        h('div', { class: 'pinfo' }, 'Drag the corners or pinch to crop. Drag inside the frame to move it.'));
    } else {
      const total = pendingCuts.reduce((a, r) => a + (r.endMs - r.startMs), 0);
      const info = pendingCuts.length
        ? h('div', { class: 'pinfo' }, 'Found ', h('b', {}, `${pendingCuts.length} silent ${pendingCuts.length === 1 ? 'part' : 'parts'}`), ' - ', h('b', {}, secText(total)), ' will be removed from both videos. Red on the timeline.')
        : h('div', { class: 'pinfo' }, 'No silence this long. Try a shorter time or higher sensitivity.');
      const go = (pt: Partial<typeof s>) => { Object.assign(s, pt); saveSettings(s); runDetect(); renderPanel(); draw(); };
      const apply = h('button', { class: 'btn primary', disabled: !pendingCuts.length, onclick: applySilence }, pendingCuts.length ? `Cut ${pendingCuts.length} ${pendingCuts.length === 1 ? 'silence' : 'silences'}` : 'Nothing to cut');
      setPanel('Silence cut', info,
        h('div', { class: 'prow' }, h('div', { class: 'plabel' }, 'Both quiet for'),
          chipRow<number>([[300, '0.3 s'], [500, '0.5 s'], [1000, '1 s'], [1500, '1.5 s'], [2000, '2 s'], [3000, '3 s'], [5000, '5 s']], s.silenceMinMs, (v) => go({ silenceMinMs: v }))),
        h('div', { class: 'prow' }, h('div', { class: 'plabel' }, 'Keep around'),
          chipRow<number>([[0, 'None'], [100, '0.1 s'], [150, '0.15 s'], [250, '0.25 s'], [400, '0.4 s']], s.silencePadMs, (v) => go({ silencePadMs: v }))),
        h('div', { class: 'prow' }, h('div', { class: 'plabel' }, 'Sensitivity'),
          chipRow<SilenceSens>([['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], s.silenceSens, (v) => go({ silenceSens: v }))),
        apply);
    }
  }

  // ----- CapCut-style crop: the picture is shown big, a frame with corner handles picks the part that is kept -----
  // The frame keeps the shape of the video's box in the layout. Position/size are stored as CropState (zoom, x, y),
  // the same numbers the exporter uses.
  const cropCanvas = h('canvas', { class: 'cropcanvas' }) as HTMLCanvasElement;
  const cropGrid = h('div', { class: 'grid' });
  const cropFrame = h('div', { class: 'cropframe' }, cropGrid,
    ...(['tl', 'tr', 'bl', 'br'] as const).map((k) => h('div', { class: `crh ${k}`, 'data-c': k })));
  const cropView = h('div', { class: 'cropview' }, cropCanvas, cropFrame);
  preview.append(cropView);
  let cm = { x: 0, y: 0, w: 0, h: 0 }; // the big picture area inside the preview
  let cropAr = 16 / 9;

  function layoutCrop() {
    if (panel !== 'crop') return;
    const cw = preview.clientWidth, ch = preview.clientHeight;
    if (!cw || !ch) return;
    const cell = cropRole === 'host' ? hostCell : constCell;
    cropAr = cell.clientWidth > 0 && cell.clientHeight > 0 ? cell.clientWidth / cell.clientHeight : aspectValue(p.aspect);
    const pad = 24;
    const w = Math.max(40, Math.min(cw - 2 * pad, (ch - 2 * pad) * cropAr));
    const hh = w / cropAr;
    cm = { x: (cw - w) / 2, y: (ch - hh) / 2, w, h: hh };
    const dpr = window.devicePixelRatio || 1;
    cropCanvas.width = Math.round(w * dpr); cropCanvas.height = Math.round(hh * dpr);
    cropCanvas.style.cssText = `left:${cm.x}px;top:${cm.y}px;width:${w}px;height:${hh}px`;
    drawCropCanvas(); positionCropFrame();
  }
  /** The video as the layout box shows it with no crop (cover), drawn big. */
  function drawCropCanvas() {
    const ctx = cropCanvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cropCanvas.width, cropCanvas.height);
    const v = vid(cropRole);
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return;
    let sx = 0, sy = 0, sw = vw, sh = vh;
    if (vw / vh > cropAr) { sw = vh * cropAr; sx = (vw - sw) / 2; } else { sh = vw / cropAr; sy = (vh - sh) / 2; }
    try { ctx.drawImage(v, sx, sy, sw, sh, 0, 0, cropCanvas.width, cropCanvas.height); } catch { /* frame not decoded yet */ }
  }
  const cropState = () => (cropRole === 'host' ? p.cropHost : p.cropConst);
  const frameRect = () => {
    const c = cropState(); const z = Math.max(1, c.zoom);
    const w = cm.w / z, hh = cm.h / z;
    const cx = cm.x + cm.w / 2 - c.x * (cm.w - w) / 2, cy = cm.y + cm.h / 2 - c.y * (cm.h - hh) / 2;
    return { l: cx - w / 2, t: cy - hh / 2, w, h: hh };
  };
  function positionCropFrame() {
    const r = frameRect();
    cropFrame.style.cssText = `left:${r.l}px;top:${r.t}px;width:${r.w}px;height:${r.h}px`;
  }
  /** Store a frame (left, top, width) as CropState, with limits and snapping to the center. */
  function setFrame(l: number, t: number, w: number, snap = true) {
    w = Math.max(cm.w / 3, Math.min(cm.w, w));
    const hh = w / cropAr;
    l = Math.max(cm.x, Math.min(cm.x + cm.w - w, l));
    t = Math.max(cm.y, Math.min(cm.y + cm.h - hh, t));
    const ux = l + w / 2 - (cm.x + cm.w / 2), uy = t + hh / 2 - (cm.y + cm.h / 2);
    const rx = (cm.w - w) / 2, ry = (cm.h - hh) / 2;
    const c = cropState();
    c.zoom = cm.w / w;
    if (c.zoom < 1.002) { c.zoom = 1; c.x = 0; c.y = 0; }
    else {
      c.x = rx > 0.5 ? Math.max(-1, Math.min(1, -ux / rx)) : 0;
      c.y = ry > 0.5 ? Math.max(-1, Math.min(1, -uy / ry)) : 0;
      if (snap && Math.abs(ux) < 5) c.x = 0;
      if (snap && Math.abs(uy) < 5) c.y = 0;
    }
    guideV.classList.toggle('on', c.zoom > 1 && c.x === 0);
    guideH.classList.toggle('on', c.zoom > 1 && c.y === 0);
    applyCrop(cropRole); positionCropFrame(); scheduleSave();
  }

  type CropDrag = { mode: 'move' | 'resize'; corner?: string; ax?: number; ay?: number; dx?: number; dy?: number };
  const cropPtrs = new Map<number, Ptr>();
  let cropDrag: CropDrag | null = null;
  let pinchStart = { d: 0, w: 0 };
  cropView.addEventListener('pointerdown', (e) => {
    if (panel !== 'crop') return;
    cropView.setPointerCapture(e.pointerId);
    const rect = cropView.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    cropPtrs.set(e.pointerId, { x: px, y: py });
    cropGrid.classList.add('on');
    const r = frameRect();
    if (cropPtrs.size === 2) {
      const [a, b] = [...cropPtrs.values()];
      pinchStart = { d: Math.hypot(a.x - b.x, a.y - b.y), w: r.w };
      cropDrag = null;
      return;
    }
    const corner = (e.target as HTMLElement).dataset?.c;
    if (corner) {
      const right = corner === 'tr' || corner === 'br', bottom = corner === 'bl' || corner === 'br';
      cropDrag = { mode: 'resize', corner, ax: right ? r.l : r.l + r.w, ay: bottom ? r.t : r.t + r.h };
    } else {
      cropDrag = { mode: 'move', dx: px - r.l, dy: py - r.t };
    }
  });
  cropView.addEventListener('pointermove', (e) => {
    if (panel !== 'crop' || !cropPtrs.has(e.pointerId)) return;
    const rect = cropView.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    cropPtrs.set(e.pointerId, { x: px, y: py });
    const r = frameRect();
    if (cropPtrs.size === 2) {
      const [a, b] = [...cropPtrs.values()];
      const w = pinchStart.w * (Math.hypot(a.x - b.x, a.y - b.y) / (pinchStart.d || 1));
      const cx = r.l + r.w / 2, cy = r.t + r.h / 2;
      setFrame(cx - w / 2, cy - w / cropAr / 2, w);
    } else if (cropDrag?.mode === 'move') {
      setFrame(px - cropDrag.dx!, py - cropDrag.dy!, r.w);
    } else if (cropDrag?.mode === 'resize') {
      const { ax, ay, corner } = cropDrag as Required<CropDrag>;
      const dirX = corner.endsWith('r') ? 1 : -1, dirY = corner.startsWith('b') ? 1 : -1;
      const spaceX = dirX > 0 ? cm.x + cm.w - ax : ax - cm.x;
      const spaceY = dirY > 0 ? cm.y + cm.h - ay : ay - cm.y;
      let w = Math.max(Math.abs(px - ax), Math.abs(py - ay) * cropAr);
      w = Math.max(cm.w / 3, Math.min(w, spaceX, spaceY * cropAr));
      const hh = w / cropAr;
      setFrame(dirX > 0 ? ax : ax - w, dirY > 0 ? ay : ay - hh, w, false);
    }
  });
  const cropEnd = (e: PointerEvent) => {
    cropPtrs.delete(e.pointerId);
    if (cropPtrs.size === 1) { // one finger left after a pinch: carry on as a move
      const [pt] = [...cropPtrs.values()]; const r = frameRect();
      cropDrag = { mode: 'move', dx: pt.x - r.l, dy: pt.y - r.t };
    } else if (!cropPtrs.size) {
      cropDrag = null; cropGrid.classList.remove('on');
      guideV.classList.remove('on'); guideH.classList.remove('on');
    }
  };
  cropView.addEventListener('pointerup', cropEnd);
  cropView.addEventListener('pointercancel', cropEnd);
  hostV.addEventListener('seeked', () => { if (panel === 'crop' && cropRole === 'host') drawCropCanvas(); });
  constV.addEventListener('seeked', () => { if (panel === 'crop' && cropRole === 'constant') drawCropCanvas(); });
  hostV.addEventListener('loadeddata', () => { if (panel === 'crop' && cropRole === 'host') drawCropCanvas(); });
  constV.addEventListener('loadeddata', () => { if (panel === 'crop' && cropRole === 'constant') drawCropCanvas(); });

  function scheduleSave() { clearTimeout(saveTimer); saveTimer = window.setTimeout(() => saveProject(p), 600); }

  // ======================================================================= Main loop
  function refresh() {
    applyLayout(segmentAt(p.segments, playMs));
    draw();
  }

  function loop() {
    if (playing) {
      // the Host video is the clock: the timeline follows it, so a slow decoder never makes the picture "stand still"
      if (!hostV.seeking && hostV.readyState >= 2) playMs = hostV.currentTime * 1000;
      const endAt = lastEnd();
      if (playMs >= endAt - 30 || hostV.ended) { playMs = Math.min(endAt, p.durationMs); setPlaying(false); refresh(); }
      else {
        if (p.segments.length && !isKept(p.segments, playMs)) {
          // jump over a part that was cut out
          const nx = nextKeptStart(p.segments, playMs);
          if (nx !== null) { playMs = nx; syncHost(true); syncConst(true); }
        }
        syncConst(false);
        refresh();
      }
    }
    raf = requestAnimationFrame(loop);
  }

  // ======================================================================= Start-up: thumbnails, previews, audio, sync, auto switch
  async function bootstrap() {
    startSource('host'); startSource('constant');
    // until a video can play, show its first picture in the preview instead of black
    const poster = (role: Role, st: Strip | undefined) => {
      const img = st?.frames.find((f) => !!f);
      if (img && !ready[role] && !vid(role).poster) vid(role).poster = img.src;
    };
    hostStrip = makeStrip({ path: runtime.hostPath, url: runtime.hostUrl!, durationMs: hostDur, height: LANE * 2, onFrame: () => { poster('host', hostStrip); requestDraw(); } });
    constStrip = makeStrip({ path: runtime.constPath, url: runtime.constUrl!, durationMs: constDur, height: LANE * 2, onFrame: () => { poster('constant', constStrip); requestDraw(); } });

    // audio -> waveforms (and what sync / auto switch need)
    if (!audioReady()) {
      let hp = 0, cp = 0;
      startTask('audio', 'Reading audio', 0);
      const upd = () => updateTask('audio', 'Reading audio', (hp + cp) / 2);
      try {
        await Promise.all([ensureAudio('host', (n) => { hp = n; upd(); }), ensureAudio('constant', (n) => { cp = n; upd(); })]);
      } catch (e) {
        hasAudioError = true;
        if (!destroyed) toast(`${(e as Error).message || 'Could not read the audio.'} Auto sync and auto switch are off.`, 4200);
      }
      endTask('audio');
    }
    if (destroyed) return;
    computePeaks(); requestDraw();

    if (!p.segments.length) {
      // first time in the editor with these two videos
      if (audioReady()) {
        startTask('sync', 'Syncing audio');
        await nextPaint();
        if (destroyed) { endTask('sync'); return; }
        const r = runSync(p);
        endTask('sync');
        syncNote = `${r.confidence} confidence`; syncNoteCls = r.confidence;
        p.segments = defaultSegments(p.durationMs, p.mainAudio);
        selectedId = p.segments[0].id;
        syncReady = true; refresh(); updatePlayState();
        startTask('switch', 'Detecting who is speaking');
        await nextPaint();
        if (destroyed) { endTask('switch'); return; }
        p.segments = runAutoSwitch(p, app.settings);
        endTask('switch');
        selectedId = p.segments[0]?.id ?? null;
        if (r.confidence === 'Low') {
          toast('The audio did not match well. Drag the green clip or use the buttons until the waves line up.', 4200);
          selClip = 'constant'; selectedId = null; openPanel('sync');
        }
      } else {
        p.offsetMs = 0; p.syncConfidence = 'Low';
        p.durationMs = overlapDuration(hostDur, constDur, 0);
        p.segments = defaultSegments(p.durationMs, p.mainAudio);
        selectedId = p.segments[0].id;
        syncNote = 'Not synced'; syncNoteCls = 'Low';
        toast('Could not sync automatically. Drag the green clip until the waves line up.', 4200);
        selClip = 'constant'; selectedId = null; openPanel('sync');
      }
      syncReady = true;
      hist.reset();
      seek(0); afterEdit(); updatePlayState();
      saveProject(p);
    }

    if (destroyed) return;
    const intent: Intent | undefined = app.intent; app.intent = undefined;
    if (intent) openPanel(intent);
  }

  // ======================================================================= Screen
  const resChip = h('button', { class: 'reschip', 'aria-label': 'Export resolution', onclick: () => {
    actionSheet([720, 1080].map((r) => ({ label: `${r}P${app.settings.resolution === r ? '  (selected)' : ''}`, run: () => { app.settings.resolution = r as 720 | 1080; saveSettings(app.settings); resChip.firstChild!.textContent = `${r}P`; } })));
  } }, h('span', {}, `${app.settings.resolution}P`), icon('chevD', 14));

  const el = h('div', { class: 'screen editor' },
    h('div', { class: 'edtop' },
      iconButton('close', 'Close', async () => { setPlaying(false); await saveProject(p); app.go('home'); }, 'plain'),
      h('div', { class: 'grow' }),
      resChip,
      h('button', { class: 'exportbtn', 'aria-label': 'Export', onclick: async () => {
        if (!syncReady || !p.segments.length) { toast('Wait until syncing is done.'); return; }
        setPlaying(false); await saveProject(p); app.go('export');
      } }, 'Export')),
    preview, controls, tl, toolbar, panelEl);

  app.onBack = () => {
    if (stage.classList.contains('full')) { exitFull(); return true; }
    if (panel !== 'none') { closePanel(); return true; }
    if (selectedId || selClip) { selectedId = null; selClip = null; renderBar(); draw(); return true; }
    return false;
  };

  offTasks = onTasks((list: Task[]) => {
    pillsEl.replaceChildren(...list.map((t) => h('div', { class: 'pill', role: 'status' }, spinner(16), h('span', {}, t.label + (t.pct !== undefined && t.pct > 0 ? ` ${t.pct}%` : '')))));
    if (!destroyed) updatePlayState();
  });

  requestAnimationFrame(() => {
    selectedId = null;
    fitStage();
    renderBar(); updateBtns(); updatePlayState();
    refresh();
    loop();
    bootstrap();
  });
  const onResize = () => { fitStage(); draw(); };
  window.addEventListener('resize', onResize);

  return {
    el,
    destroy: () => {
      destroyed = true;
      cancelAnimationFrame(raf); clearTimeout(saveTimer); saveProject(p);
      hostV.pause(); constV.pause();
      hostStrip?.cancel(); constStrip?.cancel();
      offTasks();
      endTask('audio'); endTask('sync'); endTask('switch'); endTask('proxy-host'); endTask('proxy-constant');
      window.removeEventListener('resize', onResize);
      ro.disconnect();
      (screen.orientation as any)?.unlock?.();
    },
  };
}
