import { app } from '../app';
import { profileMenu } from '../profileMenu';
import { h, tabBar } from '../ui';

/** "Me" page: the profile card, same as the dropdown on Home. */
export function profileScreen() {
  const el = h('div', { class: 'screen profile' },
    h('div', { class: 'content pm-page' }, profileMenu('profile')),
    tabBar('me', (tab) => { if (tab === 'me') return; app.homeTab = tab; app.go('home'); }));
  return { el };
}
