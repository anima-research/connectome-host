/**
 * A mock headless child that records which agent overlay it would read, in
 * `child-env.json` in its data directory, then runs as mock-headless-child.ts
 * does: the path MCPL_AGENT_OVERLAY_FILE gives it, DEFAULT_AGENT_OVERLAY_PATH
 * as the boot and /bug read it, the mcpl-admin module's own, and its working
 * directory.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_AGENT_OVERLAY_PATH } from '../src/mcpl-config.js';
import { McplAdminModule } from '../src/modules/mcpl-admin-module.js';

const dataDir = resolve(process.env.DATA_DIR || './data');
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, 'child-env.json'), JSON.stringify({
  env: process.env.MCPL_AGENT_OVERLAY_FILE ?? null,
  overlay: DEFAULT_AGENT_OVERLAY_PATH,
  admin: (new McplAdminModule({ timeZone: 'UTC' }) as unknown as { overlayPath: string }).overlayPath,
  cwd: process.cwd(),
}));
await import('./mock-headless-child.ts');
