import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { sh } from './common.mjs';
import { KEY_PACKAGES, stackVersions } from './strategies/lane.mjs';

export function readPacks(paths) {
  return paths.map((p) => {
    let name;
    try { name = JSON.parse(sh('tar', ['-xzOf', p, 'package/package.json']).stdout).name; } catch (e) { throw new Error(`the overlay ${p} couldn't be read as a packed release: ${e.message}`); }
    if (name === '@animalabs/connectome-host') throw new Error(`the overlay ${p} is connectome-host, which this checkout is: change the checkout to run a host change`);
    if (!KEY_PACKAGES.includes(name)) throw new Error(`the overlay ${p} is ${name}; overlay one of ${KEY_PACKAGES.filter((k) => k !== '@animalabs/connectome-host').join(', ')}`);
    return { path: p, name, integrity: `sha512-${createHash('sha512').update(readFileSync(p)).digest('base64')}` };
  });
}

export function installCandidate({ root, packs, dir, leaveOut = [], npmCi }) {
  if (!packs.length) {
    if (!existsSync(join(root, 'node_modules'))) throw new Error(`there's no install at ${root}; run npm ci first`);
    return { hostDir: root, installDir: root, versions: stackVersions(root, { installDir: root }) };
  }
  mkdirSync(dir, { recursive: true });
  const inside = [dir, ...leaveOut].map((p) => relative(root, p)).filter((rel) => rel && !rel.startsWith('..') && !isAbsolute(rel));
  const excludes = ['node_modules', '.git', ...inside].map((rel) => `--exclude=./${rel}`);
  sh('bash', ['-c', 'set -o pipefail; tar -C "$ROOT" "$@" -cf - . | tar -x -C "$DIR"', 'copy', ...excludes], { env: { ROOT: root, DIR: dir } });
  npmCi(dir);
  sh('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', ...packs.map((p) => p.path)], { cwd: dir, timeout: 900_000 });
  const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf-8')).packages ?? {};
  for (const { path, name, integrity } of packs) {
    const copies = Object.entries(lock).filter(([at]) => at.endsWith(`node_modules/${name}`));
    if (!copies.length || copies.some(([, l]) => l.integrity !== integrity)) {
      throw new Error(`the overlay ${path} didn't replace every copy of ${name}: ${copies.map(([at, l]) => `${at} from ${l.resolved}`).join('; ')}`);
    }
  }
  return { hostDir: dir, installDir: dir, versions: stackVersions(dir, { installDir: dir }) };
}
