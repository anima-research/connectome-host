/**
 * agent-framework's heartbeat options (`FrameworkConfig.heartbeat`) for a
 * recipe's `modules.heartbeat`: off unless the recipe turns it on.
 *
 * The heartbeat is the agent's across sessions, as heartbeat-mcpl's state
 * was, so its state file defaults to the install's data directory
 * (`{dataDir}/heartbeat.json`), not a session's store: a new or switched
 * session reads the same schedule and reminders, and doesn't import
 * heartbeat-mcpl's files again. Paths the recipe gives are read relative to
 * the install directory, as the host reads its other files. validateRecipe
 * has checked the rest, which is passed on as written.
 */
import { resolve } from 'node:path';
import type { RecipeModules } from './recipe.js';

/** The value for FrameworkConfig.heartbeat, or undefined when the recipe leaves the heartbeat off. */
export function heartbeatOptionsFor(heartbeat: RecipeModules['heartbeat'], dataDir: string): Record<string, unknown> | undefined {
  if (heartbeat === undefined || heartbeat === false) return undefined;
  const h = heartbeat === true ? {} : heartbeat;
  const from = h.importFrom;
  return {
    statePath: resolve(h.statePath ?? resolve(dataDir, 'heartbeat.json')),
    ...(h.defaults !== undefined ? { defaults: { ...h.defaults } } : {}),
    ...(from !== undefined ? {
      importFrom: {
        ...(from.configPath !== undefined ? { configPath: resolve(from.configPath) } : {}),
        ...(from.remindersPath !== undefined ? { remindersPath: resolve(from.remindersPath) } : {}),
      },
    } : {}),
  };
}

/** Whether an MCPL server is heartbeat-mcpl, or names its tools as the heartbeat's: by its id, its tool prefix, or the command that runs it. */
export function isHeartbeatMcpl(server: { id: string; toolPrefix?: unknown; command?: unknown; args?: unknown }): boolean {
  if (server.id === 'heartbeat' || server.toolPrefix === 'heartbeat' || server.toolPrefix === 'mcpl--heartbeat') return true;
  const parts = [server.command, ...(Array.isArray(server.args) ? server.args : [])];
  return parts.some((part) => typeof part === 'string' && /heartbeat-mcpl/.test(part));
}

/**
 * The servers to connect beside the framework's heartbeat: heartbeat-mcpl
 * is left out, with a line naming it, since both would wake the agent and
 * agent-framework refuses the pair at create. A recipe can't name it beside
 * `modules.heartbeat` (validateRecipe); this catches one from
 * `mcpl-servers.json` or the agent's own overlay, which would otherwise keep
 * the host from starting.
 */
export function withoutHeartbeatMcpl<T extends { id: string }>(servers: T[], warn: (line: string) => void): T[] {
  return servers.filter((server) => {
    if (!isHeartbeatMcpl(server as T & { toolPrefix?: unknown; command?: unknown; args?: unknown })) return true;
    warn(`[heartbeat] modules.heartbeat is on, so the MCPL server "${server.id}" (heartbeat-mcpl, from mcpl-servers.json or `
      + 'the agent\'s overlay) is left out: both would wake the agent. Its schedule and reminders come along through '
      + 'modules.heartbeat.importFrom; remove the server to stop this line.');
    return false;
  });
}
