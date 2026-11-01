import { chmodSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// node-pty 1.1.0 ships its macOS spawn-helpers without execute bits (microsoft/node-pty#850).
export function makeSpawnHelperExecutable(nodeModules: string, platform: NodeJS.Platform): string | null {
  if (platform !== 'darwin') return null;
  const prebuilds = join(nodeModules, 'node-pty', 'prebuilds');
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
