import type { Project, Settings } from './core/types';
import { DEFAULT_SETTINGS, newProject } from './core/store';

export type Intent = 'silence' | 'crop' | 'ratio' | 'sync';
export type HomeTab = 'edit' | 'projects' | 'agent';
export type ScreenName = 'home' | 'import' | 'editor' | 'export' | 'settings' | 'profile';

export const app = {
  project: newProject() as Project,
  settings: { ...DEFAULT_SETTINGS } as Settings,
  /** Tool picked on Home: the editor opens that panel first. */
  intent: undefined as Intent | undefined,
  homeTab: 'edit' as HomeTab,
  go: (_s: ScreenName) => {},
  /** The open screen can handle the Android back button first (close a panel, leave full screen). Return true when handled. */
  onBack: undefined as (() => boolean) | undefined,
};

export function startNewProject(): void {
  app.project = newProject();
}
