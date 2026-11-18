import { join } from 'node:path';

/** Separate from ipc.sock, including when the interactive socket is overridden. */
export function quarantineSocketPath(dataDir: string): string {
  return join(dataDir, 'q', 's');
}
