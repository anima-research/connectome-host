import { resolve } from 'node:path';

export const AGENT_OVERLAY_FILE_NAME = 'mcpl-servers.agent.json';

export const AGENT_OVERLAY_FILE_ENV = 'MCPL_AGENT_OVERLAY_FILE';

export function agentOverlayPath(cwd: string, env: NodeJS.ProcessEnv): string {
  const named = env[AGENT_OVERLAY_FILE_ENV];
  return named ? resolve(cwd, named) : resolve(cwd, AGENT_OVERLAY_FILE_NAME);
}
