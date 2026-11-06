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
    const trial = start();
    expect(trial.exitCode).toBe(0);
    expect(trial.stderr).not.toContain('--go-back');
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

describe('the binding check, before any release loads', () => {
  const copyTo = (to: string) => expect(Bun.spawnSync(['cp', '-a', install, to]).exitCode).toBe(0);
  const startIn = (at: string, ...args: string[]) => {
    const run = Bun.spawnSync([process.execPath, join(at, 'connectome-host', ENTRY_POINT), ...args], {
      cwd: at, env: { ...process.env, DATA_DIR: join(at, 'data'), MARKER: marker }, stderr: 'pipe',
    });
    return { exitCode: run.exitCode ?? -1, stderr: run.stderr.toString() };
  };

  const byHandLine = (copy: string, release: string) => {
    const copyRoot = join(copy, 'connectome-host');
    return `run \`${join(copyRoot, 'connectome')} setup discord\`, or, for an install set up by hand, the setup of ${release}, ` +
      `the release whose setup wrote this file, from ${copy} with this install's own DATA_DIR: \`bun --no-env-file ` +
      `${join(releaseDir(copyRoot, release), RELEASE_HOST, 'src', 'update', 'setup.ts')} --root ${copyRoot}\`.`;
  };
  const setupFrom = (copy: string, hostRoot: string) => setup({
    cwd: copy, dataDir: join(copy, 'data'), root: join(copy, 'connectome-host'), extraState: null, hostRoot,
    say: () => {}, units: () => ({ found: [], unasked: [], unresolved: [], defaulted: [] }),
  });

  test('a copy\'s start, and its --go-back, are refused before its launcher runs, naming both directories and the setup of the release whose setup wrote it; once that setup binds it, it starts on its own data', () => {
    const copy = join(dir, 'copy');
    copyTo(copy);
    const copyRoot = join(copy, 'connectome-host');
    for (const args of [[], ['--go-back']]) {
      const run = startIn(copy, ...args);
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain(`connectome-host: nothing runs in this install, since its record is bound to ${install}, and it's in ${copy}, so it was moved or copied here`);
      expect(run.stderr).toContain(byHandLine(copy, '0.10.2'));
    }
    expect(existsSync(marker)).toBe(false);
    expect(readJournal(copyRoot)).toEqual([]);
    expect(existsSync(installPaths(copyRoot).lock)).toBe(false);
    setupFrom(copy, join(releaseDir(copyRoot, '0.10.2'), RELEASE_HOST));
    const run = startIn(copy);
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(marker, 'utf-8'))).toMatchObject({ version: '0.10.2', root: copyRoot, cwd: copy });
  });

  test('a copy whose current names an older release than the one whose setup wrote its entries is sent to that setup, not current\'s, and once it binds, current starts on the copy\'s data', () => {
    hostPackage(join(releaseDir(root, '0.9.0'), RELEASE_HOST), '0.9.0');
    moveCurrent(root, '0.9.0');
    const copy = join(dir, 'copy');
    copyTo(copy);
    const copyRoot = join(copy, 'connectome-host');
    const run = startIn(copy);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(byHandLine(copy, '0.10.2'));
    setupFrom(copy, join(releaseDir(copyRoot, '0.10.2'), RELEASE_HOST));
    expect(readRecord<{ workingDir?: string; dataDir: string }>(installPaths(copyRoot).install, 'record'))
      .toMatchObject({ workingDir: copy, dataDir: join(copy, 'data') });
    expect(startIn(copy).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(marker, 'utf-8'))).toMatchObject({ version: '0.9.0', root: copyRoot, cwd: copy });
  });

  test('a copy whose entries\' release holds no setup in its releases now is sent to its setup by hand, as docs/DEPLOYMENTS.md shows', () => {
    rmSync(join(releaseDir(root, '0.10.2'), RELEASE_HOST, 'src', 'update', 'setup.ts'));
    const copy = join(dir, 'copy');
    copyTo(copy);
    const run = startIn(copy);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(`run \`${join(copy, 'connectome-host', 'connectome')} setup discord\`, or, for an install set up by hand, its setup by hand again, as docs/DEPLOYMENTS.md shows.`);
  });

  test('a record from before workingDir starts as it did', () => {
    writeJsonAtomic(installPaths(root).install, { v: 1, dataDir: data, extraState: [] });
    expect(start().exitCode).toBe(0);
    expect(JSON.parse(readFileSync(marker, 'utf-8')).version).toBe('0.10.2');
  });

  test('a copy from before workingDir, made while the original\'s host ran, meets the lock that came with it, which names that case and setup', () => {
    const host = Bun.spawn(['sleep', '120']);
    try {
      writeJsonAtomic(installPaths(root).install, { v: 1, dataDir: data, extraState: [] });
      writeFileSync(installPaths(root).lock, JSON.stringify({ v: 1, pid: host.pid, bootId: null, at: '2026-11-04T00:00:00.000Z' }));
      const copy = join(dir, 'copy');
      copyTo(copy);
      const run = startIn(copy);
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain(`process ${host.pid}, since 2026-11-04T00:00:00.000Z. An install runs one host at a time, and \`ps -o args= -p ${host.pid}\` shows what that process runs. If it runs the start.js, or a release in the releases directory, of an install root that is this one, ${join(copy, 'connectome-host')}, by any name, it's this install's host: stop it first. \`test ROOT -ef ${join(copy, 'connectome-host')}\`, with ROOT the directory that holds that start.js or releases directory, succeeds when the two are one directory. If it runs setup, it's binding an install: start this one again once that setup has ended. If it runs another install's start.js or a release in another install's releases, this install is a copy made while that host ran, and the lock came with the copy: run setup here first, which binds the copy to its own places and removes a lock it can show came with it, and then remove the lock file if it's still there.`);
    } finally {
      host.kill();
    }
  });
});
