import type { Project, Settings } from './core/types';
import { loadSettings, newProject } from './core/store';

export type ScreenName = 'home' | 'import' | 'sync' | 'analyze' | 'editor' | 'export' | 'settings';

export const app = {
  project: newProject() as Project,
  settings: loadSettings() as Settings,
  go: (_s: ScreenName) => {},
};

export function startNewProject(): void {
  app.project = newProject();
}
