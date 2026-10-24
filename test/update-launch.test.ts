/**
 * A start from end to end: the entry point setup writes, the launcher of the
 * release `current` names, and the launcher becoming the host of the release
 * it decides on by process.execve. Each release here holds this repository's own update
 * modules and a stand-in host that writes down how it was started.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INSTALL_ROOT_ENV, appendJournal, installPaths, moveCurrent, readJournal, readRecord, releaseDir, writeJsonAtomic, type Mark,
} from '../src/update/contract.js';
import { HOST_ENTRY, RELEASE_HOST } from '../src/update/launcher.js';
import { ENTRY_POINT, setup } from '../src/update/setup.js';

let dir: string;
let install: string;
let data: string;
let root: string;
let marker: string;

/** A host package at `hostDir`: this repository's update modules, and a
 *  host that writes its version, arguments, install root, working directory
 *  and process id to $MARKER. */
function hostPackage(hostDir: string, version: string): void {
  mkdirSync(join(hostDir, 'src', 'update'), { recursive: true });
  writeFileSync(join(hostDir, 'package.json'), JSON.stringify({ name: '@animalabs/connectome-host', version }));
  cpSync(join(import.meta.dir, '..', 'src', 'update'), join(hostDir, 'src', 'update'), { recursive: true });
  writeFileSync(join(hostDir, 'src', 'index.ts'), [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(process.env.MARKER!, JSON.stringify({ version: ${JSON.stringify(version)}, argv: process.argv.slice(2), execArgv: process.execArgv, root: process.env.${INSTALL_ROOT_ENV}, cwd: process.cwd(), pid: process.pid }));`,
    '',
  ].join('\n'));
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'update-launch-')));
  install = join(dir, 'service');
  data = join(install, 'data');
  root = join(install, 'connectome-host');
  marker = join(dir, 'started.json');
  hostPackage(join(install, 'node_modules', '@animalabs', 'connectome-host'), '0.10.2');
  writeFileSync(join(install, 'package.json'), JSON.stringify({ dependencies: { '@animalabs/connectome-host': '^0.10.2' } }));
  writeFileSync(join(install, 'package-lock.json'), '{"lockfileVersion":3}');
  mkdirSync(join(data, 'sessions'), { recursive: true });
  writeFileSync(join(data, 'sessions', 'store.txt'), 'A wrote this');
  setup({
    cwd: install, dataDir: data, root, extraState: [],
    hostRoot: join(install, 'node_modules', '@animalabs', 'connectome-host'),
    say: () => {}, units: () => ({ found: [], unasked: [], unresolved: [], defaulted: [] }),
  });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** Start the service as its unit would: the entry point, from the install. */
function start(...args: string[]): { exitCode: number; pid: number; stderr: string } {
  const run = Bun.spawnSync([process.execPath, join(root, ENTRY_POINT), ...args], {
    cwd: install,
    env: { ...process.env, DATA_DIR: data, MARKER: marker },
    stderr: 'pipe',
  });
  return { exitCode: run.exitCode ?? -1, pid: run.pid, stderr: run.stderr.toString() };
}

describe('a start, end to end', () => {
  test("a runtime without process.execve starts nothing, saying why, before it acts on a mark", () => {
    const preload = join(dir, 'no-execve.ts');
    writeFileSync(preload, "Object.defineProperty(process, 'execve', { value: undefined, configurable: true, writable: true });\n");
    hostPackage(join(releaseDir(root, '0.11.0'), RELEASE_HOST), '0.11.0');
    writeJsonAtomic(installPaths(root).mark, { v: 1, id: 'm1', at: '2026-10-20T00:00:00Z', to: '0.11.0', why: 'update' } satisfies Mark);
    const run = Bun.spawnSync([process.execPath, '--preload', preload, join(root, ENTRY_POINT)], {
      cwd: install, env: { ...process.env, DATA_DIR: data, MARKER: marker }, stderr: 'pipe',
    });
    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toContain('[update] Nothing started: this runtime has no process.execve');
    expect(existsSync(marker)).toBe(false);
    expect(readJournal(root)).toEqual([]);
  });

  test("a --preload the service gives runs in the launcher and again in the host, once each, in the one process", () => {
    const preload = join(dir, 'preload.js');
    const seen = join(dir, 'preloaded.txt');
    writeFileSync(preload, `require('node:fs').appendFileSync(${JSON.stringify(seen)}, process.pid + '\\n');`);
    const run = Bun.spawnSync([process.execPath, '--preload', preload, join(root, ENTRY_POINT), '--recipe', 'r.json'], {
      cwd: install, env: { ...process.env, DATA_DIR: data, MARKER: marker }, stderr: 'pipe',
    });
    expect(run.exitCode).toBe(0);
    expect(readFileSync(seen, 'utf-8').trim().split('\n')).toEqual([String(run.pid), String(run.pid)]);
    expect(JSON.parse(readFileSync(marker, 'utf-8')).execArgv).toEqual(['--preload', preload]);
  });

  test("the runtime's own flags, as the service gave them, reach the host", () => {
    const run = Bun.spawnSync([process.execPath, '--smol', join(root, ENTRY_POINT), '--recipe', 'r.json'], {
      cwd: install, env: { ...process.env, DATA_DIR: data, MARKER: marker }, stderr: 'pipe',
    });
    expect(run.exitCode).toBe(0);
    const host = JSON.parse(readFileSync(marker, 'utf-8'));
    expect(host.execArgv).toEqual(['--smol']);
    expect(host.argv).toEqual(['--recipe', 'r.json']);
  });

  test('the entry point starts the release current names, which becomes its host in the same process, with the install root and the service\'s arguments', () => {
    const run = start('--recipe', 'r.json');
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(marker, 'utf-8'))).toEqual({
      version: '0.10.2', argv: ['--recipe', 'r.json'], execArgv: [], root, cwd: install, pid: run.pid,
    });
  });

  test('a mark switches to the release it names: the next start copies the data and runs that release on trial', () => {
    hostPackage(join(releaseDir(root, '0.11.0'), RELEASE_HOST), '0.11.0');
    writeJsonAtomic(installPaths(root).mark, { v: 1, id: 'm1', at: '2026-10-20T00:00:00Z', to: '0.11.0', why: 'update' } satisfies Mark);
    const run = start();
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(marker, 'utf-8'))).toMatchObject({ version: '0.11.0', pid: run.pid });
    expect(readJournal(root).map((l) => `${l.step} ${l.outcome}`)).toEqual(['copy ok', 'trial-start ok']);
  });

  test("after a committed switch each start names the shell's Go back, which asks the next start for it, and that start goes back", () => {
    hostPackage(join(releaseDir(root, '0.11.0'), RELEASE_HOST), '0.11.0');
    writeJsonAtomic(installPaths(root).mark, { v: 1, id: 'm1', at: '2026-10-20T00:00:00Z', to: '0.11.0', why: 'update' } satisfies Mark);
    // A trial's start names no Go back: the shell's would be refused while a trial is under way.
    const trial = start();
    expect(trial.exitCode).toBe(0);
    expect(trial.stderr).not.toContain('--go-back');
    // The stand-in host doesn't commit, so the test does as the real one would.
    moveCurrent(root, '0.11.0');
    appendJournal(root, { at: '2026-10-20T00:01:00Z', step: 'commit', from: '0.10.2', to: '0.11.0', outcome: 'ok' });
    const named = start();
    expect(named.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(marker, 'utf-8')).version).toBe('0.11.0');
    expect(named.stderr).toContain(`[update] Going back to 0.10.2 is offered, with the copy of its data taken `);
    expect(named.stderr).toContain(`\`bun ${join(root, ENTRY_POINT)} --go-back\` asks the next start to go back`);

    rmSync(marker);
    const asked = start('--go-back', '--keep-data');
    expect(asked.exitCode).toBe(0);
    expect(asked.stderr).toContain('[update] The next start goes back to 0.10.2, keeping the newer data.');
    expect(existsSync(marker)).toBe(false);
    expect(readRecord<Mark>(installPaths(root).mark, 'mark')).toMatchObject({ to: '0.10.2', why: 'go-back', keepData: true });
    expect(existsSync(installPaths(root).lock)).toBe(false);

    const back = start();
    expect(back.exitCode).toBe(0);
    expect(back.stderr).not.toContain('Going back to');
    expect(JSON.parse(readFileSync(marker, 'utf-8')).version).toBe('0.10.2');
    expect(readJournal(root).map((l) => `${l.step} ${l.outcome}`).slice(-2)).toEqual(['go-back ok', 'trial-start ok']);
  });

  test('--go-back with no Go back offered asks for nothing, and starts nothing', () => {
    const run = start('--go-back');
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('[update] Nothing was asked for: no Go back is offered: 0.10.2 runs');
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(installPaths(root).mark)).toBe(false);
  });

  test('a release whose host is missing: says so, tagged, exits 1, and nothing started', () => {
    rmSync(join(releaseDir(root, '0.10.2'), HOST_ENTRY));
    const run = start();
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(`[update] Nothing started: 0.10.2's host isn't at ${join(releaseDir(root, '0.10.2'), HOST_ENTRY)}.`);
    expect(() => readFileSync(marker)).toThrow();
  });

  test('a start the launcher refuses: says why, tagged, exits 1, and nothing started', () => {
    rmSync(installPaths(root).install);
    const run = start();
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(`[update] Nothing started: This install has no record at ${installPaths(root).install}`);
    expect(() => readFileSync(marker)).toThrow();
  });
});
