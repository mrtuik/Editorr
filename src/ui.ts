import logoUrl from './assets/logo.png';
import { firstName, getAccount, onAccountChange } from './core/account';
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, any> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'text') el.textContent = v;
    else if (k in el && k !== 'style') (el as any)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function fmtTime(ms: number, withMs = false): string {
  const neg = ms < 0; ms = Math.abs(ms);
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60), s = total % 60;
  const base = `${neg ? '-' : ''}${m}:${String(s).padStart(2, '0')}`;
  return withMs ? `${base}.${String(Math.floor(ms % 1000)).padStart(3, '0')}` : base;
}

/** CapCut-style clock: 00:34 (or 1:02:03 for long ones). */
export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function fmtOffset(ms: number): string {
  return `${ms >= 0 ? '+' : '-'}${(Math.abs(ms) / 1000).toFixed(3)} s`;
}

export function toast(msg: string, ms = 2600): void {
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

export function confirmDialog(title: string, body: string, okLabel = 'Delete'): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (v: boolean) => { d.remove(); resolve(v); };
    const d = h('div', { class: 'dialog', role: 'dialog' },
      h('div', { class: 'box' },
        h('div', { class: 'title' }, title),
        h('p', { class: 'sec' }, body),
        h('div', { class: 'actions' },
          h('button', { class: 'btn', onclick: () => done(false) }, 'Cancel'),
          h('button', { class: 'btn danger', onclick: () => done(true) }, okLabel))));
    document.body.append(d);
  });
}

export function promptDialog(title: string, initial: string): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', value: initial });
    const done = (v: string | null) => { d.remove(); resolve(v); };
    const d = h('div', { class: 'dialog' },
      h('div', { class: 'box' },
        h('div', { class: 'title' }, title),
        h('div', { style: 'margin-top:12px' }, input),
        h('div', { class: 'actions' },
          h('button', { class: 'btn', onclick: () => done(null) }, 'Cancel'),
          h('button', { class: 'btn primary', style: 'flex:none', onclick: () => done(input.value.trim() || initial) }, 'Save'))));
    document.body.append(d);
    input.focus();
  });
}

export function actionSheet(items: { label: string; danger?: boolean; run: () => void }[]): void {
  const m = h('div', { class: 'menu', onclick: (e: Event) => { if (e.target === m) m.remove(); } },
    h('div', { class: 'sheet' },
      ...items.map((i) => h('button', { class: 'btn' + (i.danger ? ' danger' : ''), onclick: () => { m.remove(); i.run(); } }, i.label)),
      h('button', { class: 'btn', onclick: () => m.remove() }, 'Cancel')));
  document.body.append(m);
}

export function projectActionSheet(
  p: { name: string; thumb?: string; durationMs?: number; updatedAt?: number },
  items: { label: string; iconName: keyof typeof ICON; danger?: boolean; run: () => void }[]
): void {
  const thumbEl = p.thumb
    ? h('div', { class: 'project-sheet-thumb', style: `background-image:url(${p.thumb})` })
    : h('div', { class: 'project-sheet-thumb' }, icon('play', 20));

  const metaParts: string[] = [];
  if (p.durationMs) metaParts.push(fmtClock(p.durationMs));
  if (p.updatedAt) metaParts.push(new Date(p.updatedAt).toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' }));
  const metaText = metaParts.length ? metaParts.join(' · ') : 'Local project';

  const handleBar = h('div', { class: 'project-sheet-drag-handle' });
  const head = h('div', { class: 'project-sheet-header' },
    thumbEl,
    h('div', { class: 'project-sheet-info' },
      h('div', { class: 'project-sheet-title' }, p.name),
      h('div', { class: 'project-sheet-meta' }, metaText)));

  const actionList = h('div', { class: 'project-sheet-list' },
    ...items.map((i) =>
      h('button', {
        class: 'project-sheet-item' + (i.danger ? ' danger' : ''),
        onclick: () => { m.remove(); i.run(); },
      },
      icon(i.iconName, 20),
      h('span', {}, i.label))));

  const cancelBtn = h('button', {
    class: 'project-sheet-cancel-item',
    onclick: () => m.remove(),
  }, 'Cancel');

  const sheet = h('div', { class: 'project-sheet' }, handleBar, head, actionList, cancelBtn);
  const m = h('div', { class: 'menu', onclick: (e: Event) => { if (e.target === m) m.remove(); } }, sheet);
  document.body.append(m);
}

/** Round loading spinner (turns by CSS). */
export function spinner(size = 18): SVGElement {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', String(size));
  s.setAttribute('height', String(size));
  s.setAttribute('class', 'spin');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="3"/><path d="M12 3a9 9 0 019 9" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>';
  return s;
}

export function progressBar(): { el: HTMLElement; set: (pct: number) => void } {
  const bar = h('i');
  const el = h('div', { class: 'progress' }, bar);
  return { el, set: (p) => { bar.style.width = `${Math.max(0, Math.min(100, p))}%`; } };
}

export const ICON = {
  eq: '<path d="M5 4v16M12 4v16M19 4v16" /><circle cx="5" cy="14" r="2.200" fill="#0c0c0d"/><circle cx="12" cy="8" r="2.200" fill="#0c0c0d"/><circle cx="19" cy="15" r="2.200" fill="#0c0c0d"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />',
  duplicate: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />',
  back: '<path d="M15 5l-7 7 7 7" />',
  plus: '<path d="M12 5v14M5 12h14" />',
  overlay: '<rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M3.5 15.5l4.5-4.5 4 4 3-3 5.5 5.5" /><circle cx="15.5" cy="9" r="1.3" />',
  play: '<path d="M8 5l11 7-11 7z" fill="currentColor"/>',
  pause: '<path d="M8 5v14M16 5v14" />',
  undo: '<path d="M9 7L4 12l5 5M4 12h11a5 5 0 010 10h-3" />',
  redo: '<path d="M15 7l5 5-5 5M20 12H9a5 5 0 000 10h3" />',
  back10: '<path d="M11 6L5 12l6 6M19 6l-6 6 6 6" />',
  fwd10: '<path d="M13 6l6 6-6 6M5 6l6 6-6 6" />',
  full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" />',
  swap: '<g transform="scale(0.09375)" fill="currentColor" stroke="none"><path d="M228 48v104a20 20 0 0 1-20 20h-95.08a12 12 0 0 1-17.41 16.49l-20-20a12 12 0 0 1 0-17l20-20A12 12 0 0 1 112.92 148H204V52H100a12 12 0 0 1-24 0v-4a20 20 0 0 1 20-20h112a20 20 0 0 1 20 20m-60 144a12 12 0 0 0-12 12H52v-96h91.08a12 12 0 0 0 17.41 16.49l20-20a12 12 0 0 0 0-17l-20-20A12 12 0 0 0 143.08 84H48a20 20 0 0 0-20 20v104a20 20 0 0 0 20 20h112a20 20 0 0 0 20-20v-4a12 12 0 0 0-12-12"/></g>',
  mirror: '<path d="M12 3v18M5 6h5v12H5zM14 6h5v12h-5z" />',
  one: '<rect x="4" y="5" width="16" height="14" rx="2" />',
  side: '<rect x="3" y="6" width="8" height="12" rx="1"/><rect x="13" y="6" width="8" height="12" rx="1"/>',
  updown: '<rect x="5" y="3" width="14" height="8" rx="1"/><rect x="5" y="13" width="14" height="8" rx="1"/>',
  popup: '<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="13" y="12" width="6" height="5" rx="1" fill="currentColor"/>',
  bgm: '<g fill="currentColor" stroke="none"><path d="M2 12h8v2H2zm0 2h2v4H2zm0 4h8v2H2z"/><path d="M8 6h2v12H8zm10 0h2v12h-2zm-6 8h2v4h-2z"/><path d="M12 12h8v2h-8zm0 6h8v2h-8zM8 4h12v2H8z"/></g>',
  wand: '<path d="M5 19L17 7M14 4l1.2 2.3L17.5 7.5l-2.3 1.2L14 11l-1.2-2.3L10.5 7.5l2.3-1.2zM19 13l.7 1.3 1.3.7-1.3.7-.7 1.3-.7-1.3-1.3-.7 1.3-.7z" />',
  lips: '<path d="M2.5 12c3-4.5 6-4.5 9.5-2.5 3.500-2 6.500-2 9.500 2.500-3 5-6 6.500-9.500 6.500S5.500 17 2.500 12.500zM2.500 12.500h19" />',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.5 8l11.500 9M8.500 16L20 7" />',
  layout: '<path fill="currentColor" stroke="none" d="M19.5 3h-5c-.83 0-1.5.67-1.5 1.5v5c0 .83.67 1.5 1.5 1.5h5c.83 0 1.5-.67 1.5-1.5v-5c0-.83-.67-1.5-1.5-1.5M19 9h-4V5h4zM9.5 3h-5C3.67 3 3 3.67 3 4.5v15c0 .83.67 1.5 1.5 1.5h5c.83 0 1.5-.67 1.5-1.5v-15c0-.83-.67-1.5-1.5-1.5M9 19H5V5h4zm10.5-6h-5c-.83 0-1.5.67-1.5 1.5v5c0 .83.67 1.5 1.5 1.5h5c.83 0 1.5-.67 1.5-1.5v-5c0-.83-.67-1.5-1.5-1.5m-.5 6h-4v-4h4z"/>',
  face: '<path d="M4 8V5a1 1 0 011-1h3M16 4h3a1 1 0 011 1v3M20 16v3a1 1 0 01-1 1h-3M8 20H5a1 1 0 01-1-1v-3" /><circle cx="9.500" cy="10" r="0.800" fill="currentColor"/><circle cx="14.500" cy="10" r="0.800" fill="currentColor"/><path d="M9 14.500c1.500 1.500 4.500 1.500 6 0" />',
  autoframe: '<path d="M4 8V5a1 1 0 011-1h3M16 4h3a1 1 0 011 1v3M20 16v3a1 1 0 01-1 1h-3M8 20H5a1 1 0 01-1-1v-3" /><path d="M13 7l-3 5h4l-3 5" />',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.500 3.500-7 8-7s8 2.500 8 7" />',
  volume: '<path d="M4 9v6h4l5 4V5L8 9H4zM16.500 8.500a5 5 0 010 7M19 6a8.500 8.500 0 010 12" />',
  merge: '<path d="M10 14a4 4 0 005.700 0l3-3a4 4 0 00-5.700-5.700l-1 1M14 10a4 4 0 00-5.700 0l-3 3a4 4 0 005.700 5.700l1-1" />',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />',
  export: '<path d="M12 15V3M7.500 7.500L12 3l4.500 4.500M5 13v7h14v-7" />',
  close: '<path d="M6 6l12 12M18 6L6 18" />',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6" />',
  reaction: '<rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="11" r="1.600" /><circle cx="15.500" cy="11" r="1.600" /><path d="M8 15c1.200 1.200 6.800 1.200 8 0" />',
  punch: '<circle cx="11" cy="11" r="6" /><path d="M21 21l-5.500-5.500M11 8.500v5M8.500 11h5" />',
  check: '<path d="M5 12.500l4.500 4.500L19 7.500" />',
  cTL: '<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="5" y="7" width="6" height="4" rx="1" fill="currentColor"/>',
  cTR: '<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="13" y="7" width="6" height="4" rx="1" fill="currentColor"/>',
  cBL: '<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="5" y="13" width="6" height="4" rx="1" fill="currentColor"/>',
  cBR: '<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="13" y="13" width="6" height="4" rx="1" fill="currentColor"/>',
  sizeS: '<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="14" y="13" width="5" height="4" rx="1" fill="currentColor"/>',
  sizeM: '<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="11" y="11" width="8" height="6" rx="1" fill="currentColor"/>',
  sizeL: '<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="8" y="9" width="11" height="8" rx="1" fill="currentColor"/>',
  zoomIn: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.500-4.500M11 8v6M8 11h6" />',
  zoomOut: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.500-4.500M8 11h6" />',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4" />',
  mask: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="12" cy="12" r="4"/>',
  crop: '<path d="M6 2v14a2 2 0 002 2h14M2 6h14a2 2 0 012 2v14" />',
  ratio: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h2M7 10v2M17 14h-2M17 14v-2" />',
  silence: '<path d="M2 12h3M19 12h3M8 8v8M12 5v14M16 8v8" /><path d="M3 3l18 18" />',
  folder: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />',
  chevR: '<path d="M9 5l7 7-7 7" />',
  chevD: '<path d="M6 9l6 6 6-6" />',
  resume: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5l5 3.5-5 3.5z" fill="currentColor"/>',
  sync: '<path d="M10 21c-2.5 2.5-5 2-7 0s-2.5-4.5 0-7l3-3l7 7zm4-18c2.5-2.5 5-2 7.001 0s2.499 4.5 0 7l-3 3L11 6zm-3 7l-2.5 2.5zm3 3l-2.5 2.5z" />',
  more: '<circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/>',
  newVideo: '<rect x="3" y="3" width="18" height="18" rx="2" fill="currentColor" stroke="none"/><path d="M12 8v8M8 12h8" stroke="#000" />',
  speed: '<path d="M12 14l4-4M3.34 19a10 10 0 1 1 17.32 0" />',
  prompter: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 8h8M8 12h8M8 16h5" />',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />',
  badgeCheck: '<path d="M12 2.5l2.4 1.7 2.9-.2 1 2.7 2.4 1.7-.7 2.8.7 2.8-2.4 1.7-1 2.7-2.9-.2L12 21.5l-2.4-1.7-2.9.2-1-2.7-2.4-1.7.7-2.8-.7-2.8 2.4-1.7 1-2.7 2.9.2z" fill="currentColor"/><path d="M8.5 12.2l2.4 2.4 4.6-4.8" stroke="#fff"/>',
  community: '<path d="M4 11a7 7 0 0 1 12.6-4.2A7 7 0 0 1 12 18H8l-4 3z"/><circle cx="17" cy="17" r="3"/><path d="M19.2 19.2L21.5 21.5"/>',
  card: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4" />',
  toggle: '<rect x="3" y="7" width="18" height="10" rx="2"/><circle cx="8" cy="12" r="2.5" fill="currentColor"/>',
  helpInfo: '<circle cx="12" cy="12" r="9" fill="currentColor" fill-opacity=".18"/><path d="M12 11v5M12 8h.01" />',
  signOut: '<path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M14 8l4 4-4 4M18 12H9" />',
  bookmark: '<path d="M6 3h12v18l-6-4.500L6 21z" />',
  bookmarkFill: '<path d="M6 3h12v18l-6-4.500L6 21z" fill="currentColor" />',
  download: '<path d="M12 3v12M7 10.500l5 5 5-5M5 20h14" />',
  note: '<path d="M9 18V6l10-2v12" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="16.5" cy="16" r="2.5" />',
  bolt: '<path d="M13 3L5 13h6l-1 8 8-10h-6z" fill="currentColor" stroke="none"/>',
  switchSlider: '<g transform="scale(0.046875)" fill="currentColor" stroke="none"><path fill-rule="evenodd" d="M106.667 128h106.666V85.333H64v192h149.333v-42.667H106.667zM384 85.333H234.667v192H384zM405.333 384c0 35.347-28.652 64-64 64s-64-28.653-64-64s28.653-64 64-64s64 28.652 64 64m21.334 0a85.6 85.6 0 0 1-2.688 21.333h45.354v-42.667H423.98A85.6 85.6 0 0 1 426.667 384M128 405.333h130.688A85.6 85.6 0 0 1 256 384a85.6 85.6 0 0 1 2.688-21.334H128z"/></g>',
  sensLow: '<path d="M5 19v-4" /><path d="M12 19v-8M19 19V5" opacity=".25"/>',
  sensMed: '<path d="M5 19v-4M12 19v-8" /><path d="M19 19V5" opacity=".25"/>',
  sensHigh: '<path d="M5 19v-4M12 19v-8M19 19V5" />',
  editPencil: '<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />',
  /** Enhanced Audio tool icon (music-note-4, duotone). Filled shapes, so no stroke. */
  enhance: '<g fill="currentColor" stroke="none"><path d="M8 13.2501C10.6233 13.2501 12.7499 15.3768 12.75 18.0001C12.75 20.6234 10.6234 22.7501 8 22.7501C5.37665 22.7501 3.25 20.6234 3.25 18.0001C3.25007 15.3768 5.37669 13.2501 8 13.2501Z"/><path d="M17.6816 2.50494C18.9487 2.35727 20.1514 3.10047 20.5859 4.29986C20.6838 4.57015 20.7183 4.86271 20.7344 5.169C20.7506 5.47731 20.75 5.86475 20.75 6.34186C20.75 6.71942 20.7534 7.00851 20.7012 7.28131C20.5742 7.94489 20.2066 8.53889 19.6699 8.94928C19.4494 9.11781 19.19 9.24443 18.8525 9.41315L16.2188 10.7296C15.7918 10.943 15.4452 11.1169 15.1621 11.2403C14.881 11.3628 14.6039 11.4628 14.3184 11.4962C13.0513 11.6438 11.8486 10.9006 11.4141 9.70123C11.3162 9.43096 11.2817 9.13836 11.2656 8.83209C11.2494 8.52382 11.25 8.13628 11.25 7.65924C11.25 7.2818 11.2467 6.99251 11.2988 6.71979C11.4259 6.05623 11.7934 5.46218 12.3301 5.05182C12.5506 4.88327 12.81 4.75667 13.1475 4.58795L15.7812 3.27154C16.2082 3.05809 16.5548 2.8842 16.8379 2.7608C17.1191 2.63825 17.3961 2.53825 17.6816 2.50494Z"/><path d="M11.25 18V8C11.25 7.58579 11.5858 7.25 12 7.25C12.4142 7.25 12.75 7.58579 12.75 8V18C12.75 18.4142 12.4142 18.75 12 18.75C11.5858 18.75 11.25 18.4142 11.25 18Z" opacity=".5"/></g>',
};

/**
 * Slider fill. A range input shows its filled part through the --rf variable (0%..100%).
 * (The old --fill variable is also a plain colour in :root, which made some slider tracks invisible.)
 */
export function paintRange(el: HTMLInputElement): void {
  const min = parseFloat(el.min || '0'), max = parseFloat(el.max || '100'), v = parseFloat(el.value);
  const span = max - min || 1;
  el.style.setProperty('--rf', `${Math.max(0, Math.min(100, ((v - min) / span) * 100))}%`);
}
/** Keep every range slider in the app painted: at creation, while dragging and after code changes its value. */
export function installRangeFill(): void {
  const all = (root: ParentNode) => root.querySelectorAll<HTMLInputElement>('input[type=range]').forEach(paintRange);
  const onEvt = (e: Event) => { const t = e.target as HTMLElement | null; if (t instanceof HTMLInputElement && t.type === 'range') paintRange(t); };
  for (const ev of ['input', 'change', 'pointerdown', 'pointermove', 'pointerup']) document.addEventListener(ev, onEvt, true);
  new MutationObserver((list) => {
    for (const m of list) m.addedNodes.forEach((n) => {
      if (!(n instanceof HTMLElement)) return;
      if (n instanceof HTMLInputElement && n.type === 'range') paintRange(n); else all(n);
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
  // programmatic `input.value = x` does not fire events: a light re-paint keeps those sliders right too
  setInterval(() => { all(document); }, 500);
  all(document);
}

export function icon(name: keyof typeof ICON, size = 24): SVGElement {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', String(size));
  s.setAttribute('height', String(size));
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '2');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICON[name];
  return s;
}

export function iconButton(name: keyof typeof ICON, label: string, onclick: () => void, extra = ''): HTMLButtonElement {
  return h('button', { class: `btn iconbtn ${extra}`, 'aria-label': label, title: label, onclick }, icon(name));
}

export type TabName = 'edit' | 'projects' | 'agent' | 'me';

/** Bottom tab bar (Edit / Projects / AI Agent / Me), same place and shape as CapCut. */
export function tabBar(active: TabName, go: (t: TabName) => void): HTMLElement {
  const brandLogo = h('img', { class: 'tab-logo', src: logoUrl, alt: '', width: 26, height: 26, draggable: false });
  const tab = (name: TabName, label: string, ic: keyof typeof ICON | HTMLElement) =>
    h('button', { class: 'tab' + (active === name ? ' on' : ''), 'aria-label': label, onclick: () => go(name) }, typeof ic === 'string' ? icon(ic, 26) : ic, h('span', {}, label));
  // "Me": the signed-in Google account's photo and first name (Antigravity sign-in); plain icon + "Me" when nobody is signed in
  const meBtn = tab('me', 'Me', 'user');
  const paintMe = () => {
    const a = getAccount();
    const label = meBtn.querySelector('span') as HTMLElement;
    meBtn.firstElementChild?.remove();
    const face = a?.picture
      ? h('img', { class: 'tab-face', src: a.picture, alt: '', width: 26, height: 26, draggable: false })
      : a ? h('span', { class: 'tab-face tab-initial' }, (a.name || a.email || '?').trim().charAt(0).toUpperCase())
      : icon('user', 26);
    meBtn.insertBefore(face, label);
    label.textContent = a ? (firstName(a).slice(0, 9) || 'Me') : 'Me';
    meBtn.setAttribute('aria-label', a ? `Profile: ${a.name || a.email}` : 'Me');
  };
  paintMe();
  const offMe = onAccountChange(() => { if (!meBtn.isConnected) { offMe(); return; } paintMe(); });
  return h('nav', { class: 'tabbar' }, tab('edit', 'Edit', 'scissors'), tab('projects', 'Projects', 'folder'), tab('agent', 'AI Agent', brandLogo), meBtn);
}
