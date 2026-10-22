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

export function progressBar(): { el: HTMLElement; set: (pct: number) => void } {
  const bar = h('i');
  const el = h('div', { class: 'progress' }, bar);
  return { el, set: (p) => { bar.style.width = `${Math.max(0, Math.min(100, p))}%`; } };
}

export const ICON = {
  back: '<path d="M15 5l-7 7 7 7" />',
  plus: '<path d="M12 5v14M5 12h14" />',
  play: '<path d="M8 5l11 7-11 7z" fill="currentColor"/>',
  pause: '<path d="M8 5v14M16 5v14" />',
  undo: '<path d="M9 7L4 12l5 5M4 12h11a5 5 0 010 10h-3" />',
  redo: '<path d="M15 7l5 5-5 5M20 12H9a5 5 0 000 10h3" />',
  back10: '<path d="M11 6L5 12l6 6M19 6l-6 6 6 6" />',
  fwd10: '<path d="M13 6l6 6-6 6M5 6l6 6-6 6" />',
  full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" />',
  swap: '<path d="M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7" />',
  one: '<rect x="4" y="5" width="16" height="14" rx="2" />',
  side: '<rect x="3" y="6" width="8" height="12" rx="1"/><rect x="13" y="6" width="8" height="12" rx="1"/>',
  updown: '<rect x="5" y="3" width="14" height="8" rx="1"/><rect x="5" y="13" width="14" height="8" rx="1"/>',
  popup: '<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="13" y="12" width="6" height="5" rx="1" fill="currentColor"/>',
  wand: '<path d="M5 19L17 7M14 4l1.2 2.3L17.5 7.5l-2.3 1.2L14 11l-1.2-2.3L10.5 7.5l2.3-1.2zM19 13l.7 1.3 1.3.7-1.3.7-.7 1.3-.7-1.3-1.3-.7 1.3-.7z" />',
  lips: '<path d="M2.5 12c3-4.5 6-4.5 9.5-2.5 3.500-2 6.500-2 9.500 2.500-3 5-6 6.500-9.500 6.500S5.500 17 2.500 12.500zM2.500 12.500h19" />',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.5 8l11.500 9M8.500 16L20 7" />',
  layout: '<rect x="3" y="3" width="8" height="8" rx="1.500"/><rect x="13" y="3" width="8" height="8" rx="1.500"/><rect x="3" y="13" width="8" height="8" rx="1.500"/><rect x="13" y="13" width="8" height="8" rx="1.500"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.500 3.500-7 8-7s8 2.500 8 7" />',
  volume: '<path d="M4 9v6h4l5 4V5L8 9H4zM16.500 8.500a5 5 0 010 7M19 6a8.500 8.500 0 010 12" />',
  merge: '<path d="M10 14a4 4 0 005.700 0l3-3a4 4 0 00-5.700-5.700l-1 1M14 10a4 4 0 00-5.700 0l-3 3a4 4 0 005.700 5.700l1-1" />',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />',
  export: '<path d="M12 15V3M7.500 7.500L12 3l4.500 4.500M5 13v7h14v-7" />',
  close: '<path d="M6 6l12 12M18 6L6 18" />',
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
  crop: '<path d="M6 2v14a2 2 0 002 2h14M2 6h14a2 2 0 012 2v14" />',
  ratio: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h2M7 10v2M17 14h-2M17 14v-2" />',
  silence: '<path d="M2 12h3M19 12h3M8 8v8M12 5v14M16 8v8" /><path d="M3 3l18 18" />',
  folder: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />',
  chevR: '<path d="M9 5l7 7-7 7" />',
  resume: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5l5 3.5-5 3.5z" fill="currentColor"/>',
  sync: '<path d="M4 12a8 8 0 0113.5-5.8L20 8.5M20 4v4.5h-4.5M20 12a8 8 0 01-13.5 5.8L4 15.5M4 20v-4.5h4.5" />',
  more: '<circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/>',
  newVideo: '<rect x="3" y="3" width="18" height="18" rx="4" fill="currentColor" stroke="none"/><path d="M12 8v8M8 12h8" stroke="#000" />',
};

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

export type TabName = 'edit' | 'projects' | 'me';

/** Bottom tab bar (Edit / Projects / Me), same place and shape as CapCut. */
export function tabBar(active: TabName, go: (t: TabName) => void): HTMLElement {
  const tab = (name: TabName, label: string, ic: keyof typeof ICON) =>
    h('button', { class: 'tab' + (active === name ? ' on' : ''), 'aria-label': label, onclick: () => go(name) }, icon(ic, 26), h('span', {}, label));
  return h('nav', { class: 'tabbar' }, tab('edit', 'Edit', 'scissors'), tab('projects', 'Projects', 'folder'), tab('me', 'Me', 'user'));
}
