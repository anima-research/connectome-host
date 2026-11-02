import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const LANE_PATHS = ['lib', 'run.mjs'];

export const EXPECTED_FAILURES = join(ROOT, 'expected-failures.json');

export const KEY_PACKAGES = ['connectome-host', 'agent-framework', 'context-manager', 'membrane', 'chronicle'].map((p) => `@animalabs/${p}`);

export function asRun(configuration, facts) {
  const windowTokens = configuration.windowTokens ?? facts.window;
  if (typeof windowTokens !== 'number') throw new Error(`the host knows no window for ${configuration.agent?.model}; name the configuration's windowTokens`);
  return { ...configuration, windowTokens, ...(typeof facts.streamBound === 'number' ? { streamBound: facts.streamBound } : {}) };
}

export const EPOCH = Date.UTC(2026, 0, 5, 9, 0, 0);

export function laneVersion(root = ROOT) {
  const files = [];
  const walk = (rel) => {
    const abs = join(root, rel);
    if (statSync(abs).isDirectory()) for (const name of readdirSync(abs)) walk(join(rel, name));
    else files.push(rel);
  };
  for (const p of LANE_PATHS) walk(p);
  const h = createHash('sha256');
  for (const rel of files.sort()) {
    const bytes = readFileSync(join(root, rel));
    h.update(`${rel}\0${bytes.length}\0`).update(bytes);
  }
  return h.digest('hex');
}

export function sourceHash(dir) {
  const files = ['package.json'];
  const walk = (rel) => {
    for (const d of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const r = join(rel, d.name);
      if (d.isDirectory()) walk(r);
      else if (d.isFile()) files.push(r);
    }
  };
  walk('src');
  const h = createHash('sha256');
  for (const rel of files.sort()) {
    const bytes = readFileSync(join(dir, rel));
    h.update(`${rel.split(sep).join('/')}\0${bytes.length}\0`).update(bytes);
  }
  return h.digest('hex');
}

const npmRegistry = (cwd) => {
  const r = spawnSync('npm', ['config', 'get', 'registry'], { cwd, encoding: 'utf-8' });
  if (r.status !== 0 || !r.stdout.trim()) throw new Error(`npm config get registry failed in ${cwd}: ${(r.stderr ?? '').trim()}`);
  return r.stdout.trim();
};

export function stackVersions(hostDir, { installDir, registry } = {}) {
  if (!installDir) throw new Error('stackVersions needs the install directory, whose lockfile names what was installed');
  const lockPath = join(installDir, 'package-lock.json');
  if (!existsSync(lockPath)) throw new Error(`there's no lockfile at ${lockPath}, so what the install put there can't be named`);
  const locked = JSON.parse(readFileSync(lockPath, 'utf-8')).packages ?? {};
  registry ??= npmRegistry(installDir);
  const out = {};
  for (const name of KEY_PACKAGES) {
    let found = null;
    if (name === '@animalabs/connectome-host') found = join(hostDir, 'package.json');
    else {
      for (let dir = hostDir; ; dir = dirname(dir)) {
        const pj = join(dir, 'node_modules', name, 'package.json');
        if (existsSync(pj)) { found = pj; break; }
        if (dirname(dir) === dir) break;
      }
    }
    if (!found) { out[name] = null; continue; }
    const version = JSON.parse(readFileSync(found, 'utf-8')).version;
    const at = relative(installDir, dirname(found)).split(sep).join('/');
    if (at === '' && name === '@animalabs/connectome-host') { out[name] = `${version} (source ${sourceHash(hostDir).slice(0, 12)})`; continue; }
    const lock = locked[at];
    if (!lock) throw new Error(`the install's lockfile (${lockPath}) doesn't list ${name} at ${at}, so it can't be named by what was installed`);
    if (lock.link) throw new Error(`${name} is a directory npm linked (${lock.resolved}), which can't be named by its content: pass the .tgz \`npm pack\` makes of it instead`);
    const commit = /#([0-9a-f]{40})$/.exec(lock.resolved ?? '')?.[1];
    if (typeof lock.resolved === 'string' && lock.resolved.startsWith(registry)) out[name] = version;
    else if (lock.integrity) out[name] = `${version} (${lock.integrity})`;
    else if (commit) out[name] = `${version} (git ${commit})`;
    else throw new Error(`${name} at ${at} came from ${lock.resolved ?? 'nowhere the lockfile says'}, with no integrity or commit to name its content by: pass a packed release or a git spec`);
  }
  const bun = spawnSync('bun', ['--version'], { encoding: 'utf-8' });
  out.bun = bun.status === 0 ? bun.stdout.trim() : null;
  return out;
}

export function contentsOf(dir) {
  const list = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else list.push(`${r}\t${createHash('sha256').update(readFileSync(join(dir, r))).digest('hex')}`);
    }
  };
  for (const part of ['answers', 'store']) walk(part);
  return createHash('sha256').update(list.sort().join('\n')).digest('hex').slice(0, 16);
}

export function keptWhole(dir) {
  try {
    for (const part of ['answers', 'store']) if (!existsSync(join(dir, part)) || !readdirSync(join(dir, part)).length) return false;
    const { from, key, clockEnd, contents } = JSON.parse(readFileSync(join(dir, 'checkpoint.json'), 'utf-8'));
    return typeof from === 'string' && typeof key === 'string' && key.length > 0 && Number.isFinite(clockEnd) && dir.replace(/[\\/]+$/, '').endsWith(`-${key}`) && contents === contentsOf(dir);
  } catch { return false; }
}
