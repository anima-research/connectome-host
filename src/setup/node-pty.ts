import { chmodSync, existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

// The copy node loads from term-sessions-mcp, found as node finds it: in the node_modules of each directory from
// term-sessions-mcp's real path up. Bun's resolver can name the copy in Bun's global install cache instead, in a
// process that started before the directory had node_modules (probed with Bun 1.4.4).
export function nodePtyDir(dir: string): string {
  try {
    for (let at = realpathSync(join(dir, 'node_modules', 'term-sessions-mcp')); ; at = dirname(at)) {
      const copy = join(at, 'node_modules', 'node-pty');
      if (existsSync(join(copy, 'package.json'))) return realpathSync(copy);
      if (dirname(at) === at) break;
    }
  } catch {
  }
  return join(dir, 'node_modules', 'node-pty');
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
