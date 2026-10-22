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
