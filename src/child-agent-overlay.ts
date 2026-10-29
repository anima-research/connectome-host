import { readFileSync, writeFileSync, existsSync, lstatSync, unlinkSync, openSync, fstatSync, closeSync } from 'node:fs';

export const CHILD_AGENT_OVERLAY_FILE_NAME = 'mcpl-servers.agent.child.json';

export function seedChildAgentOverlay(childPath: string, fromPath: string, copy: boolean): void {
  if (lstatSync(childPath, { throwIfNoEntry: false }) !== undefined) return;
  let content: string | Buffer = JSON.stringify({ mcplServers: {} }, null, 2) + '\n';
  let mode = 0o600;
  if (copy && existsSync(fromPath)) {
    const fd = openSync(fromPath, 'r');
    try {
      mode = fstatSync(fd).mode & 0o600;
      content = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  try {
    writeFileSync(childPath, content, { flag: 'wx', mode });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    try { unlinkSync(childPath); } catch {}
    throw error;
  }
}
