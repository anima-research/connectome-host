/**
 * Workspace mount construction — the single source of truth for which mounts
 * a recipe's `modules.workspace` produces and with what flags.
 *
 * Used by BOTH the runtime (src/index.ts, to build the real WorkspaceModule
 * config) and recipe validation: validateRecipe builds the recipe's own
 * mounts for agent-framework's WorkspaceModule constructor to check (its
 * refusals, not its nesting warnings, which depend on where the paths
 * resolve and are the start's to give), and its instructions cross-check
 * reasons about mount names, modes, and autoMaterialize. Keeping one
 * builder prevents the validator from modeling a mount differently than the
 * host constructs it — the exact split-brain the `_config` mount had when
 * validation assumed it auto-materialized and the runtime built it without.
 */

import { join, resolve } from 'node:path';
import type { MountConfig } from '@animalabs/agent-framework';
import type { RecipeModules, RecipeWorkspaceMount } from './recipe.js';

/**
 * Build the mount list for a recipe's workspace declaration.
 *
 * Returns null when the workspace is disabled (`workspace: false`).
 * `storePath` anchors the `_config` mount (session store config dir); pass
 * any placeholder when only mount names/modes/flags are needed (validation).
 */
export function buildWorkspaceMounts(
  workspace: RecipeModules['workspace'],
  storePath: string,
): MountConfig[] | null {
  if (workspace === false) return null;

  let mounts: MountConfig[];
  if (typeof workspace === 'object' && workspace.mounts) {
    // Every key the recipe gives goes to the framework as it is: the recipe's
    // mount keys are the framework's MountConfig keys (recipe.ts checks the
    // two lists against each other, and validation refuses any other key),
    // so a key the framework adds can't be read here and dropped. Keys the
    // recipe leaves out keep the framework's defaults, except that the path
    // resolves from the working directory, mode defaults to read-write (a
    // direct mount must say its own, validateRecipe), and watch to 'never',
    // since the host does not need chokidar filesystem watchers by default.
    mounts = workspace.mounts.map(({ path, mode, watch, ...rest }: RecipeWorkspaceMount): MountConfig => ({
      ...rest,
      path: resolve(path),
      mode: mode ?? 'read-write',
      watch: watch ?? 'never',
    }));
  } else {
    // Default: read-only input mount + read-write products mount.
    mounts = [
      { name: 'input', path: resolve('./input'), mode: 'read-only', watch: 'never' },
      { name: 'products', path: resolve('./output'), mode: 'read-write', watch: 'never' },
    ];
  }

  // Config mount: version-controls gate.json (and future config files) via
  // Chronicle. Opt-in via recipe: workspace.configMount = true. NOTE: this
  // mount is deliberately NOT autoMaterialize — the host re-materializes it
  // explicitly after branch-changing commands, and ordinary agent edits stay
  // Chronicle-side until then. Anything that assumes `_config` disk content
  // tracks agent edits is wrong (see the instructions-path validation). Its
  // backend is said, not left to the framework's default: undo and redo
  // rewind it through materializeMount, which only a 'chronicle' mount has
  // history for.
  const wantConfigMount = typeof workspace === 'object' && workspace.configMount;
  if (wantConfigMount) {
    mounts.push({
      name: '_config',
      path: resolve(join(storePath, 'config')),
      mode: 'read-write',
      backend: 'chronicle',
      watch: 'always',
    });
  }

  return mounts;
}
