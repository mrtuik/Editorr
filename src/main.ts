import './style.css';
import { app, ScreenName } from './app';
import { homeScreen } from './screens/home';
import { importScreen } from './screens/import';
import { editorScreen } from './screens/editor';
import { exportScreen } from './screens/export';
import { settingsScreen } from './screens/settings';
import { initStorage, listProjects, loadSettings } from './core/store';
import { pruneUnusedVideos } from './core/media';

const root = document.getElementById('app')!;
let cleanup: (() => void) | undefined;

const screens: Record<ScreenName, () => { el: HTMLElement; destroy?: () => void }> = {
  home: homeScreen,
  import: importScreen,
  editor: editorScreen,
  export: exportScreen,
  settings: settingsScreen,
};

function go(name: ScreenName): void {
  cleanup?.();
  app.onBack = undefined;
  const s = screens[name]();
  cleanup = s.destroy;
  root.replaceChildren(s.el);
  history.replaceState({ name }, '');
}
app.go = go;

// Android back button: step back through the flow.
const backMap: Partial<Record<ScreenName, ScreenName>> = {
  import: 'home', editor: 'home', export: 'editor', settings: 'home',
};
let current: ScreenName = 'home';
const origGo = go;
app.go = (n) => { current = n; origGo(n); };
const back = () => { if (app.onBack?.()) return; const b = backMap[current]; if (b) app.go(b); };
document.addEventListener('backbutton', back);
window.addEventListener('popstate', back);

// Open the database first, then show Home with the saved settings and projects.
(async () => {
  try {
    await initStorage();
    app.settings = await loadSettings();
  } catch { /* storage unavailable: start with defaults */ }
  try {
    // strict: if the database cannot be read we must NOT think "no projects" and delete every saved video
    pruneUnusedVideos(await listProjects(true));
  } catch { /* skip cleanup this launch */ }
  app.go('home');
})();
