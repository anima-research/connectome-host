import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as contract from '../src/update/contract.js';
import { installPaths, moveCurrent, readCurrent, readJournal, writeJsonAtomic, writeMark } from '../src/update/contract.js';
import { HOST_ROOT, StartRefusal, commitRelease, releaseHere } from '../src/update/host.js';

let dir: string;
let root: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'update-host-')));
  root = join(dir, 'install');
  mkdirSync(root);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function release(name: string): string {
  const host = join(root, 'releases', name, 'node_modules', 'connectome-host');
  mkdirSync(host, { recursive: true });
  return host;
}

function refusal(start: () => unknown): string {
  try {
    start();
  } catch (error) {
    expect(error).toBeInstanceOf(StartRefusal);
    return (error as Error).message;
  }
  throw new Error('the start was not refused');
}

describe('releaseHere', () => {
  test('a host no entry point started has no install', () => {
    expect(releaseHere({}, HOST_ROOT)).toBeNull();
    expect(releaseHere({ CONNECTOME_INSTALL_ROOT: '' }, HOST_ROOT)).toBeNull();
  });

  test('names the release whose real path holds the host, reached directly, through current, or as a link', () => {
    release('0.10.2');
    const host = release('0.11.0');
    const env = { CONNECTOME_INSTALL_ROOT: root };
    expect(releaseHere(env, host)).toEqual({ root, release: '0.11.0' });
    moveCurrent(root, '0.11.0');
    expect(releaseHere(env, join(root, 'current', 'node_modules', 'connectome-host'))).toEqual({ root, release: '0.11.0' });
    const wrapped = join(dir, 'old-install');
    mkdirSync(join(wrapped, 'node_modules', 'connectome-host'), { recursive: true });
    symlinkSync(wrapped, join(root, 'releases', '0.9.0'));
    expect(releaseHere(env, join(wrapped, 'node_modules', 'connectome-host'))).toEqual({ root, release: '0.9.0' });
  });

  test('refuses an install none of whose releases holds the host, with or without a releases directory, and a sibling whose name starts with a release\'s is not inside it', () => {
    const env = { CONNECTOME_INSTALL_ROOT: root };
    const none = `CONNECTOME_INSTALL_ROOT names the install at ${root}, but none of its releases holds this host ` +
      `(${realpathSync(HOST_ROOT)}). Only an install's entry point sets CONNECTOME_INSTALL_ROOT: to run this host on ` +
      'its own, start it without that variable.';
    expect(refusal(() => releaseHere(env, HOST_ROOT))).toBe(none);
    release('0.11.0');
    mkdirSync(join(root, 'releases', '0.11.0-other'));
    expect(refusal(() => releaseHere(env, HOST_ROOT))).toBe(none);
    expect(releaseHere(env, join(root, 'releases', '0.11.0-other'))).toEqual({ root, release: '0.11.0-other' });
  });

  test('refuses a host two releases hold, since it could commit the wrong one', () => {
    const host = release('0.11.0');
    symlinkSync(join(root, 'releases', '0.11.0'), join(root, 'releases', 'latest'));
    expect(refusal(() => releaseHere({ CONNECTOME_INSTALL_ROOT: root }, host))).toBe(
      `CONNECTOME_INSTALL_ROOT names the install at ${root}, and 2 of its releases hold this host (0.11.0, latest), ` +
      `so it can't tell which release it is. Each entry of ${join(root, 'releases')} should be a release of its own.`,
    );
  });
  test('passes over a release entry that is a link to nothing', () => {
    const host = release('0.11.0');
    symlinkSync(join(dir, 'gone'), join(root, 'releases', '0.10.2'));
    expect(releaseHere({ CONNECTOME_INSTALL_ROOT: root }, host)).toEqual({ root, release: '0.11.0' });
  });

  test("refuses, naming the error, when the releases directory or an entry of it can't be read", () => {
    const host = release('0.11.0');
    const env = { CONNECTOME_INSTALL_ROOT: root };
    symlinkSync(join(root, 'releases', 'loop'), join(root, 'releases', 'loop'));
    expect(refusal(() => releaseHere(env, host))).toMatch(new RegExp(
      `^CONNECTOME_INSTALL_ROOT names the install at ${root}, and the entry loop of ${join(root, 'releases')} can't be ` +
      "read, so this host can't tell which of its releases it is: ELOOP",
    ));
    rmSync(join(root, 'releases'), { recursive: true });
    writeFileSync(join(root, 'releases'), 'not a directory');
    expect(refusal(() => releaseHere(env, HOST_ROOT))).toMatch(new RegExp(
      `^CONNECTOME_INSTALL_ROOT names the install at ${root}, and its releases directory ${join(root, 'releases')} ` +
      "can't be read, so this host can't tell which of its releases it is: ENOTDIR",
    ));
  });
});

describe('commitRelease', () => {
  const at = new Date('2026-10-19T17:00:00Z');
  const here = { root: '', release: '0.11.0' };
  beforeEach(() => { here.root = root; });

  test('moves current to the release and records the commit in the journal', () => {
    moveCurrent(root, '0.10.2');
    expect(commitRelease(here, { now: at, unconnectedServers: () => [] })).toEqual({ from: '0.10.2' });
    expect(readlinkSync(installPaths(root).current)).toBe(join('releases', '0.11.0'));
    expect(readJournal(root)).toEqual([{ v: 1, at: at.toISOString(), step: 'commit', from: '0.10.2', to: '0.11.0', outcome: 'ok' }]);
  });

  test("a start on trial with a server it couldn't connect commits nothing and says which", () => {
    moveCurrent(root, '0.10.2');
    expect(refusal(() => commitRelease(here, { now: at, unconnectedServers: () => ['discord', 'heartbeat'] }))).toBe(
      "The MCPL servers discord, heartbeat weren't connected when this release went to commit, so it starts none of " +
      'its agents, and the next start goes back to 0.10.2: with no readable record of this request saying which ' +
      "servers 0.10.2 had connected when it stopped, a release on trial commits only once every server it's " +
      "configured with is connected, closed tabs aside. This start's log says why each one failed.",
    );
    expect(readCurrent(root)).toBe('0.10.2');
    expect(existsSync(installPaths(root).journal)).toBe(false);
  });

  test('a server the release before had connected when it stopped holds the commit, and one it hadn\'t doesn\'t', () => {
    moveCurrent(root, '0.10.2');
    writeMark(root, { to: '0.11.0', why: 'update', connected: ['heartbeat', 'notes'] });
    const logged = spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(refusal(() => commitRelease(here, { now: at, unconnectedServers: () => ['discord', 'heartbeat'] }))).toBe(
        "The MCPL server heartbeat wasn't connected when this release went to commit, so it starts none of its " +
        "agents, and the next start goes back to 0.10.2: a release on trial commits only once it has connected each " +
        "server it's configured with that 0.10.2 had connected when it stopped, closed tabs aside. This start's log " +
        'says why each one failed.',
      );
      expect(logged.mock.calls).toEqual([[
        "[update] The MCPL server discord isn't connected, and 0.10.2 hadn't connected it when it stopped either, so " +
        "it doesn't hold this release's commit.",
      ]]);
    } finally {
      logged.mockRestore();
    }
    expect(readCurrent(root)).toBe('0.10.2');
    expect(existsSync(installPaths(root).journal)).toBe(false);
  });

  test("a server the release before hadn't connected either doesn't hold the commit, and the start says so", () => {
    moveCurrent(root, '0.10.2');
    writeMark(root, { to: '0.11.0', why: 'update', connected: [] });
    const logged = spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(commitRelease(here, { now: at, unconnectedServers: () => ['discord'] })).toEqual({ from: '0.10.2' });
      expect(logged.mock.calls).toEqual([[
        "[update] The MCPL server discord isn't connected, and 0.10.2 hadn't connected it when it stopped either, so " +
        "it doesn't hold this release's commit.",
      ]]);
    } finally {
      logged.mockRestore();
    }
    expect(readCurrent(root)).toBe('0.11.0');
    expect(readJournal(root).map(({ step }) => step)).toEqual(['commit']);
  });

  test('a request that doesn\'t record its servers, as a release before the record or a Go back from a shell writes, one whose record this release can\'t read, one for another release, or a mark that can\'t be read, counts every server', () => {
    moveCurrent(root, '0.10.2');
    const every = "The MCPL servers discord, heartbeat weren't connected when this release went to commit, so it starts " +
      'none of its agents, and the next start goes back to 0.10.2: with no readable record of this request saying ' +
      "which servers 0.10.2 had connected when it stopped, a release on trial commits only once every server it's " +
      "configured with is connected, closed tabs aside. This start's log says why each one failed.";
    const start = () => commitRelease(here, { now: at, unconnectedServers: () => ['discord', 'heartbeat'] });
    writeJsonAtomic(installPaths(root).mark, { v: 1, id: 'm1', to: '0.11.0', why: 'update', at: at.toISOString() });
    expect(refusal(start)).toBe(every);
    writeJsonAtomic(installPaths(root).mark, { v: 1, id: 'm1', to: '0.11.0', why: 'go-back', at: at.toISOString(), keepData: true });
    expect(refusal(start)).toBe(every);
    writeJsonAtomic(installPaths(root).mark, { v: 1, id: 'm1', to: '0.11.0', why: 'update', at: at.toISOString(), connected: [42] });
    expect(refusal(start)).toBe(every);
    writeJsonAtomic(installPaths(root).mark, { v: 1, id: 'm1', to: '0.11.0', why: 'update', at: at.toISOString(), connected: 'heartbeat' });
    expect(refusal(start)).toBe(every);
    writeMark(root, { to: '0.12.0', why: 'update', connected: [] });
    expect(refusal(start)).toBe(every);
    writeFileSync(installPaths(root).mark, 'not json');
    expect(refusal(start)).toBe(every);
    expect(readCurrent(root)).toBe('0.10.2');
  });

  test('a start already committed starts whatever its servers did', () => {
    moveCurrent(root, '0.11.0');
    expect(commitRelease(here, { now: at, unconnectedServers: () => ['discord'] })).toBeUndefined();
    expect(readCurrent(root)).toBe('0.11.0');
  });

  test('an install with no current starts nothing, as its launcher would, and says to run setup again', () => {
    expect(refusal(() => commitRelease(here, { now: at }))).toBe(
      `The install at ${root} has no \`current\` to say which release it runs on, so this host starts none of its ` +
      'agents. Run setup again.',
    );
    expect(readCurrent(root)).toBeNull();
    expect(existsSync(installPaths(root).journal)).toBe(false);
  });

  test('writes nothing when current already names the release, and syncs the root before any agent starts', () => {
    moveCurrent(root, '0.11.0');
    const sync = spyOn(contract, 'syncDir');
    try {
      expect(commitRelease(here, { now: at })).toBeUndefined();
      expect(sync.mock.calls).toEqual([[root]]);
    } finally {
      sync.mockRestore();
    }
    expect(existsSync(installPaths(root).journal)).toBe(false);
  });

  test("a start whose release current names, and that can't sync it, starts nothing and says why", () => {
    moveCurrent(root, '0.11.0');
    const sync = spyOn(contract, 'syncDir').mockImplementation(() => { throw new Error('EIO: i/o error, fsync'); });
    try {
      expect(refusal(() => commitRelease(here, { now: at }))).toBe(
        `This host couldn't sync \`current\`, which names 0.11.0, to disk at ${root}, so none of its agents started ` +
        'and it exits: EIO: i/o error, fsync. Its next start, which its service makes, syncs again.',
      );
    } finally {
      sync.mockRestore();
    }
  });

  test("a move that fails after its rename says that current names the release, unsynced, and the next start syncs it", () => {
    moveCurrent(root, '0.10.2');
    const sync = spyOn(contract, 'syncDir').mockImplementation(() => { throw new Error('EIO: i/o error, fsync'); });
    try {
      expect(refusal(() => commitRelease(here, { now: at }))).toBe(
        `This host moved \`current\` to 0.11.0 at ${root} but couldn't sync the move to disk, so none of its agents ` +
        'started and it exits: EIO: i/o error, fsync. Its next start runs 0.11.0, and syncs the root again before any ' +
        'agent starts. A disk that failed a sync may not have kept the move: check the disk, and which release ' +
        '`current` names once the install has started again.',
      );
    } finally {
      sync.mockRestore();
    }
    expect(readCurrent(root)).toBe('0.11.0');
    expect(existsSync(installPaths(root).journal)).toBe(false);
    expect(commitRelease(here, { now: at })).toBeUndefined();
  });

  test("a move that fails, after which current can't be read, says it can't tell which release current names", () => {
    moveCurrent(root, '0.10.2');
    const move = spyOn(contract, 'moveCurrent').mockImplementation(() => { throw new Error('EIO: i/o error, rename'); });
    let reads = 0;
    const read = spyOn(contract, 'readCurrent').mockImplementation(() => {
      if (++reads === 1) return '0.10.2';
      throw new Error('EIO: i/o error, readlink');
    });
    try {
      expect(refusal(() => commitRelease(here, { now: at }))).toBe(
        `This host couldn't record 0.11.0 as the release the install at ${root} runs on, so none of its agents ` +
        "started: EIO: i/o error, rename. It couldn't read `current` afterwards either, so it can't tell whether " +
        '`current` names 0.11.0 or 0.10.2 now: EIO: i/o error, readlink',
      );
    } finally {
      move.mockRestore();
      read.mockRestore();
    }
    expect(existsSync(installPaths(root).journal)).toBe(false);
  });

  test("a move that fails before its rename says the release wasn't recorded", () => {
    moveCurrent(root, '0.10.2');
    mkdirSync(join(`${installPaths(root).current}.tmp`, 'in-the-way'), { recursive: true });
    expect(refusal(() => commitRelease(here, { now: at }))).toStartWith(
      `This host couldn't record 0.11.0 as the release the install at ${root} runs on, so none of its agents started, ` +
      'and the next start goes back to 0.10.2: ',
    );
    expect(readCurrent(root)).toBe('0.10.2');
    expect(existsSync(installPaths(root).journal)).toBe(false);
  });

  test("a `current` that can't be read starts nothing, and says each start reads it again", () => {
    writeFileSync(installPaths(root).current, '0.10.2');
    expect(refusal(() => commitRelease(here, { now: at }))).toBe(
      `This host couldn't read which release the install at ${root} runs on, so none of its agents started: ` +
      `EINVAL: invalid argument, readlink '${installPaths(root).current}'. Each start reads \`current\` again before ` +
      'any agent starts.',
    );
    expect(existsSync(installPaths(root).journal)).toBe(false);
  });

  test("a commit whose journal line can't be written still stands, and says so", () => {
    moveCurrent(root, '0.10.2');
    mkdirSync(installPaths(root).journal);
    const logged: string[] = [];
    const log = spyOn(console, 'error').mockImplementation((line) => { logged.push(String(line)); });
    try {
      expect(commitRelease(here, { now: at })).toEqual({ from: '0.10.2' });
    } finally {
      log.mockRestore();
    }
    expect(readCurrent(root)).toBe('0.11.0');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toStartWith(`[update] 0.11.0 is now the release the install at ${root} runs on, but its journal doesn't say so: adding the commit failed (`);
  });
});
