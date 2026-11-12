import { app, startNewProject, type Intent } from '../app';
import { deleteProject, listProjects, runtime, saveProject } from '../core/store';
import type { Project } from '../core/types';
import { attachProjectMedia, isLoaded, removeProjectMedia } from '../core/media';
import { profileMenu, avatar } from '../profileMenu';
import { EditorrNative, fileSrc, isNative } from '../core/native';
import { pickVideosCapcut } from './mediaPicker';
import { agentScreen } from './agentScreen';
import { probeVideo } from '../core/audio';
import { saveMedia } from '../core/store';
import { aspectForVideo, type VideoRef } from '../core/types';
import { actionSheet, confirmDialog, fmtTime, h, ICON, icon, projectActionSheet, promptDialog, spinner, tabBar, TabName, toast } from '../ui';

/**
 * Home, laid out like CapCut: search at the top, big "Get started" heading, two big cards,
 * a strip of recent projects, a 3-column tool grid and a bottom tab bar (Edit / Projects / Me).
 * Colors stay Editorr black.
 */
export function homeScreen() {
  let query = '';
  let searching = false;
  /** Projects tab, like CapCraft: Local / Trash, and Select mode with a ticked set. */
  let showTrash = false;
  let selecting = false;
  const ticked = new Set<string>();
  const body = h('div', { class: 'home' });

  // projects come from IndexedDB (async), so Home keeps its own copy and reloads it when something changes
  let projects: Project[] = [];
  let loaded = false;
  async function reload() { projects = await listProjects(); loaded = true; render(); }
  const all = () => projects.filter((p) => !p.trashedAt && p.name.toLowerCase().includes(query.toLowerCase()));
  const trashed = () => projects.filter((p) => !!p.trashedAt && p.name.toLowerCase().includes(query.toLowerCase()));
  /** A new draft is named by date and a count for the day, as phone editors do ("1112-02"). */
  const draftName = () => {
    const d = new Date(); const day = `${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const n = projects.filter((x) => x.name.startsWith(`${day}-`)).length + 1;
    return `${day}-${String(n).padStart(2, '0')}`;
  };
  const shortDate = (t: number) => { const d = new Date(t); return `${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; };

  let picking = false;
  /**
   * New project (and every tool except Auto switch / Auto sync): the video picker opens straight away,
   * ONE video is enough and the editor opens right after. Host and Constant both point at that file.
   */
  async function newSingleProject(intent?: Intent) {
    if (picking) return;
    picking = true;
    try {
      let ref: VideoRef | undefined;
      let path: string | undefined;
      let file: File | undefined;
      if (isNative()) {
        const box = h('div', { class: 'dialog' }, h('div', { class: 'box row' }, spinner(24), h('div', { class: 'title' }, 'Adding video...')));
        let shown = false;
        const sub = await EditorrNative.addListener('copyProgress', () => { if (!shown) { shown = true; document.body.append(box); } });
        try {
          const res = await pickVideosCapcut({ max: 1 });
          const v = res.videos[0];
          if (!v) return;
          path = v.path;
          ref = { name: v.name, url: fileSrc(v.path), uri: 'file://' + v.path, durationMs: v.durationMs, width: v.width, height: v.height, fps: v.fps || 30, codec: v.codec, bitrate: v.bitrate };
        } finally { sub.remove().catch(() => {}); box.remove(); }
      } else {
        file = await new Promise<File | undefined>((resolve) => {
          const input = h('input', { type: 'file', accept: 'video/*' }) as HTMLInputElement;
          input.onchange = () => resolve(input.files?.[0]);
          input.addEventListener('cancel', () => resolve(undefined));
          input.click();
        });
        if (!file) return;
        const url = URL.createObjectURL(file);
        const meta = await probeVideo(url);
        ref = { name: file.name, url, durationMs: meta.durationMs, width: meta.width, height: meta.height, fps: 30 };
      }
      if (!ref) return;

      startNewProject();
      app.intent = intent;
      const p = app.project;
      p.name = draftName();
      const { url: _u, ...meta } = ref;
      p.host = { ...meta }; p.constant = { ...meta };
      p.single = true;
      p.mainAudio = 'host';
      p.offsetMs = 0; p.durationMs = ref.durationMs; p.segments = [];
      if (ref.width && ref.height) p.aspect = aspectForVideo(ref.width, ref.height);
      runtime.projectId = p.id;
      runtime.hostUrl = runtime.constUrl = ref.url;
      runtime.hostPath = runtime.constPath = path;
      runtime.hostFile = runtime.constFile = file;
      runtime.hostPcm = runtime.constPcm = undefined;
      runtime.hostMotion = runtime.constMotion = undefined;
      runtime.hostFaces = runtime.constFaces = undefined;
      await saveProject(p);
      if (!isNative()) { await saveMedia(p.id, 'host', file, ref.name); await saveMedia(p.id, 'constant', file, ref.name); }
      app.go('editor');
    } catch (e) {
      const m = (e as Error).message || '';
      if (!/cancel/i.test(m)) toast(m || 'Could not open this video.');
    } finally { picking = false; }
  }

  /** Auto switch / Auto sync: two videos (Host + Constant) on the Import screen. */
  function newProject(intent?: Intent) {
    startNewProject();
    app.project.name = draftName();
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

  async function moveToTrash(list: Project[]) {
    for (const p of list) { p.trashedAt = Date.now(); await saveProject(p); }
    ticked.clear(); await reload();
    toast(list.length > 1 ? `${list.length} projects moved to the Trash` : 'Moved to the Trash');
  }
  async function restore(list: Project[]) {
    for (const p of list) { delete p.trashedAt; await saveProject(p); }
    ticked.clear(); await reload();
    toast('Restored');
  }
  async function eraseForever(list: Project[]) {
    if (!list.length) return;
    if (!(await confirmDialog(list.length > 1 ? `Delete ${list.length} projects forever?` : 'Delete forever?', 'The project and its saved video copies are removed for good. The originals in your gallery stay.'))) return;
    for (const p of list) { await removeProjectMedia(p); await deleteProject(p.id); }
    ticked.clear(); await reload();
  }
  function options(p: Project) {
    projectActionSheet(p, [
      { label: 'Rename', iconName: 'edit', run: async () => { const n = await promptDialog('Rename project', p.name); if (n) { p.name = n; await saveProject(p); reload(); } } },
      { label: 'Duplicate', iconName: 'duplicate', run: () => duplicateProject(p) },
      { label: 'Move to Trash', iconName: 'trash', danger: true, run: async () => { await moveToTrash([p]); } },
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
    return h('div', { class: 'htop' + (searching ? ' searching' : '') }, av, searching ? input : h('div', { class: 'htitle' }, 'Editorr', h('i', {}, '.')), btn);
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
    const last = projects.find((x) => !x.trashedAt);

    const auto: [keyof typeof ICON, string, string, () => void][] = [
      ['switchSlider', 'Auto switch', 'Cuts between two mics', () => newProject()],
      ['sync', 'Auto sync', 'Line up two videos', () => newProject()],
      ['silence', 'Silence cut', 'Remove quiet parts', () => newSingleProject('silence')],
      ['lips', 'Lips scan', 'Find who is talking', () => newSingleProject()],
    ];
    const basic: [keyof typeof ICON, string, () => void][] = [
      ['crop', 'Crop', () => newSingleProject('crop')],
      ['ratio', 'Aspect ratio', () => newSingleProject('ratio')],
      ['layout', 'Layouts', () => newSingleProject()],
      ['volume', 'Audio source', () => newSingleProject()],
      ['gear', 'Settings', () => app.go('settings')],
    ];

    return [
      h('div', { class: 'hero' }, h('div', { class: 'small' }, 'Podcast editor'), h('h1', {}, 'Get started')),
      h('div', { class: 'cards' },
        h('button', { class: 'bigcard', onclick: () => newSingleProject() }, icon('newVideo', 34), 'New project'),
        h('button', { class: 'bigcard', disabled: !last, onclick: () => last && openProject(last) }, icon('resume', 34), 'Continue')),
      list.length
        ? h('div', { class: 'recent' },
            ...list.slice(0, 6).map((p) => h('button', { class: 'rthumb', style: thumbStyle(p), 'aria-label': p.name, onclick: () => openProject(p) }, h('span', {}, `${shortDate(p.updatedAt)}-${p.name}`))),
            h('button', { class: 'rthumb more', 'aria-label': 'All projects', onclick: () => { app.homeTab = 'projects'; render(); } }, icon('chevR', 24)))
        : null,
      h('div', { class: 'sechead' }, 'Smart tools'),
      h('div', { class: 'autogrid' }, ...auto.map(([ic, label, sub, run]) => h('button', { class: 'autocell', onclick: run },
        h('span', { class: 'tico' }, icon(ic, 24)), h('span', { class: 'ttxt' }, h('b', {}, label), h('small', {}, sub))))),
      h('div', { class: 'sechead' }, 'Basics'),
      h('div', { class: 'tools' }, ...basic.map(([ic, label, run]) => h('button', { class: 'toolcell', onclick: run }, h('span', { class: 'tico' }, icon(ic, 24)), label))),
    ];
  }

  const durText = (ms: number) => fmtTime(ms);
  function projectsTab() {
    const list = showTrash ? trashed() : all();
    const chosen = () => list.filter((p) => ticked.has(p.id));
    const seg = h('div', { class: 'psegs' },
      ...([['Local', false], ['Trash', true]] as [string, boolean][]).map(([label, isTrash]) =>
        h('button', { class: 'pseg' + (showTrash === isTrash ? ' on' : ''), onclick: () => { showTrash = isTrash; selecting = false; ticked.clear(); renderContent(); } }, label)));
    const head = h('div', { class: 'phead' },
      h('div', { class: 'pcount' }, `${list.length} project${list.length === 1 ? '' : 's'}`),
      list.length ? h('button', { class: 'plink', onclick: () => { selecting = !selecting; ticked.clear(); renderContent(); } }, selecting ? 'Done' : 'Select') : null);
    const row = (p: Project) => {
      const on = ticked.has(p.id);
      return h('div', { class: 'prow' + (on ? ' sel' : ''), onclick: () => {
        if (selecting) { if (on) ticked.delete(p.id); else ticked.add(p.id); renderContent(); }
        else if (showTrash) options(p);
        else openProject(p);
      } },
        selecting ? h('span', { class: 'ptick' + (on ? ' on' : '') }, on ? icon('check', 14) : '') : null,
        h('div', { class: 'prthumb', style: thumbStyle(p) }, h('span', { class: 'tag-duration' }, durText(p.durationMs))),
        h('div', { class: 'prinfo' },
          h('div', { class: 'title' }, p.name),
          h('div', { class: 'cap' }, `${new Date(p.updatedAt).toLocaleString(undefined, { month: '2-digit', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${p.aspect || '9:16'}`)),
        !selecting ? h('button', { class: 'popt', 'aria-label': 'Project options', onclick: (e: Event) => { e.stopPropagation(); options(p); } }, icon('more', 20)) : null);
    };
    const bar = selecting
      ? h('div', { class: 'pselbar' },
          h('button', { class: 'plink', onclick: () => { if (chosen().length === list.length) ticked.clear(); else list.forEach((p) => ticked.add(p.id)); renderContent(); } }, chosen().length === list.length && list.length ? 'Deselect all' : 'Select all'),
          h('div', { class: 'grow' }),
          showTrash ? h('button', { class: 'plink', disabled: !ticked.size, onclick: () => restore(chosen()) }, 'Restore') : null,
          h('button', { class: 'plink danger', disabled: !ticked.size, onclick: () => (showTrash ? eraseForever(chosen()) : moveToTrash(chosen())) }, showTrash ? 'Delete forever' : 'Move to Trash'))
      : null;
    return [
      h('div', { class: 'hero', style: 'margin-top:12px' }, h('h1', { style: 'font-size:26px' }, 'Projects')),
      seg, head,
      list.length
        ? h('div', { class: 'plist' }, ...list.map(row))
        : loaded ? h('div', { class: 'empty' }, query ? 'No project matches your search.' : showTrash ? 'The Trash is empty.' : 'No projects yet. Go to Edit and tap New project.') : null,
      bar,
    ];
  }

  function renderContent() { content.replaceChildren(...((app.homeTab === 'projects' ? projectsTab() : editTab()).filter(Boolean) as Node[])); }

  /** AI Agent tab: created once so the chat stays when you switch tabs. */
  let agent: ReturnType<typeof agentScreen> | undefined;

  function render() {
    const tab = (t: TabName) => {
      if (t === 'me') { app.go('profile'); return; }
      app.homeTab = t; searching = false; query = ''; render();
    };
    if (app.homeTab === 'agent') {
      agent ??= agentScreen();
      body.replaceChildren(agent.el, tabBar('agent', tab));
      return;
    }
    renderContent();
    body.replaceChildren(topBar(), content, tabBar(app.homeTab, tab));
  }

  render();
  reload();
  return { el: h('div', { class: 'screen' }, body), destroy: () => agent?.destroy() };
}
