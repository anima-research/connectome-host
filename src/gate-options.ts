/**
 * The framework's gate options (wake rules) for a recipe's `modules.wake`.
 *
 * The gate's file is per session, `{storePath}/config/gate.json`. An object
 * recipe value gives the host's starting rules (`policies`, `default`) and,
 * under `judge`, the reply judge that `judge` wake rules ask
 * (agent-framework's `GateOptions.judge`), which is passed on as written:
 * validateRecipe has checked it, and the starting rules are passed without
 * it, so gate.json's reader doesn't see a field it doesn't read.
 */
import { join, resolve } from 'node:path';
import type { GateConfig, GateOptions } from '@animalabs/agent-framework';
import type { RecipeModules } from './recipe.js';

export function gateOptionsFor(
  wake: RecipeModules['wake'],
  storePath: string,
  env: NodeJS.ProcessEnv = process.env,
): GateOptions | undefined {
  if (wake === false) return undefined;
  const { judge, ...rules } = typeof wake === 'object' && wake !== null ? wake : {};
  return {
    configPath: join(storePath, 'config', 'gate.json'),
    // Starting rules when the recipe gives either part: a `default` alone is a
    // starting default over no rules, which agent-framework reads as such.
    ...('policies' in rules || 'default' in rules ? { config: rules as GateConfig } : {}),
    // The `sleep` tool's privileged users, who may wake the agent through a
    // sleep window: ./sleep-privileged.json in the working directory, shared by
    // every session, unless SLEEP_PRIVILEGED_FILE names another. Edit the file
    // to change the list.
    privilegedUsersPath: env.SLEEP_PRIVILEGED_FILE || resolve('./sleep-privileged.json'),
    ...(judge !== undefined ? { judge } : {}),
  };
}
