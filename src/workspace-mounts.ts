/**
 * Workspace mount construction — the single source of truth for which mounts
 * a recipe's `modules.workspace` produces and with what flags.
 *
 * Used by BOTH the runtime (src/index.ts, to build the real WorkspaceModule
 * config) and recipe validation (validateRecipe's instructions cross-check,
 * which reasons about mount names, modes, and autoMaterialize). Keeping one
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
    // Only pass fields the recipe explicitly provides; let WorkspaceModule
    // default the rest. watch is overridden to 'never' since the host does
    // not need chokidar filesystem watchers by default.
    mounts = workspace.mounts.map((m: RecipeWorkspaceMount) => {
      const mount: MountConfig = {
        name: m.name,
        path: resolve(m.path),
        mode: m.mode ?? 'read-write',
        watch: m.watch ?? 'never',
      };
      if (m.ignore) mount.ignore = m.ignore;
      if (m.maxFileSize !== undefined) mount.maxFileSize = m.maxFileSize;
      if (m.wakeOnChange !== undefined) mount.wakeOnChange = m.wakeOnChange;
      if (m.autoMaterialize !== undefined) mount.autoMaterialize = m.autoMaterialize;
      if (m.backend !== undefined) mount.backend = m.backend;
      return mount;
    });
  } else {
    // Default: read-only input mount + read-write products mount.
    mounts = [
      { name: 'input', path: resolve('./input'), mode: 'read-only', watch: 'never' },
      { name: 'products', path: resolve('./output'), mode: 'read-write', watch: 'never' },
    ];
  }

  // Config mount: version-controls gate.json (and future config files) via
  // Chronicle. Opt-in via recipe: workspace.configMount = true. It is pinned
  // to the chronicle backend — undo/redo rewind it through materializeMount,
  // which the direct backend (the framework's default) has no history for.
  // NOTE: this mount is deliberately NOT autoMaterialize — the host
  // re-materializes it explicitly after branch-changing commands, and
  // ordinary agent edits stay Chronicle-side until then. Anything that
  // assumes `_config` disk content tracks agent edits is wrong (see the
  // instructions-path validation).
  const wantConfigMount = typeof workspace === 'object' && workspace.configMount;
  if (wantConfigMount) {
    mounts.push({
      name: '_config',
      path: resolve(join(storePath, 'config')),
      mode: 'read-write',
      watch: 'always',
      backend: 'chronicle',
    });
  }

  return mounts;
}
