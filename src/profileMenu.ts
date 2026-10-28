import { app } from './app';
import { h, icon, toast } from './ui';
import { clearAccount, getAccount, onAccountChange } from './core/account';
import { EditorrNative, isNative } from './core/native';
import logo from './assets/logo.png';

export type MenuPage = 'profile' | 'settings' | 'none';

/** The account's photo (or first letter) when someone is signed in with Antigravity, else the app logo. Updates itself. */
export function avatar(size = 48): HTMLElement {
  const el = h('span', { class: 'pm-avatar', style: `width:${size}px;height:${size}px` });
  const paint = () => {
    const a = getAccount();
    if (a?.picture) el.replaceChildren(h('img', { src: a.picture, alt: '', draggable: 'false' }));
    else if (a) el.replaceChildren(h('span', { class: 'pm-initial', style: `font-size:${Math.round(size * 0.44)}px` }, (a.name || a.email || '?').trim().charAt(0).toUpperCase()));
    else el.replaceChildren(h('img', { src: logo, alt: '', draggable: 'false' }));
  };
  paint();
  const off = onAccountChange(() => { if (!el.isConnected) { off(); return; } paint(); });
  return el;
}

/**
 * Profile card (name + rows). Same card is used in the Home dropdown and on the Me page.
 * `close` is called before a row does something, so a dropdown can shut itself.
 */
export function profileMenu(current: MenuPage, close: () => void = () => {}): HTMLElement {
  const row = (ic: Parameters<typeof icon>[0], label: string, run: () => void, extra?: Node, on = false) =>
    h('button', { class: 'pm-row' + (on ? ' on' : ''), onclick: () => { close(); run(); } }, icon(ic, 22), h('span', { class: 'pm-label' }, label), extra ?? null);
  const soon = (what: string) => () => toast(`${what} is coming soon.`);
  const nameEl = h('div', { class: 'pm-name' }, 'Editorr');
  const subEl = h('div', { class: 'pm-sub' }, 'Podcast editor by Tuik');
  const signRow = h('button', { class: 'pm-row' }, icon('signOut', 22), h('span', { class: 'pm-label' }, 'Sign out')) as HTMLButtonElement;
  const paintWho = () => {
    const a = getAccount();
    nameEl.textContent = a?.name || a?.email || 'Editorr';
    subEl.textContent = a ? (a.name && a.email ? a.email : 'Signed in with Antigravity') : 'Podcast editor by Tuik';
    (signRow.querySelector('.pm-label') as HTMLElement).textContent = a ? 'Sign out of Antigravity' : 'Sign out';
  };
  signRow.onclick = () => {
    close();
    if (!getAccount()) { toast('You are not signed in. Everything stays on this phone.'); return; }
    if (!isNative()) { clearAccount(); return; }
    void EditorrNative.antigravityLogout().then(() => { clearAccount(); toast('Signed out of Antigravity.'); }).catch((e: Error) => toast(e.message || 'Could not sign out.'));
  };
  paintWho();
  const offWho = onAccountChange(() => { if (!nameEl.isConnected) { offWho(); return; } paintWho(); });
  return h('div', { class: 'pm-card' },
    h('div', { class: 'pm-head' },
      h('div', { class: 'pm-who' }, nameEl, subEl),
      avatar(48)),
    row('badgeCheck', 'Profile', () => app.go('profile'), undefined, current === 'profile'),
    row('community', 'Community', soon('Community'), h('span', { class: 'pm-plus' }, icon('plus', 14))),
    row('card', 'Subscription', soon('Subscription'), h('span', { class: 'pm-pro' }, icon('bolt', 12), 'PRO')),
    row('toggle', 'Settings', () => app.go('settings'), undefined, current === 'settings'),
    h('div', { class: 'pm-sep' }),
    row('helpInfo', 'Help center', soon('Help center')),
    signRow);
}
