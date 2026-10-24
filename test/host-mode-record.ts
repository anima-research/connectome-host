import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SessionManager } from '../src/session-manager.js';

/** The host-mode record agent-framework keeps in the store of a data
 *  directory's active session (`recovery/host-mode.json`): whether the host
 *  is quiesced, and why. Null when there is none. */
export function hostModeRecord(dataDir: string): { quiesced?: boolean; reason?: string } | null {
  try {
    return JSON.parse(readFileSync(recordPath(dataDir), 'utf8')) as { quiesced?: boolean; reason?: string };
  } catch {
    return null;
  }
}

/** Leave a data directory's active session quiesced under `reason`, as an
 *  operator's quiesce through agent-framework leaves it: the record as its
 *  quiesce writes it, which its next start reads. */
export function writeHostModeRecord(dataDir: string, reason: string): void {
  const path = recordPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, quiesced: true, reason, since: Date.now() }));
}

function recordPath(dataDir: string): string {
  const sessions = new SessionManager(dataDir);
  return join(sessions.getStorePath(sessions.load().activeSessionId), 'recovery', 'host-mode.json');
}
