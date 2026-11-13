import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readWithoutWaiting } from '../update/contract.js';

export const SERVERS = { discord: '@animalabs/discord-mcpl', shell: 'term-sessions-mcp' } as const;
// term-sessions-mcp 1.7.3's engines: node ">=18.0.0 <25.0.0".
export const SHELL_NODE_TOP = 24;
// Bun 1.4.3's `bun add --no-env-file` still gives a package's install script the working directory's .env, where
// 1.4.4's gives none (probed), and setup's bun add runs where the resident's secrets are.
export const SETUP_BUN_FLOOR = '>=1.4.4';

export interface PackageJson {
  version: string;
  engines: { bun: string; node: string };
  bugs: { url: string };
}

export function packageJson(): PackageJson {
  return JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'package.json'), 'utf-8')) as PackageJson;
}

export function declaredDependencies(dir: string): Set<string> | null {
  let text: string;
  try {
    text = readWithoutWaiting(join(dir, 'package.json'));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? new Set() : null;
  }
  try {
    const dependencies = (JSON.parse(text) as { dependencies?: unknown } | null)?.dependencies;
    return new Set(dependencies !== null && typeof dependencies === 'object' ? Object.keys(dependencies) : []);
  } catch {
    return null;
  }
}

export function installedVersion(dir: string, name: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf-8')) as { version?: string })
      .version ?? null;
  } catch {
    return null;
  }
}
