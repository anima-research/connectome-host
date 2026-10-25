/**
 * Where an agent's own overlay is, by one rule, for the host that reads it
 * (mcpl-config.ts) and for the launcher that copies it at a switch and puts
 * it back at Go back (launcher.ts). It sits beside the launcher and imports
 * only node:path, as contract.ts sits here for the host's modules too, so
 * the launcher, which runs before the host at every start, loads nothing
 * outside update/ to know it.
 */
import { resolve } from 'node:path';

/** The agent overlay's file name in the working directory. */
export const AGENT_OVERLAY_FILE_NAME = 'mcpl-servers.agent.json';

/** The environment variable naming the agent overlay's path. A fleet sets it
 *  for each child, to the child's own overlay in its data directory
 *  (fleet-module.ts), so the servers each child deploys and unloads for
 *  itself go into a file of its own. */
export const AGENT_OVERLAY_FILE_ENV = 'MCPL_AGENT_OVERLAY_FILE';

/** The agent's own overlay for a host running in `cwd` with `env`: the path
 *  the variable names, resolved from `cwd`, else the file name in `cwd`. */
export function agentOverlayPath(cwd: string, env: NodeJS.ProcessEnv): string {
  const named = env[AGENT_OVERLAY_FILE_ENV];
  return named ? resolve(cwd, named) : resolve(cwd, AGENT_OVERLAY_FILE_NAME);
}
