import { app, startNewProject, type Intent } from '../app';
import { deleteProject, listProjects, runtime, saveProject } from '../core/store';
import type { Project } from '../core/types';
import { isLoaded, loadProjectMedia, removeProjectMedia } from '../core/media';
import { actionSheet, confirmDialog, fmtTime, h, ICON, icon, progressBar, promptDialog, tabBar, TabName, toast } from '../ui';

/**
 * Home, laid out like CapCut: search at the top, big "Get started" heading, two big cards,
 * a strip of recent projects, a 3-column tool grid and a bottom tab bar (Edit / Projects / Me).
 * Colors stay Editorr black.
 */
export function homeScreen() {
  let query = '';
  let searching = false;
  const body = h('div', { class: 'home' });

  // projects come from IndexedDB (async), so Home keeps its own copy and reloads it when something changes
  let projects: Project[] = [];
  let loaded = false;
  async function reload() { projects = await listProjects(); loaded = true; render(); }
  const all = () => projects.filter((p) => p.name.toLowerCase().includes(query.toLowerCase()));
  const shortDate = (t: number) => { const d = new Date(t); return `${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; };

  function newProject(intent?: Intent) {
    startNewProject();
    app.intent = intent;
    runtime.projectId = undefined;
    runtime.hostUrl = runtime.constUrl = undefined;
    runtime.hostPcm = runtime.constPcm = undefined;
    app.go('import');
  }

  let opening = false;
  /** Saved videos still on the phone: decode audio again and go straight to the editor. Otherwise ask for the videos. */
  async function openProject(p: Project) {
    if (opening) return;
    app.project = p;
    if (isLoaded(p)) { app.go('editor'); return; }
    if (!p.segments.length) { app.go('import'); return; } // never finished sync/analyze
    opening = true;
    const pb = progressBar();
    const box = h('div', { class: 'dialog' }, h('div', { class: 'box' }, h('div', { class: 'title' }, 'Opening project'), h('div', { class: 'cap' }, 'Reading audio from the saved videos'), pb.el));
    document.body.append(box);
    let ok = false;
    try { ok = await loadProjectMedia(p, (x) => pb.set(x)); } catch (e) { toast(`Could not open the videos: ${(e as Error).message}`); }
    box.remove();
    opening = false;
    if (ok) app.go('editor');
    else { toast('The saved videos were not found. Pick them again.'); app.go('import'); }
  }

  function options(p: Project) {
    actionSheet([
      { label: 'Rename', run: async () => { const n = await promptDialog('Rename project', p.name); if (n) { p.name = n; await saveProject(p); reload(); } } },
      { label: 'Delete', danger: true, run: async () => { if (await confirmDialog('Delete project?', 'The project and its saved video copies are removed. The originals in your gallery stay.')) { await removeProjectMedia(p); await deleteProject(p.id); reload(); } } },
    ]);
  }

  const thumbStyle = (p: Project) => (p.thumb ? `background-image:url(${p.thumb})` : '');

  function topBar() {
    const input = h('input', { type: 'text', placeholder: 'Search projects', value: query, 'aria-label': 'Search projects' }) as HTMLInputElement;
    input.addEventListener('input', () => { query = input.value; renderContent(); });
    const btn = h('button', {
      class: 'circbtn', 'aria-label': searching ? 'Close search' : 'Search',
      onclick: () => { searching = !searching; if (!searching) query = ''; if (searching) app.homeTab = 'projects'; render(); if (searching) (body.querySelector('input') as HTMLInputElement | null)?.focus(); },
    }, icon(searching ? 'close' : 'search', 22));
    return h('div', { class: 'htop' }, searching ? input : null, btn);
  }

  const content = h('div', { class: 'scroll' });

  function editTab() {
    const list = all();
    const last = projects[0];
    const tools: [keyof typeof ICON, string, () => void][] = [
      ['wand', 'Auto switch', () => newProject()],
      ['lips', 'Lips scan', () => newProject()],
      ['silence', 'Silence cut', () => newProject('silence')],
      ['crop', 'Crop', () => newProject('crop')],
      ['ratio', 'Aspect ratio', () => newProject('ratio')],
      ['layout', 'Layouts', () => newProject()],
      ['sync', 'Auto sync', () => newProject()],
      ['volume', 'Audio source', () => newProject()],
      ['gear', 'Settings', () => app.go('settings')],
    ];
    return [
      h('div', { class: 'hero' }, h('div', { class: 'small' }, 'Podcast editor'), h('h1', {}, 'Get started')),
      h('div', { class: 'cards' },
        h('button', { class: 'bigcard', onclick: () => newProject() }, icon('newVideo', 34), 'New project'),
        h('button', { class: 'bigcard', disabled: !last, onclick: () => last && openProject(last) }, icon('resume', 34), 'Continue')),
      list.length
        ? h('div', { class: 'recent' },
            ...list.slice(0, 6).map((p) => h('button', { class: 'rthumb', style: thumbStyle(p), 'aria-label': p.name, onclick: () => openProject(p) }, h('span', {}, `${shortDate(p.updatedAt)}-${p.name}`))),
            h('button', { class: 'rthumb more', 'aria-label': 'All projects', onclick: () => { app.homeTab = 'projects'; render(); } }, icon('chevR', 24)))
        : null,
      h('div', { class: 'tools' }, ...tools.map(([ic, label, run]) => h('button', { class: 'toolcell', onclick: run }, icon(ic, 28), label))),
    ];
  }

  function projectsTab() {
    const list = all();
    return [
      h('div', { class: 'hero', style: 'margin-top:12px' }, h('h1', { style: 'font-size:26px' }, 'Projects')),
      list.length
        ? h('div', { class: 'pgrid' }, ...list.map((p) =>
            h('div', { class: 'pcard', onclick: () => openProject(p) },
              h('div', { class: 'pimg', style: thumbStyle(p) }),
              h('button', { class: 'opt', 'aria-label': 'Project options', onclick: (e: Event) => { e.stopPropagation(); options(p); } }, icon('more', 20)),
              h('div', { class: 'pmeta' }, h('div', { class: 'title' }, p.name), h('div', { class: 'cap' }, `${fmtTime(p.durationMs)} - ${new Date(p.updatedAt).toLocaleDateString()}`)))))
        : loaded ? h('div', { class: 'empty' }, query ? 'No project matches your search.' : 'No projects yet. Go to Edit and tap New project.') : null,
    ];
  }

  function renderContent() { content.replaceChildren(...((app.homeTab === 'projects' ? projectsTab() : editTab()).filter(Boolean) as Node[])); }

  function render() {
    renderContent();
    const tab = (t: TabName) => {
      if (t === 'me') { app.go('settings'); return; }
      app.homeTab = t; searching = false; query = ''; render();
    };
    body.replaceChildren(topBar(), content, tabBar(app.homeTab, tab));
  }

  render();
  reload();
  return { el: h('div', { class: 'screen' }, body) };
}
