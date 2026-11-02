import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installCandidate, readPacks } from '../lib/install.mjs';

const npm = (cwd, ...args) => {
  const r = spawnSync('npm', [...args, '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`npm ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
const pack = (at, name, version, dependencies = {}) => {
  const dir = join(at, `src-${name.replace(/\W/g, '-')}-${version}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, dependencies }));
  return join(at, npm(dir, 'pack', '--pack-destination', at).trim().split('\n').at(-1));
};

test('R9: an overlay is laid over a copy of the checkout and named by what was installed, a work directory inside the checkout is left out, and a pack of the host or of another package is refused', { timeout: 120_000 }, () => {
  const at = mkdtempSync(join(tmpdir(), 'install-'));
  try {
    const root = join(at, 'host');
    mkdirSync(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@animalabs/connectome-host', version: '0.0.1' }));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'index.ts'), 'export {};\n');
    npm(root, 'install');
    mkdirSync(join(root, 'work'));
    writeFileSync(join(root, 'work', 'big'), 'scratch');
    const packs = readPacks([pack(at, '@animalabs/context-manager', '9.9.9')]);
    const dir = join(root, 'work', 'candidate');
    const installed = installCandidate({ root, packs, dir, leaveOut: [join(root, 'work')], npmCi: (cwd) => npm(cwd, 'ci') });
    assert.equal(installed.installDir, dir);
    assert.equal(JSON.parse(readFileSync(join(dir, 'node_modules', '@animalabs', 'context-manager', 'package.json'), 'utf-8')).version, '9.9.9');
    assert.equal(installed.versions['@animalabs/context-manager'].startsWith('9.9.9'), true);
    assert.equal(existsSync(join(dir, 'work')), false, 'a work directory inside the checkout is left out of the copy');
    assert.equal(readFileSync(join(dir, 'src', 'index.ts'), 'utf-8'), 'export {};\n', 'and its source is copied');
    assert.throws(() => readPacks([pack(at, '@animalabs/connectome-host', '9.9.9')]), /is connectome-host, which this checkout is/);
    assert.throws(() => readPacks([pack(at, 'left-pad', '1.0.0')]), /is left-pad; overlay one of/);
  } finally { rmSync(at, { recursive: true, force: true }); }
});

test('R9: an overlay that leaves another copy of its package in the install is refused, naming the copy', { timeout: 120_000 }, () => {
  const at = mkdtempSync(join(tmpdir(), 'install-'));
  try {
    const old = pack(at, '@animalabs/context-manager', '1.0.0');
    const holder = pack(at, 'holds-old', '1.0.0', { '@animalabs/context-manager': `file:${old}` });
    const root = join(at, 'host');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), 'export {};\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@animalabs/connectome-host', version: '0.0.1', dependencies: { '@animalabs/context-manager': `file:${old}`, 'holds-old': `file:${holder}` } }));
    npm(root, 'install');
    const packs = readPacks([pack(at, '@animalabs/context-manager', '9.9.9')]);
    assert.throws(() => installCandidate({ root, packs, dir: join(at, 'candidate'), npmCi: (cwd) => npm(cwd, 'ci') }), /didn't replace every copy of @animalabs\/context-manager: .*node_modules\/holds-old\/node_modules\/@animalabs\/context-manager/);
  } finally { rmSync(at, { recursive: true, force: true }); }
});
