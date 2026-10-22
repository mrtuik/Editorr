import { app, startNewProject } from '../app';
import { deleteProject, listProjects, saveProject } from '../core/store';
import { actionSheet, confirmDialog, fmtTime, h, iconButton, promptDialog } from '../ui';
import { runtime } from '../core/store';

export function homeScreen() {
  const list = h('div');
  const render = () => {
    const projects = listProjects();
    list.replaceChildren(
      ...(projects.length
        ? projects.map((p) =>
            h('div', {
              class: 'card row',
              onclick: () => openProject(p.id),
            },
              h('div', { class: 'thumb', role: 'img', 'aria-label': 'Project thumbnail' }),
              h('div', { class: 'grow' },
                h('div', { class: 'title' }, p.name),
                h('div', { class: 'cap' }, `${fmtTime(p.durationMs)} - ${new Date(p.updatedAt).toLocaleDateString()}`)),
              h('button', {
                class: 'btn iconbtn', 'aria-label': 'Project options', title: 'Options',
                onclick: (e: Event) => {
                  e.stopPropagation();
                  actionSheet([
                    { label: 'Rename', run: async () => { const n = await promptDialog('Rename project', p.name); if (n) { p.name = n; saveProject(p); render(); } } },
                    { label: 'Delete', danger: true, run: async () => { if (await confirmDialog('Delete project?', 'This removes the project, not your videos.')) { deleteProject(p.id); render(); } } },
                  ]);
                },
              }, '...')))
        : [h('div', { class: 'empty' }, 'No projects yet. Tap New project to start.')]),
    );
  };

  const openProject = (id: string) => {
    const p = listProjects().find((x) => x.id === id);
    if (!p) return;
    app.project = p;
    if (!runtime.hostUrl || !runtime.constUrl || !runtime.hostPcm || !runtime.constPcm) {
      // Media is not kept between launches in the web build: re-pick the two videos.
      app.go('import');
    } else app.go('editor');
  };

  render();
  const el = h('div', { class: 'screen' },
    h('div', { class: 'topbar' },
      h('h1', {}, 'Editorr'),
      iconButton('gear', 'Settings', () => app.go('settings'))),
    h('div', { class: 'content' }, list),
    h('div', { class: 'bottombar' },
      h('button', { class: 'btn primary', onclick: () => { startNewProject(); runtime.hostUrl = runtime.constUrl = undefined; runtime.hostPcm = runtime.constPcm = undefined; app.go('import'); } }, 'New project')));
  return { el };
}
