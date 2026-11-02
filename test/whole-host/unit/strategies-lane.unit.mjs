import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentsOf, keptWhole, laneVersion, sourceHash, stackVersions } from '../lib/strategies/lane.mjs';

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'fxl-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

test('N1: the lane version moves with every file under lib and with run.mjs, and with nothing else', { timeout: 30_000 }, () => {
  const root = tree({
    'lib/strategies/driver.mjs': 'driver',
    'lib/strategies/script.mjs': 'script',
    'lib/common.mjs': 'common',
    'lib/record.mjs': 'record',
    'run.mjs': 'run',
    'expected-failures.json': '[]',
    'records/x.record': 'record',
    'README.md': 'readme',
    'unit/x.unit.mjs': 'test',
  });
  try {
    const v = laneVersion(root);
    assert.match(v, /^[0-9a-f]{64}$/);
    assert.equal(laneVersion(root), v, 'the same files give the same version');
    for (const [rel, text] of [['README.md', 'readme 2'], ['expected-failures.json', '[1]'], ['records/x.record', 'record 2'], ['unit/x.unit.mjs', 'test 2'], ['unit/y.unit.mjs', 'new']]) {
      writeFileSync(join(root, rel), text);
      assert.equal(laneVersion(root), v, `${rel} is outside the lane`);
    }
    const moves = [
      ['a byte of a strategies file', () => writeFileSync(join(root, 'lib/strategies/script.mjs'), 'scripT'), () => writeFileSync(join(root, 'lib/strategies/script.mjs'), 'script')],
      ['lib/common.mjs', () => writeFileSync(join(root, 'lib/common.mjs'), 'common 2'), () => writeFileSync(join(root, 'lib/common.mjs'), 'common')],
      ['lib/record.mjs', () => writeFileSync(join(root, 'lib/record.mjs'), 'record 2'), () => writeFileSync(join(root, 'lib/record.mjs'), 'record')],
      ['run.mjs', () => writeFileSync(join(root, 'run.mjs'), 'run 2'), () => writeFileSync(join(root, 'run.mjs'), 'run')],
      ['a file added under lib/strategies', () => writeFileSync(join(root, 'lib/strategies/new.mjs'), ''), () => unlinkSync(join(root, 'lib/strategies/new.mjs'))],
      ['a file in a directory under lib/strategies', () => { mkdirSync(join(root, 'lib/strategies/sub')); writeFileSync(join(root, 'lib/strategies/sub/x.mjs'), 'x'); }, () => rmSync(join(root, 'lib/strategies/sub'), { recursive: true })],
      ['a file removed from lib/strategies', () => unlinkSync(join(root, 'lib/strategies/driver.mjs')), () => writeFileSync(join(root, 'lib/strategies/driver.mjs'), 'driver')],
      ['the same bytes under another name', () => { unlinkSync(join(root, 'lib/strategies/driver.mjs')); writeFileSync(join(root, 'lib/strategies/driver2.mjs'), 'driver'); }, () => { unlinkSync(join(root, 'lib/strategies/driver2.mjs')); writeFileSync(join(root, 'lib/strategies/driver.mjs'), 'driver'); }],
      ['bytes moved from one file to the next', () => { writeFileSync(join(root, 'lib/strategies/driver.mjs'), 'drivers'); writeFileSync(join(root, 'lib/strategies/script.mjs'), 'cript'); }, () => { writeFileSync(join(root, 'lib/strategies/driver.mjs'), 'driver'); writeFileSync(join(root, 'lib/strategies/script.mjs'), 'script'); }],
    ];
    for (const [what, change, undo] of moves) {
      change();
      assert.notEqual(laneVersion(root), v, what);
      undo();
      assert.equal(laneVersion(root), v, `${what}, undone`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const REGISTRY = 'https://registry.example.test/';
const fromRegistry = (name, version) => ({ version, resolved: `${REGISTRY}${name}/-/${name.split('/')[1]}-${version}.tgz`, integrity: `sha512-registry-${version}` });
function install(packages) {
  const files = {};
  const lock = { name: 'strategies-stack', lockfileVersion: 3, packages: { '': { name: 'strategies-stack' } } };
  for (const [path, { version, locked }] of Object.entries(packages)) {
    files[`install/${path}/package.json`] = JSON.stringify({ name: 'x', version });
    if (locked) lock.packages[path] = locked;
  }
  files['install/package-lock.json'] = JSON.stringify(lock);
  const root = tree(files);
  return { root, installDir: join(root, 'install'), hostDir: join(root, 'install/node_modules/@animalabs/connectome-host') };
}
const released = (overrides = {}) => ({
  'node_modules/@animalabs/connectome-host': { version: '0.15.0', locked: fromRegistry('@animalabs/connectome-host', '0.15.0') },
  'node_modules/@animalabs/agent-framework': { version: '0.28.0', locked: fromRegistry('@animalabs/agent-framework', '0.28.0') },
  'node_modules/@animalabs/connectome-host/node_modules/@animalabs/context-manager': { version: '0.23.1', locked: fromRegistry('@animalabs/context-manager', '0.23.1') },
  'node_modules/@animalabs/context-manager': { version: '0.22.0', locked: fromRegistry('@animalabs/context-manager', '0.22.0') },
  'node_modules/@animalabs/chronicle': { version: '0.4.2', locked: fromRegistry('@animalabs/chronicle', '0.4.2') },
  ...overrides,
});
const bunVersion = () => spawnSync('bun', ['--version'], { encoding: 'utf-8' }).stdout.trim();

test('N2: the key names the stack as the host resolves it, upward from its directory, by version where npm installed it from the registry, and bun', { timeout: 30_000 }, () => {
  const s = install(released());
  try {
    const v = stackVersions(s.hostDir, { installDir: s.installDir, registry: REGISTRY });
    const bun = bunVersion();
    assert.ok(bun, 'bun answers --version here');
    assert.deepEqual(v, {
      '@animalabs/connectome-host': '0.15.0',
      '@animalabs/agent-framework': '0.28.0',
      '@animalabs/context-manager': '0.23.1',
      '@animalabs/membrane': null,
      '@animalabs/chronicle': '0.4.2',
      bun,
    });
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('N2: a package installed from a pack or a git spec is named by its version and its content, as the lockfile records it', { timeout: 30_000 }, () => {
  const host = 'node_modules/@animalabs/connectome-host';
  const pack = install(released({ [host]: { version: '0.15.0', locked: { version: '0.15.0', resolved: 'file:../connectome-host-0.15.0.tgz', integrity: 'sha512-one-changed-line' } } }));
  const otherPack = install(released({ [host]: { version: '0.15.0', locked: { version: '0.15.0', resolved: 'file:../connectome-host-0.15.0.tgz', integrity: 'sha512-another-change' } } }));
  const sha = 'a'.repeat(40);
  const git = install(released({ [host]: { version: '0.15.0', locked: { version: '0.15.0', resolved: `git+ssh://git@github.com/x/connectome-host.git#${sha}` } } }));
  const url = install(released({ [host]: { version: '0.15.0', locked: { version: '0.15.0', resolved: 'https://example.test/builds/connectome-host-0.15.0.tgz', integrity: 'sha512-from-a-url' } } }));
  try {
    const name = (s) => stackVersions(s.hostDir, { installDir: s.installDir, registry: REGISTRY })['@animalabs/connectome-host'];
    const one = name(pack);
    assert.notEqual(one, '0.15.0', 'a pack at the release\'s version is not named as the release');
    assert.ok(one.startsWith('0.15.0') && one.includes('sha512-one-changed-line'), one);
    assert.notEqual(name(otherPack), one, 'two packs with different content have different names');
    assert.equal(name(pack), one, 'the same pack names the same way twice');
    const g = name(git);
    assert.ok(g.startsWith('0.15.0') && g.includes(sha), g);
    const u = name(url);
    assert.ok(u.startsWith('0.15.0') && u.includes('sha512-from-a-url'), `a tarball from a URL outside the registry is named by its integrity: ${u}`);
    assert.equal(stackVersions(pack.hostDir, { installDir: pack.installDir, registry: REGISTRY })['@animalabs/agent-framework'], '0.28.0');
  } finally { for (const s of [pack, otherPack, git, url]) rmSync(s.root, { recursive: true, force: true }); }
});

test('N2: a package the install can\'t name by its content refuses, naming it and what to pass instead', { timeout: 30_000 }, () => {
  const host = 'node_modules/@animalabs/connectome-host';
  const linked = install(released({ [host]: { version: '0.15.0', locked: { resolved: '../checkout/connectome-host', link: true } } }));
  const unlisted = install(released({ 'node_modules/@animalabs/agent-framework': { version: '0.28.0', locked: null } }));
  const unlocked = install(released());
  unlinkSync(join(unlocked.installDir, 'package-lock.json'));
  try {
    assert.throws(() => stackVersions(unlocked.hostDir, { installDir: unlocked.installDir, registry: REGISTRY }), (e) => /no lockfile at/.test(e.message));
    assert.throws(() => stackVersions(linked.hostDir, { installDir: linked.installDir, registry: REGISTRY }), (e) => /@animalabs\/connectome-host/.test(e.message) && /linked/.test(e.message) && /npm pack/.test(e.message));
    assert.throws(() => stackVersions(unlisted.hostDir, { installDir: unlisted.installDir, registry: REGISTRY }), (e) => /@animalabs\/agent-framework/.test(e.message) && /lockfile/.test(e.message));
  } finally { for (const s of [linked, unlisted, unlocked]) rmSync(s.root, { recursive: true, force: true }); }
});

test('a host checkout is named by its package.json and src/, wherever it sits, and by nothing else', () => {
  const tree = (files) => {
    const dir = mkdtempSync(join(tmpdir(), 'source-hash-'));
    for (const [rel, text] of Object.entries(files)) { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); }
    return dir;
  };
  const base = { 'package.json': '{"version":"1.0.0"}', 'src/a.ts': 'a', 'src/sub/b.ts': 'b' };
  const h = sourceHash(tree(base));
  assert.equal(sourceHash(tree(base)), h, 'the same files in another directory');
  assert.equal(sourceHash(tree({ ...base, 'README.md': 'x', 'test/t.ts': 't' })), h, 'files outside src/ and package.json');
  assert.notEqual(sourceHash(tree({ ...base, 'src/a.ts': 'a2' })), h, 'a source file changed');
  assert.notEqual(sourceHash(tree({ ...base, 'src/c.ts': 'c' })), h, 'a source file added');
  assert.notEqual(sourceHash(tree({ ...base, 'package.json': '{"version":"1.0.1"}' })), h, 'package.json changed');
});

test('a host that is the checkout itself is named by its version and its source, so two checkouts of one version name different stacks', { timeout: 30_000 }, () => {
  const checkout = (source) => {
    const root = tree({ 'package.json': JSON.stringify({ name: '@animalabs/connectome-host', version: '0.21.0' }), 'src/a.ts': source, 'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': {} } }) });
    return { root, host: stackVersions(root, { installDir: root, registry: REGISTRY })['@animalabs/connectome-host'] };
  };
  const a = checkout('a');
  const b = checkout('b');
  try {
    assert.match(a.host, /^0\.21\.0 \(source [0-9a-f]{12}\)$/);
    assert.notEqual(a.host, b.host);
    assert.equal(checkout('a').host, a.host, 'the same source names the same host');
  } finally { rmSync(a.root, { recursive: true, force: true }); rmSync(b.root, { recursive: true, force: true }); }
});

test('a kept checkpoint is used only whole, with its record, its store and the answers its transcripts read', () => {
  const root = mkdtempSync(join(tmpdir(), 'kept-'));
  const make = (name, { record = sealed(), store = true, answers = true, dirs: made = ['store', 'answers'] } = {}) => {
    const dir = join(root, `H1_W2-${name}`, 'H1_W2-k1');
    mkdirSync(dir, { recursive: true });
    for (const d of made) mkdirSync(join(dir, d), { recursive: true });
    if (store && made.includes('store')) writeFileSync(join(dir, 'store', 'x'), '');
    if (answers && made.includes('answers')) writeFileSync(join(dir, 'answers', 'r1.answer.json'), '[]');
    if (record !== null) writeFileSync(join(dir, 'checkpoint.json'), typeof record === 'function' ? record(dir) : record);
    return dir;
  };
  const sealed = (more = {}) => (dir) => JSON.stringify({ from: 'H1/W2', key: 'k1', clockEnd: 1, ...(dirs(dir) ? { contents: contentsOf(dir) } : {}), ...more });
  const dirs = (dir) => ['answers', 'store'].every((d) => { try { return readdirSync(join(dir, d)).length > 0; } catch { return false; } });
  try {
    assert.equal(keptWhole(make('whole')), true);
    assert.equal(keptWhole(make('no-answers', { answers: false })), false, 'one kept before its answers were, or that lost them, is written again');
    assert.equal(keptWhole(make('empty-store', { store: false })), false, 'a store that lost its contents');
    assert.equal(keptWhole(make('no-record', { record: null })), false);
    assert.equal(keptWhole(make('broken-record', { record: '{"from":' })), false, 'a record that doesn\'t parse');
    assert.equal(keptWhole(make('other-key', { record: sealed({ key: 'k2' }) })), false, 'a record whose key isn\'t its directory\'s');
    assert.equal(keptWhole(make('no-clock', { record: sealed({ clockEnd: undefined }) })), false, 'a record with no clockEnd, which would start the continuation at NaN');
    assert.equal(keptWhole(make('no-from', { record: sealed({ from: undefined }) })), false);
    assert.equal(keptWhole(make('no-answers-dir', { dirs: ['store'] })), false, 'no answers directory at all');
    assert.equal(keptWhole(make('no-store-dir', { dirs: ['answers'] })), false, 'no store directory at all');
    const unreadable = make('unreadable-store');
    rmSync(join(unreadable, 'store'), { recursive: true });
    writeFileSync(join(unreadable, 'store'), 'a file where the directory was');
    assert.equal(keptWhole(unreadable), false, 'a store that isn\'t a directory reads as not whole rather than throwing');
    const lost = make('lost-file');
    writeFileSync(join(lost, 'store', 'sessions.json'), '{}');
    assert.equal(keptWhole(lost), false, 'a file the sealed listing doesn\'t name, or a lost one, makes it not whole');
    const shrunk = make('shrunk');
    writeFileSync(join(shrunk, 'answers', 'r1.answer.json'), '');
    assert.equal(keptWhole(shrunk), false, 'nor does a file whose size changed');
    const sealOf = (dir) => JSON.stringify({ from: 'H1/W2', key: 'k1', clockEnd: 1, contents: contentsOf(dir) });
    const two = make('two-files', { record: null });
    writeFileSync(join(two, 'store', 'sessions.json'), '{"a":1}');
    writeFileSync(join(two, 'checkpoint.json'), sealOf(two));
    assert.equal(keptWhole(two), true, 'a checkpoint sealed with two store files is whole');
    rmSync(join(two, 'store', 'sessions.json'));
    assert.equal(keptWhole(two), false, 'and not once one of them is gone');
    const swapped = make('swapped', { record: null });
    writeFileSync(join(swapped, 'answers', 'r1.answer.json'), '["alpha"]');
    writeFileSync(join(swapped, 'checkpoint.json'), sealOf(swapped));
    writeFileSync(join(swapped, 'answers', 'r1.answer.json'), '["bravo"]');
    assert.equal(keptWhole(swapped), false, 'nor once a file changes at the same size');
    assert.equal(keptWhole(make('unsealed', { record: JSON.stringify({ from: 'H1/W2', key: 'k1', clockEnd: 1 }) })), false, 'a record with no contents, as one kept before this, is rebuilt');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('run.mjs refuses a run name it doesn\'t know, naming it, before it clones or installs anything', () => {
  const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'run.mjs'), '--runs', 'H9/W99', '--workdir', join(tmpdir(), 'never-made-whole-host')], { encoding: 'utf-8', timeout: 30_000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no run H9\/W99; there are [^\n]*\bH1\/W1\b/);
  assert.doesNotMatch(r.stdout + r.stderr, /lane |release /, 'it stopped before naming the lane or cloning the release');
});
