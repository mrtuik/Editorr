import { app } from './app';
import { h, icon, toast } from './ui';
import logo from './assets/logo.png';

export type MenuPage = 'profile' | 'settings' | 'none';

/** Avatar with the app logo and a soft ring. */
export const avatar = (size = 48) =>
  h('span', { class: 'pm-avatar', style: `width:${size}px;height:${size}px` }, h('img', { src: logo, alt: '', draggable: 'false' }));

/**
 * Profile card (name + rows). Same card is used in the Home dropdown and on the Me page.
 * `close` is called before a row does something, so a dropdown can shut itself.
 */
export function profileMenu(current: MenuPage, close: () => void = () => {}): HTMLElement {
  const row = (ic: Parameters<typeof icon>[0], label: string, run: () => void, extra?: Node, on = false) =>
    h('button', { class: 'pm-row' + (on ? ' on' : ''), onclick: () => { close(); run(); } }, icon(ic, 22), h('span', { class: 'pm-label' }, label), extra ?? null);
  const soon = (what: string) => () => toast(`${what} is coming soon.`);
  return h('div', { class: 'pm-card' },
    h('div', { class: 'pm-head' },
      h('div', { class: 'pm-who' }, h('div', { class: 'pm-name' }, 'Editorr'), h('div', { class: 'pm-sub' }, 'Podcast editor by Tuik')),
      avatar(48)),
    row('badgeCheck', 'Profile', () => app.go('profile'), undefined, current === 'profile'),
    row('community', 'Community', soon('Community'), h('span', { class: 'pm-plus' }, icon('plus', 14))),
    row('card', 'Subscription', soon('Subscription'), h('span', { class: 'pm-pro' }, icon('bolt', 12), 'PRO')),
    row('toggle', 'Settings', () => app.go('settings'), undefined, current === 'settings'),
    h('div', { class: 'pm-sep' }),
    row('helpInfo', 'Help center', soon('Help center')),
    row('signOut', 'Sign out', () => toast('You are not signed in. Everything stays on this phone.')));
}
