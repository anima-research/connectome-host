import { isAbsolute, join, resolve } from 'node:path';
import type { MountConfig, WorkspaceConfig } from '@animalabs/agent-framework';
import type { RecipeModules, RecipeWorkspaceMount } from './recipe.js';

export function buildWorkspaceMounts(
  workspace: RecipeModules['workspace'],
  storePath: string,
): MountConfig[] | null {
  if (workspace === false) return null;

  let mounts: MountConfig[];
  if (typeof workspace === 'object' && workspace.mounts) {
    mounts = workspace.mounts.map(({ path, mode, watch, ...rest }: RecipeWorkspaceMount): MountConfig => ({
      ...rest,
      path: resolve(path),
      mode: mode ?? 'read-write',
      watch: watch ?? 'never',
    }));
  } else {
    mounts = [
      { name: 'input', path: resolve('./input'), mode: 'read-only', watch: 'never' },
      { name: 'products', path: resolve('./output'), mode: 'read-write', watch: 'never' },
    ];
  }

  // A branch switch or a rollback rewinds this mount through
  // agent-framework's materializeMount, which does nothing for a direct
  // mount, so its backend is said rather than left to the framework's
  // default. An undo moves no branch (agent-framework #291), so it leaves the
  // mount as it is. The gate keeps the recipe it last applied in
  // gate.recipe.json beside gate.json and reads it at each start, so a rewind
  // takes it back with gate.json. The include keeps editors' and recovery
  // files out (anima-research/connectome-host#278); each name covers that
  // name in any directory beneath as well, since agent-framework's include
  // has no form for the root alone.
  const wantConfigMount = typeof workspace === 'object' && workspace.configMount;
  if (wantConfigMount) {
    mounts.push({
      name: '_config',
      path: resolve(join(storePath, 'config')),
      mode: 'read-write',
      backend: 'chronicle',
      watch: 'always',
      include: ['gate.json', 'gate.js', 'gate.recipe.json'],
    });
  }

  return mounts;
}

/**
 * Whether a path is one the workspace's `read` takes for a file outside the
 * mounts where a recipe sets `outsideMounts`: absolute, or from the home
 * directory. The setting is for the agent's own tools. The file viewers (the
 * web UI's and the control socket's) call that `read` too, for whoever is
 * connected, and show the mounts' files only, so they refuse such a path
 * before the workspace reads it.
 */
export function namesOutsideMounts(path: string): boolean {
  return isAbsolute(path) || path.startsWith('~/');
}

/** What a file viewer says of a path it doesn't take (namesOutsideMounts). */
export const VIEWER_SHOWS_MOUNTS = "the file viewer shows the mounts' files, and a path there starts with its mount's name";

/** The workspace module's settings as a recipe gives them: its mounts (buildWorkspaceMounts), and what its tools may reach outside them. */
export function workspaceConfig(workspace: RecipeModules['workspace'], storePath: string): WorkspaceConfig | null {
  const mounts = buildWorkspaceMounts(workspace, storePath);
  if (!mounts) return null;
  const outsideMounts = typeof workspace === 'object' ? workspace.outsideMounts : undefined;
  return { mounts, ...(outsideMounts !== undefined ? { outsideMounts } : {}) };
}
