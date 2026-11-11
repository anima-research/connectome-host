import { chmodSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export function nodePtyDir(dir: string): string {
  try {
    const server = realpathSync(join(dir, 'node_modules', 'term-sessions-mcp'));
    return realpathSync(dirname(createRequire(join(server, 'package.json')).resolve('node-pty/package.json')));
  } catch {
    return join(dir, 'node_modules', 'node-pty');
  }
}

// node-pty 1.1.0 ships its macOS spawn-helpers without execute bits (microsoft/node-pty#850).
export function makeSpawnHelperExecutable(ptyDir: string, platform: NodeJS.Platform): string | null {
  if (platform !== 'darwin') return null;
  const prebuilds = join(ptyDir, 'prebuilds');
  let names: string[];
  try {
    names = readdirSync(prebuilds).filter((name) => name.startsWith('darwin-'));
  } catch {
    return null;
  }
  for (const name of names) {
    const helper = join(prebuilds, name, 'spawn-helper');
    try {
      const mode = statSync(helper).mode;
      if (mode & 0o100) continue;
      chmodSync(helper, mode | 0o111);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return `${helper} couldn't be made executable (${(error as Error).message})`;
    }
  }
  return null;
}
