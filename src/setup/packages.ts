import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SERVERS = { discord: '@animalabs/discord-mcpl', shell: 'term-sessions-mcp' } as const;

// term-sessions-mcp 1.7.3's engines: node ">=18.0.0 <25.0.0".
export const SHELL_NODE_TOP = 24;

// Bun 1.4.3's `bun add --no-env-file` still gives a package's install script the working directory's .env, where
// 1.4.4's gives none, and setup's bun add runs where the resident's secrets are.
export const SETUP_BUN_FLOOR = '>=1.4.4';

export interface PackageJson {
  version: string;
  engines: { bun: string; node: string };
  bugs: { url: string };
}

export function packageJson(): PackageJson {
  return JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'package.json'), 'utf-8')) as PackageJson;
}

function jsonIn(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The version of a package installed in dir, where dir's package.json declares it: a bun add that fails partway
 * leaves packages in node_modules that it never declares.
 */
export function installedVersion(dir: string, name: string): string | null {
  const declared = jsonIn(join(dir, 'package.json'))?.dependencies as Record<string, unknown> | undefined;
  if (declared === undefined || !Object.hasOwn(declared, name)) return null;
  const version = jsonIn(join(dir, 'node_modules', name, 'package.json'))?.version;
  return typeof version === 'string' ? version : null;
}
