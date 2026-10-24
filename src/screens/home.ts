import { app, startNewProject, type Intent } from '../app';
import { deleteProject, listProjects, runtime, saveProject } from '../core/store';
import type { Project } from '../core/types';
import { attachProjectMedia, isLoaded, removeProjectMedia } from '../core/media';
import { profileMenu, avatar } from '../profileMenu';
import { actionSheet, confirmDialog, fmtTime, h, ICON, icon, projectActionSheet, promptDialog, spinner, tabBar, TabName, toast } from '../ui';

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
    runtime.hostPath = runtime.constPath = undefined;
    runtime.hostFile = runtime.constFile = undefined;
    runtime.hostPcm = runtime.constPcm = undefined;
    runtime.hostMotion = runtime.constMotion = undefined;
    runtime.hostFaces = runtime.constFaces = undefined;
    app.go('import');
  }

  let opening = false;
  /** Saved videos still on the phone: go straight to the editor (it reads the audio again with a progress pill). Otherwise ask for the videos. */
  async function openProject(p: Project) {
    if (opening) return;
    app.project = p;
    if (isLoaded(p)) { app.go('editor'); return; }
    if (!p.host || !p.constant) { app.go('import'); return; } // never picked both videos
    opening = true;
    const box = h('div', { class: 'dialog' }, h('div', { class: 'box row' }, spinner(24), h('div', { class: 'title' }, 'Opening project...')));
    document.body.append(box);
    let ok = false;
    try { ok = await attachProjectMedia(p); } catch (e) { toast(`Could not open the videos: ${(e as Error).message}`); }
    box.remove();
    opening = false;
    // Missing videos: the editor opens with a black preview and a message (like CapCut) instead of throwing the user to Import.
    if (!ok && runtime.projectId !== p.id) { runtime.hostUrl = runtime.constUrl = undefined; runtime.hostPath = runtime.constPath = undefined; }
    app.go('editor');
  }

  async function duplicateProject(p: Project) {
    const dup: Project = structuredClone(p);
    dup.id = (Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    dup.name = `${p.name} (Copy)`;
    dup.createdAt = Date.now();
    dup.updatedAt = Date.now();
    await saveProject(dup);
    await reload();
    toast('Project duplicated');
  }

  function options(p: Project) {
    projectActionSheet(p, [
      { label: 'Rename', iconName: 'edit', run: async () => { const n = await promptDialog('Rename project', p.name); if (n) { p.name = n; await saveProject(p); reload(); } } },
      { label: 'Duplicate', iconName: 'duplicate', run: () => duplicateProject(p) },
      { label: 'Delete', iconName: 'trash', danger: true, run: async () => { if (await confirmDialog('Delete project?', 'The project and its saved video copies are removed. The originals in your gallery stay.')) { await removeProjectMedia(p); await deleteProject(p.id); reload(); } } },
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
    const av = h('button', { class: 'avatarbtn', 'aria-label': 'Profile menu', 'aria-haspopup': 'menu', onclick: openMenu }, avatar(40));
    return h('div', { class: 'htop' }, av, searching ? input : null, btn);
  }

  /** Dropdown under the avatar (top left), with the same card as the Me page. */
  function openMenu() {
    const shut = () => pop.remove();
    const pop = h('div', { class: 'pm-pop', onclick: (e: Event) => { if (e.target === pop) shut(); } }, h('div', { class: 'pm-drop' }, profileMenu('none', shut)));
    document.body.append(pop);
  }

  const content = h('div', { class: 'scroll' });

  function editTab() {
    const list = all();
    const last = projects[0];

    const tools: [keyof typeof ICON, string, () => void][] = [
      ['switchSlider', 'Auto switch', () => newProject()],
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
              h('div', { class: 'pimg', style: thumbStyle(p) },
                h('span', { class: 'tag-aspect' }, p.aspect || '9:16'),
                h('span', { class: 'tag-duration' }, fmtTime(p.durationMs))),
              h('button', { class: 'opt', 'aria-label': 'Project options', onclick: (e: Event) => { e.stopPropagation(); options(p); } }, icon('more', 20)),
              h('div', { class: 'pmeta' },
                h('div', { class: 'title' }, p.name),
                h('div', { class: 'cap' }, `${new Date(p.updatedAt).toLocaleDateString()}`)))))
        : loaded ? h('div', { class: 'empty' }, query ? 'No project matches your search.' : 'No projects yet. Go to Edit and tap New project.') : null,
    ];
  }

  function renderContent() { content.replaceChildren(...((app.homeTab === 'projects' ? projectsTab() : editTab()).filter(Boolean) as Node[])); }

  function render() {
    renderContent();
    const tab = (t: TabName) => {
      if (t === 'me') { app.go('profile'); return; }
      app.homeTab = t; searching = false; query = ''; render();
    };
    body.replaceChildren(topBar(), content, tabBar(app.homeTab, tab));
  }

  render();
  reload();
  return { el: h('div', { class: 'screen' }, body) };
}
