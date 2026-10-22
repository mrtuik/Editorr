import type { Project, Settings } from './core/types';
import { DEFAULT_SETTINGS, newProject } from './core/store';

export type Intent = 'silence' | 'crop' | 'ratio';
export type HomeTab = 'edit' | 'projects';
export type ScreenName = 'home' | 'import' | 'sync' | 'analyze' | 'editor' | 'export' | 'settings';

export const app = {
  project: newProject() as Project,
  settings: { ...DEFAULT_SETTINGS } as Settings,
  /** Tool picked on Home: the editor opens that panel first. */
  intent: undefined as Intent | undefined,
  homeTab: 'edit' as HomeTab,
  go: (_s: ScreenName) => {},
};

export function startNewProject(): void {
  app.project = newProject();
}
