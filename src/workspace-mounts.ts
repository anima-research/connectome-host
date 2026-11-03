import { join, resolve } from 'node:path';
import type { MountConfig } from '@animalabs/agent-framework';
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

  // Undo and redo rewind this mount through agent-framework's
  // materializeMount, which does nothing for a direct mount, so its backend is
  // said rather than left to the framework's default. The gate keeps the
  // recipe it last applied in gate.recipe.json beside gate.json and reads it
  // at each start, so a rewind takes it back with gate.json. The include keeps
  // editors' and recovery files out (anima-research/connectome-host#278); each
  // name covers that name in any directory beneath as well, since
  // agent-framework's include has no form for the root alone.
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
