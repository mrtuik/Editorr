import './style.css';
import { app, ScreenName } from './app';
import { homeScreen } from './screens/home';
import { importScreen } from './screens/import';
import { syncScreen } from './screens/sync';
import { analyzeScreen } from './screens/analyze';
import { editorScreen } from './screens/editor';
import { exportScreen } from './screens/export';
import { settingsScreen } from './screens/settings';

const root = document.getElementById('app')!;
let cleanup: (() => void) | undefined;

const screens: Record<ScreenName, () => { el: HTMLElement; destroy?: () => void }> = {
  home: homeScreen,
  import: importScreen,
  sync: syncScreen,
  analyze: analyzeScreen,
  editor: editorScreen,
  export: exportScreen,
  settings: settingsScreen,
};

function go(name: ScreenName): void {
  cleanup?.();
  const s = screens[name]();
  cleanup = s.destroy;
  root.replaceChildren(s.el);
  history.replaceState({ name }, '');
}
app.go = go;

// Android back button: step back through the flow.
const backMap: Partial<Record<ScreenName, ScreenName>> = {
  import: 'home', sync: 'import', analyze: 'sync', editor: 'home', export: 'editor', settings: 'home',
};
let current: ScreenName = 'home';
const origGo = go;
app.go = (n) => { current = n; origGo(n); };
document.addEventListener('backbutton', () => { const b = backMap[current]; if (b) app.go(b); });
window.addEventListener('popstate', () => { const b = backMap[current]; if (b) app.go(b); });

app.go('home');
