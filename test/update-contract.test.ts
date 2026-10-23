import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import {
  chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readlinkSync, appendFileSync, existsSync, readdirSync, mkdirSync, symlinkSync,
  renameSync, unlinkSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ContractError, INSTALL_ROOT_ENV, JOURNAL_STEPS, PLACE_KINDS, RESTART_EXIT_CODE, appendJournal, childrenFilePath,
  copyItemName, copyLabelPath, goBackListPath, installPaths, installRootFromEnv, itemSetAsideDir, lastCopy, markSpent,
  moveCurrent, pendingGoBack, readCurrent, realOrResolved, readGoBackList, readJournal, readMark, readRecord, releaseDir, setAsideDir,
  trialPlaces, unfinishedTrial, writeJsonAtomic, type CopyLabel, type GoBackList, type JournalLine, type Mark,
} from '../src/update/contract.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'update-contract-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const line = (step: JournalLine['step'], outcome: JournalLine['outcome'] = 'ok', to = '0.11.0'): JournalLine =>
  ({ v: 1, at: '2026-10-19T16:00:00Z', step, from: '0.10.2', to, outcome });
// Its id as the host makes one.
const mark: Mark = { v: 1, id: randomUUID(), to: '0.11.0', why: 'update', at: '2026-10-19T15:59:00Z' };

describe('the update contract', () => {
  test('installRootFromEnv is null without the root or with an empty one, and gives a relative root resolved', () => {
    expect(installRootFromEnv({})).toBeNull();
    expect(installRootFromEnv({ CONNECTOME_INSTALL_ROOT: '' })).toBeNull();
    expect(installRootFromEnv({ CONNECTOME_INSTALL_ROOT: root })).toBe(root);
    expect(installRootFromEnv({ CONNECTOME_INSTALL_ROOT: 'install' })).toBe(resolve('install'));
  });

  test("realOrResolved resolves a path that isn't there, or runs through a file, by its nearest ancestor, and names any other error", () => {
    const real = realpathSync(root);
    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'link'));
    expect(realOrResolved(join(root, 'link'))).toBe(join(real, 'real'));
    expect(realOrResolved(join(root, 'link', 'not', 'there'))).toBe(join(real, 'real', 'not', 'there'));
    writeFileSync(join(root, 'file'), '');
    expect(realOrResolved(join(root, 'file', 'under'))).toBe(join(real, 'file', 'under'));
    mkdirSync(join(root, 'shut', 'inner'), { recursive: true });
    chmodSync(join(root, 'shut'), 0o600);
    try {
      expect(() => realOrResolved(join(root, 'shut', 'inner'))).toThrow(expect.objectContaining({ code: 'EACCES' }));
    } finally {
      chmodSync(join(root, 'shut'), 0o755);
    }
  });

  test('realOrResolved names a loop of links as the path\'s own error', () => {
    const loop = join(root, 'loop');
    symlinkSync(loop, loop);
    expect(() => realOrResolved(join(loop, 'below'))).toThrow(/ELOOP/);
  });

  test('the names are the contract: an older release reads them, so none changes', () => {
    expect(installPaths('/r')).toEqual({
      root: '/r', releases: '/r/releases', current: '/r/current', install: '/r/install.json', mark: '/r/mark.json',
      journal: '/r/journal.jsonl', lock: '/r/lock.json', copy: '/r/copy', copyTmp: '/r/copy.tmp', copyPrev: '/r/copy.prev',
      setAside: '/r/set-aside', midTurn: '/r/midturn.json',
    });
    expect(releaseDir('/r', '0.11.0')).toBe('/r/releases/0.11.0');
    expect(copyLabelPath('/r/copy.tmp')).toBe('/r/copy.tmp/copy.json');
    expect(setAsideDir('/r', 'm1')).toBe('/r/set-aside/m1');
    expect(itemSetAsideDir('/srv/data', 'm1')).toBe('/srv/data/.connectome-update/set-aside/m1');
    expect(childrenFilePath('/d')).toBe('/d/fleet-children.json');
    expect(INSTALL_ROOT_ENV).toBe('CONNECTOME_INSTALL_ROOT');
    expect(RESTART_EXIT_CODE).toBe(75);
    expect(JOURNAL_STEPS).toEqual(['lock', 'children-check', 'copy', 'trial-start', 'commit', 'fallback', 'go-back', 'notes']);
    expect(goBackListPath('/r', 'm1')).toBe('/r/set-aside/m1/places.json');
    expect(PLACE_KINDS).toEqual(['dir', 'file', 'none']);
  });

  test('a record written atomically reads back, absent reads as null, and fields it does not know are kept for whoever does', () => {
    const { mark } = installPaths(root);
    expect(readRecord<Mark>(mark, 'mark')).toBeNull();
    writeJsonAtomic(mark, { v: 1, id: 'm1', to: '0.11.0', why: 'update', at: '2026-10-19T16:00:00Z', later: 'a field from a newer release' });
    expect(readRecord<Mark & { later?: string }>(mark, 'mark')).toEqual({
      v: 1, id: 'm1', to: '0.11.0', why: 'update', at: '2026-10-19T16:00:00Z', later: 'a field from a newer release',
    });
    expect(readdirSync(root)).toEqual(['mark.json']);
  });

  test('a temporary file or link a crash left behind is replaced by the next write', () => {
    const paths = installPaths(root);
    // Longer than the record written next, so a temporary file that kept its old bytes would show.
    writeFileSync(`${paths.mark}.tmp`, `{ "v": 1, "id": "half a record from a crash", "note": "${'x'.repeat(400)}`);
    symlinkSync(join('releases', '0.9.0'), `${paths.current}.tmp`);
    writeJsonAtomic(paths.mark, mark);
    moveCurrent(root, '0.10.2');
    expect(readRecord<Mark>(paths.mark, 'mark')).toEqual(mark);
    expect(readCurrent(root)).toBe('0.10.2');
    expect(readdirSync(root).sort()).toEqual(['current', 'mark.json']);
  });

  test("a link a crash left that can't be removed is the filesystem's own error, and current stays", () => {
    const { current } = installPaths(root);
    moveCurrent(root, '0.10.2');
    // A directory where the link was: no unlink removes it.
    mkdirSync(`${current}.tmp`);
    expect(() => moveCurrent(root, '0.11.0')).toThrow(expect.objectContaining({ syscall: 'unlink' }));
    expect(readCurrent(root)).toBe('0.10.2');
  });

  test('a record with another version, or not JSON, or not an object, is refused with a sentence naming the file', () => {
    const { mark } = installPaths(root);
    writeFileSync(mark, JSON.stringify({ v: 2, to: '0.12.0' }));
    expect(() => readRecord<Mark>(mark, 'mark')).toThrow(new ContractError(`The mark at ${mark} has version 2, and this release reads only version 1.`));
    // Any v but the number 1 is another version.
    for (const [text, v] of [['{"to":"0.12.0"}', 'undefined'], ['{"v":"1"}', '"1"'], ['{"v":0}', '0']]) {
      writeFileSync(mark, text);
      expect(() => readRecord<Mark>(mark, 'mark')).toThrow(new ContractError(`The mark at ${mark} has version ${v}, and this release reads only version 1.`));
    }
    writeFileSync(mark, '{ "v": 1, "to"');
    expect(() => readRecord<Mark>(mark, 'mark')).toThrow(new ContractError(`The mark at ${mark} isn't JSON, so this release can't read it.`));
    for (const text of ['null', '[]', '1']) {
      writeFileSync(mark, text);
      expect(() => readRecord<Mark>(mark, 'mark')).toThrow(new ContractError(`The mark at ${mark} isn't an object, so this release can't read it.`));
    }
  });

  test("a file that is there but can't be read is an error, not absent", () => {
    const { mark, current } = installPaths(root);
    mkdirSync(mark);
    expect(() => readRecord<Mark>(mark, 'mark')).toThrow(expect.objectContaining({ code: 'EISDIR' }));
    writeFileSync(current, 'a file, not a link');
    expect(() => readCurrent(root)).toThrow(expect.objectContaining({ code: 'EINVAL' }));
    // A journal that can't be read is no empty history: a start would then
    // miss a trial left unfinished.
    const { journal } = installPaths(root);
    symlinkSync(journal, journal);
    expect(() => readJournal(root)).toThrow(expect.objectContaining({ code: 'ELOOP' }));
  });

  test('a write that comes back short and can not be finished fails, and leaves the record and the journal as they were', () => {
    // Under a file-size limit, Linux writes what fits and returns short, and
    // the next write fails with EFBIG. The limit applies to a process of its own.
    const paths = installPaths(root);
    writeJsonAtomic(paths.mark, mark);
    appendJournal(root, { at: '2026-10-19T16:00:00Z', step: 'lock', from: '0.10.2', to: '0.11.0', outcome: 'ok' });
    const script = join(root, 'short-write.ts');
    writeFileSync(script, [
      `import { appendJournal, installPaths, writeJsonAtomic } from ${JSON.stringify(resolve(import.meta.dir, '../src/update/contract.ts'))};`,
      'const root = process.argv[2];',
      "const long = 'x'.repeat(8192);",
      'const outcome = (write: () => void): string => {',
      "  try { write(); return 'returned'; } catch (error) { return (error as NodeJS.ErrnoException).code ?? String(error); }",
      '};',
      'console.log(JSON.stringify({',
      "  record: outcome(() => writeJsonAtomic(installPaths(root).mark, { v: 1, id: 'm2', to: '0.12.0', why: 'update', at: 'T', note: long })),",
      "  journal: outcome(() => appendJournal(root, { at: 'T', step: 'copy', from: '0.10.2', to: '0.12.0', outcome: 'failed', reason: long })),",
      '}));',
    ].join('\n'));
    const run = Bun.spawnSync(['bash', '-c', 'trap "" XFSZ; ulimit -f 4; exec "$0" "$@"', process.execPath, script, root]);
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout.toString())).toEqual({ record: 'EFBIG', journal: 'EFBIG' });
    expect(readRecord<Mark>(paths.mark, 'mark')).toEqual(mark);
    expect(readJournal(root).map((l) => l.step)).toEqual(['lock']);
    // The part of a line that fit is cut away by the next append.
    appendJournal(root, { at: '2026-10-19T16:01:00Z', step: 'lock', from: '0.10.2', to: '0.12.0', outcome: 'ok' });
    expect(readJournal(root).map((l) => l.at)).toEqual(['2026-10-19T16:00:00Z', '2026-10-19T16:01:00Z']);
  });

  test('a write that comes back short is finished from where it stopped', () => {
    // Every write here takes at most 7 bytes, so each record and line takes
    // many. Whatever else the module passes goes through as it was given.
    const real = fs.writeSync;
    let cut = 0;
    const short = spyOn(fs, 'writeSync').mockImplementation(((fd: number, buffer: NodeJS.ArrayBufferView, offset?: number, length?: number, ...rest: unknown[]) => {
      const asked = length ?? buffer.byteLength;
      if (asked > 7) cut++;
      return (real as (...args: unknown[]) => number)(fd, buffer, offset, Math.min(asked, 7), ...rest);
    }) as typeof fs.writeSync);
    try {
      writeJsonAtomic(installPaths(root).mark, mark);
      appendJournal(root, { at: '2026-10-19T16:00:00Z', step: 'lock', from: '0.10.2', to: '0.11.0', outcome: 'ok' });
    } finally {
      short.mockRestore();
    }
    // The module's writes went through the spy and came back short.
    expect(cut).toBeGreaterThan(10);
    expect(readRecord<Mark>(installPaths(root).mark, 'mark')).toEqual(mark);
    expect(readJournal(root)).toEqual([{ v: 1, at: '2026-10-19T16:00:00Z', step: 'lock', from: '0.10.2', to: '0.11.0', outcome: 'ok' }]);
  });

  test('a record and every append are written, synced, and then the root synced; a move of current syncs the root after its rename', () => {
    // What each step does to which path, in order: the descriptor each write
    // and sync is on is mapped back to the path it was opened on.
    const opened = new Map<number, string>();
    const did: string[] = [];
    const real = { open: fs.openSync, write: fs.writeSync, sync: fs.fsyncSync, rename: fs.renameSync };
    const pathOf = (fd: number): string => opened.get(fd) ?? 'an unknown descriptor';
    const spies = [
      spyOn(fs, 'openSync').mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
        const fd = (real.open as (...args: unknown[]) => number)(path, ...rest);
        opened.set(fd, String(path));
        return fd;
      }) as typeof fs.openSync),
      spyOn(fs, 'writeSync').mockImplementation(((fd: number, ...rest: unknown[]) => {
        // A write loop's writes count as one write.
        if (did.at(-1) !== `write ${pathOf(fd)}`) did.push(`write ${pathOf(fd)}`);
        return (real.write as (...args: unknown[]) => number)(fd, ...rest);
      }) as typeof fs.writeSync),
      spyOn(fs, 'fsyncSync').mockImplementation(((fd: number) => {
        did.push(`sync ${pathOf(fd)}`);
        return real.sync(fd);
      }) as typeof fs.fsyncSync),
      spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
        did.push(`rename to ${String(to)}`);
        return real.rename(from, to);
      }) as typeof fs.renameSync),
    ];
    const { mark: markPath, journal, current } = installPaths(root);
    const step = (act: () => void): string[] => { did.length = 0; act(); return [...did]; };
    try {
      expect(step(() => writeJsonAtomic(markPath, mark)))
        .toEqual([`write ${markPath}.tmp`, `sync ${markPath}.tmp`, `rename to ${markPath}`, `sync ${root}`]);
      // The append that makes the journal, and one to a journal already there.
      expect(step(() => appendJournal(root, line('lock')))).toEqual([`write ${journal}`, `sync ${journal}`, `sync ${root}`]);
      expect(step(() => appendJournal(root, line('copy')))).toEqual([`write ${journal}`, `sync ${journal}`, `sync ${root}`]);
      expect(step(() => moveCurrent(root, '0.10.2'))).toEqual([`rename to ${current}`, `sync ${root}`]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  test('the journal reads back its lines whole, none when there is no journal, and a last line cut off as it was written counts as not recorded', () => {
    // A fresh install's first start: no journal, so no history.
    expect(readJournal(root)).toEqual([]);
    appendJournal(root, { at: '2026-10-19T16:00:00Z', step: 'lock', from: '0.10.2', to: '0.11.0', outcome: 'ok' });
    appendJournal(root, { at: '2026-10-19T16:00:01Z', step: 'copy', from: '0.10.2', to: '0.11.0', outcome: 'failed', reason: 'ENOSPC' });
    appendJournal(root, { at: '2026-10-19T16:00:02Z', step: 'go-back', from: '0.11.0', to: '0.10.2', outcome: 'ok', mark: 'm9', keptData: true });
    appendFileSync(installPaths(root).journal, '{"v":1,"at":"2026-10-19T16:00:03Z","step":"trial-');
    expect(readJournal(root)).toEqual([
      { v: 1, at: '2026-10-19T16:00:00Z', step: 'lock', from: '0.10.2', to: '0.11.0', outcome: 'ok' },
      { v: 1, at: '2026-10-19T16:00:01Z', step: 'copy', from: '0.10.2', to: '0.11.0', outcome: 'failed', reason: 'ENOSPC' },
      { v: 1, at: '2026-10-19T16:00:02Z', step: 'go-back', from: '0.11.0', to: '0.10.2', outcome: 'ok', mark: 'm9', keptData: true },
    ]);
  });

  test('a line appended after one cut off as it was written replaces the cut line rather than joining it', () => {
    const { journal } = installPaths(root);
    appendJournal(root, { at: '2026-10-19T16:00:00Z', step: 'lock', from: '0.10.2', to: '0.11.0', outcome: 'ok' });
    appendFileSync(journal, '{"v":1,"at":"2026-10-19T16:00:02Z","step":"trial-');
    appendJournal(root, { at: '2026-10-19T16:05:00Z', step: 'lock', from: '0.10.2', to: '0.11.0', outcome: 'ok' });
    expect(readJournal(root).map((l) => l.at)).toEqual(['2026-10-19T16:00:00Z', '2026-10-19T16:05:00Z']);
    // A file holding only a cut line is emptied first.
    writeFileSync(journal, '{"v":1,"at":"2026-10-19T16:00:02Z","step":"trial-');
    appendJournal(root, { at: '2026-10-19T16:06:00Z', step: 'lock', from: '0.10.2', to: '0.11.0', outcome: 'ok' });
    expect(readJournal(root).map((l) => l.at)).toEqual(['2026-10-19T16:06:00Z']);
  });

  test('a journal line that can not be read, short of the last, is refused with its number', () => {
    const { journal } = installPaths(root);
    writeFileSync(journal, `${JSON.stringify(line('lock'))}\nnot json\n${JSON.stringify(line('copy'))}\n`);
    expect(() => readJournal(root)).toThrow(new ContractError(`Line 2 of the journal at ${journal} isn't JSON, so this release can't read it.`));
    writeFileSync(journal, `${JSON.stringify({ ...line('lock'), v: 2 })}\n`);
    expect(() => readJournal(root)).toThrow(new ContractError(`Line 1 of the journal at ${journal} has version 2, and this release reads only version 1.`));
  });

  test('current moves in one step to the release named, as a link inside the install', () => {
    expect(readCurrent(root)).toBeNull();
    moveCurrent(root, '0.10.2');
    expect(readCurrent(root)).toBe('0.10.2');
    moveCurrent(root, '0.11.0');
    expect(readCurrent(root)).toBe('0.11.0');
    expect(readlinkSync(installPaths(root).current)).toBe(join('releases', '0.11.0'));
    expect(readdirSync(root)).toEqual(['current']);
  });

  test('a trial is unfinished until a commit, a fallback or a Go back succeeds, or current names the release it tried', () => {
    expect(unfinishedTrial([], '0.10.2')).toBeNull();
    expect(unfinishedTrial([line('copy'), line('trial-start')], '0.10.2')).toEqual(line('trial-start'));
    expect(unfinishedTrial([line('trial-start'), line('commit')], '0.11.0')).toBeNull();
    expect(unfinishedTrial([line('trial-start'), line('fallback')], '0.10.2')).toBeNull();
    // The commit moved current, and the start that made it died before the journal said so.
    expect(unfinishedTrial([line('trial-start')], '0.11.0')).toBeNull();
    // A commit ends the trial though current has moved on since, as a Go back whose own lines were lost leaves it.
    expect(unfinishedTrial([line('trial-start'), line('commit')], '0.10.2')).toBeNull();
    // A Go back comes only after a commit, so it ends a trial whose commit line was lost.
    expect(unfinishedTrial([line('trial-start'), { ...line('go-back'), from: '0.11.0', to: '0.10.2' }], '0.10.2')).toBeNull();
    // A fallback that failed leaves the trial for the next start.
    expect(unfinishedTrial([line('trial-start'), line('fallback', 'failed')], '0.10.2')).toEqual(line('trial-start'));
    // A trial-start that was refused never started a trial.
    expect(unfinishedTrial([line('trial-start', 'refused')], '0.10.2')).toBeNull();
    // Over a longer history, the latest trial is the one that counts.
    const later = { ...line('trial-start', 'ok', '0.12.0'), from: '0.11.0' };
    expect(unfinishedTrial([line('copy'), line('trial-start'), line('commit'), later], '0.11.0')).toEqual(later);
    expect(unfinishedTrial([line('trial-start'), line('commit'), later, { ...line('fallback'), to: '0.12.0' }], '0.11.0')).toBeNull();
  });

  test('a mark is spent once its switch commits or a fallback for it succeeds, and stands while a switch is refused or its trial runs', () => {
    expect(markSpent(mark, [], '0.10.2')).toBe(false);
    expect(markSpent(mark, [{ ...line('children-check', 'refused'), mark: mark.id }], '0.10.2')).toBe(false);
    expect(markSpent(mark, [{ ...line('trial-start'), mark: mark.id }], '0.10.2')).toBe(false);
    expect(markSpent(mark, [{ ...line('trial-start'), mark: mark.id }], '0.11.0')).toBe(true);
    expect(markSpent(mark, [{ ...line('fallback'), mark: mark.id }], '0.10.2')).toBe(true);
    expect(markSpent(mark, [{ ...line('fallback', 'failed'), mark: mark.id }], '0.10.2')).toBe(false);
    // No line can say that a mark without an id has run, a line that names no mark included.
    expect(markSpent({ ...mark, id: undefined } as unknown as Mark, [line('fallback')], '0.10.2')).toBe(false);
    // A fallback for an earlier request to the same release doesn't spend a new one.
    expect(markSpent(mark, [{ ...line('fallback'), mark: 'm0' }], '0.10.2')).toBe(false);
    // A Go back's mark stands after its restore's line; the older release's commit spends it.
    const goBack: Mark = { v: 1, id: 'g1', to: '0.10.2', why: 'go-back', at: '2026-10-19T17:00:00Z' };
    const restored = { ...line('go-back'), from: '0.11.0', to: '0.10.2', mark: 'g1', keptData: false };
    expect(markSpent(goBack, [restored], '0.11.0')).toBe(false);
    expect(markSpent(goBack, [restored], '0.10.2')).toBe(true);
  });

  test('reading the mark returns a standing one and removes a spent one, spent by a fallback or by its commit', () => {
    const paths = installPaths(root);
    expect(readMark(root)).toBeNull();
    writeJsonAtomic(paths.mark, mark);
    moveCurrent(root, '0.10.2');
    expect(readMark(root)).toEqual(mark);
    expect(existsSync(paths.mark)).toBe(true);
    appendJournal(root, { ...line('fallback'), mark: mark.id });
    expect(readMark(root)).toBeNull();
    expect(existsSync(paths.mark)).toBe(false);

    writeJsonAtomic(paths.mark, { ...mark, id: 'm2' });
    moveCurrent(root, '0.11.0');
    expect(readMark(root)).toBeNull();
    expect(existsSync(paths.mark)).toBe(false);

    // A spent mark that can't be removed is the filesystem's own error, so no
    // start takes it as gone while it stays.
    writeJsonAtomic(paths.mark, { ...mark, id: 'm3' });
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const unlink = spyOn(fs, 'unlinkSync').mockImplementation(() => { throw denied; });
    try {
      expect(() => readMark(root)).toThrow(denied);
    } finally {
      unlink.mockRestore();
    }
    expect(existsSync(paths.mark)).toBe(true);
  });

  test('a mark this release can not use is refused and kept, spent or not: its id and its release each name a directory', () => {
    const paths = installPaths(root);
    const { id: _, ...noId } = mark;
    moveCurrent(root, '0.10.2');
    // A fallback line that names no mark, which mustn't spend a mark without an
    // id, and one that names this mark's, which spends one that has it.
    appendJournal(root, line('fallback'));
    appendJournal(root, { ...line('fallback'), mark: mark.id });
    const remedy = 'Removing the mark file drops its request, which can then be made again, unless the request is ' +
      'under way: a switch from its ok trial-start line, or a Go back from its ok go-back line, until current ' +
      'names the release it asked for or an ok fallback line follows. A request under way goes on from the ' +
      "journal whatever the mark file holds, and before those lines a request hasn't changed the data.";
    const noUsableId = new ContractError(
      `The mark at ${paths.mark} has no id this release can use: an id names the request and the directory a restore ` +
      `sets aside into, so it is one path segment (the host writes a random UUID). ${remedy}`,
    );
    const noUsableRelease = new ContractError(
      `The mark at ${paths.mark} names no release this release can use: its \`to\` names the release's directory, so it ` +
      `is one path segment. ${remedy}`,
    );
    const cases: Array<[unknown, ContractError]> = [
      [noId, noUsableId], [{ ...mark, id: '' }, noUsableId], [{ ...mark, id: '.' }, noUsableId],
      [{ ...mark, id: '..' }, noUsableId], [{ ...mark, id: '../m1' }, noUsableId], [{ ...mark, id: 'm\0' }, noUsableId],
      [{ ...mark, id: 'm'.repeat(256) }, noUsableId],
      // Spent by the fallback line naming its id, and refused all the same.
      [{ ...mark, to: '../releases/0.10.2' }, noUsableRelease],
      // Spent, since current names its release, and refused all the same.
      [{ ...mark, id: 'a/b', to: '0.10.2' }, noUsableId],
    ];
    for (const [unusable, refusal] of cases) {
      writeJsonAtomic(paths.mark, unusable);
      expect(() => readMark(root)).toThrow(refusal);
      expect(existsSync(paths.mark)).toBe(true);
    }
  });

  test('a release or a mark id that is not one path segment names no directory, and a refused move changes nothing', () => {
    const release = (bad: string) => new ContractError(`The release ${JSON.stringify(bad)} isn't one path segment, so it can't name a directory.`);
    const markId = (bad: string) => new ContractError(`The mark id ${JSON.stringify(bad)} isn't one path segment, so it can't name a directory.`);
    // A temporary link a crash left, which a refused move must leave as it is.
    const leftover = `${installPaths(root).current}.tmp`;
    symlinkSync(join('releases', '0.9.0'), leftover);
    // 256 bytes, in ASCII and in two-byte characters, which are only 128.
    for (const bad of ['', '.', '..', '../x', 'a/b', 'a\0b', 'x'.repeat(256), '\u00e9'.repeat(128)]) {
      expect(() => releaseDir('/r', bad)).toThrow(release(bad));
      expect(() => moveCurrent(root, bad)).toThrow(release(bad));
      expect(() => setAsideDir('/r', bad)).toThrow(markId(bad));
      expect(() => itemSetAsideDir('/srv/data', bad)).toThrow(markId(bad));
    }
    expect(readdirSync(root)).toEqual(['current.tmp']);
    expect(readlinkSync(leftover)).toBe(join('releases', '0.9.0'));
    // The host's ids name one directory each, and an entry's name may take 255 bytes.
    expect(setAsideDir('/r', mark.id)).toBe(`/r/set-aside/${mark.id}`);
    expect(itemSetAsideDir('/srv/data', mark.id)).toBe(`/srv/data/.connectome-update/set-aside/${mark.id}`);
    expect(releaseDir('/r', 'x'.repeat(255))).toBe(`/r/releases/${'x'.repeat(255)}`);
    expect(releaseDir('/r', `${'\u00e9'.repeat(127)}x`)).toBe(`/r/releases/${'\u00e9'.repeat(127)}x`);
  });

  test('copy item names start with their position, so no two fold into one name, and each fits one entry', () => {
    expect(copyItemName(0, '/srv/host/data')).toBe('0-data');
    expect(copyItemName(1, '/srv/host/mcpl-servers.json')).toBe('1-mcpl-servers.json');
    expect(copyItemName(2, '/srv/fleet/child-a/data/')).toBe('2-data');
    // Folding case and Unicode form, as a default macOS volume does, keeps them apart.
    const names = [copyItemName(0, '/a/Data'), copyItemName(1, '/b/data'), copyItemName(10, '/c/DATA')];
    expect(new Set(names.map((name) => name.normalize('NFD').toLowerCase())).size).toBe(3);
    // A long last part is cut to fit one entry, 255 bytes, at the end of a character.
    expect(copyItemName(0, `/srv/${'a'.repeat(300)}`)).toBe(`0-${'a'.repeat(253)}`);
    expect(copyItemName(10, `/srv/${'a'.repeat(300)}`)).toBe(`10-${'a'.repeat(252)}`);
    const long = copyItemName(0, `/srv/${'\u{1F600}'.repeat(80)}`);
    expect(long).toBe(`0-${'\u{1F600}'.repeat(63)}`);
    expect(Buffer.byteLength(long)).toBe(254);
  });

  test('the copy is what its label says while every item it lists is there, damaged when one is missing, and none once its label goes', () => {
    const { copy, copyTmp } = installPaths(root);
    expect(lastCopy(root)).toBeNull();
    // Taken as copy.tmp: its items, then its label, then the rename.
    const data = '/srv/host/data';
    const servers = '/srv/host/mcpl-servers.json';
    mkdirSync(join(copyTmp, copyItemName(0, data)), { recursive: true });
    writeFileSync(join(copyTmp, copyItemName(1, servers)), '{}');
    const label: CopyLabel = {
      v: 1, from: '0.10.2', at: '2026-10-19T16:00:00Z',
      items: [{ path: data, name: copyItemName(0, data) }, { path: servers, name: copyItemName(1, servers) }],
    };
    writeJsonAtomic(copyLabelPath(copyTmp), label);
    expect(lastCopy(root)).toBeNull();
    renameSync(copyTmp, copy);
    expect(lastCopy(root)).toEqual(label);
    // A restore copies the items back, so the copy reads as it was afterwards.
    // An item that has gone from it, whichever it is, is damage, which no restore can use.
    renameSync(join(copy, '1-mcpl-servers.json'), join(root, 'lost.json'));
    expect(() => lastCopy(root)).toThrow(new ContractError(
      `The copy at ${copy} has lost 1-mcpl-servers.json, its copy of ${servers}, so it's damaged and no restore can use it.`,
    ));
    renameSync(join(root, 'lost.json'), join(copy, '1-mcpl-servers.json'));
    renameSync(join(copy, '0-data'), join(root, 'lost'));
    expect(() => lastCopy(root)).toThrow(new ContractError(
      `The copy at ${copy} has lost 0-data, its copy of ${data}, so it's damaged and no restore can use it.`,
    ));
    renameSync(join(root, 'lost'), join(copy, '0-data'));
    // An item that can't be looked at is the filesystem's error, not damage.
    const realLstat = fs.lstatSync;
    const unreadable = spyOn(fs, 'lstatSync').mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
      if (String(path) === join(copy, '0-data')) throw Object.assign(new Error('EIO: i/o error, lstat'), { code: 'EIO' });
      return (realLstat as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.lstatSync);
    try {
      expect(() => lastCopy(root)).toThrow(expect.objectContaining({ code: 'EIO' }));
    } finally {
      unreadable.mockRestore();
    }
    // A copy that has lost its label, as only damage leaves one, is no copy.
    unlinkSync(copyLabelPath(copy));
    expect(lastCopy(root)).toBeNull();
  });

  test("a copy's label that can't be read is refused, naming it", () => {
    const { copy } = installPaths(root);
    mkdirSync(copy);
    const path = copyLabelPath(copy);
    const unreadable = new ContractError(
      `The copy's label at ${path} has no list of items this release can read: it lists one or more, each with an ` +
      'absolute path and a name in the copy that is one path segment and starts with its position in the list ' +
      'and a "-", as copyItemName gives it, and then any places that weren\'t there the same way, numbered on.',
    );
    const item = (name: unknown, at: unknown = '/srv/host/data') => ({ path: at, name });
    for (const items of [
      undefined,
      [],
      [null],
      [{ name: '0-data' }],
      [{ path: '/srv/host/data' }],
      [item('0-data', 'srv/host/data')],
      // Each name is its own position's, so two items can't share an entry, nor one be the label.
      [item('data')], [item('copy.json')], [item('0-data'), item('0-data', '/srv/host/child/data')],
      [item('0-a/b')], [item('0-a\0b')], [item(`0-${'a'.repeat(254)}`)], [item(`0-${'\u00e9'.repeat(127)}`)],
      // The position and its "-": position 1 can't take position 10's name.
      [item('0data')], [item('0-data'), item('10-data', '/srv/host/child/data')],
    ]) {
      writeFileSync(path, JSON.stringify({ v: 1, from: '0.10.2', at: 'T1', items }));
      expect(() => lastCopy(root)).toThrow(unreadable);
    }
    // Past its position, a name is the writer's: a later release's naming still reads.
    mkdirSync(join(copy, '0-named-otherwise'));
    const later = { v: 1, from: '0.10.2', at: 'T1', items: [item('0-named-otherwise')] };
    writeFileSync(path, JSON.stringify(later));
    expect(lastCopy(root)).toEqual(later as CopyLabel);
    writeFileSync(path, JSON.stringify({ v: 2, from: '0.10.2', at: 'T1', items: [] }));
    expect(() => lastCopy(root)).toThrow(new ContractError(`The copy's label at ${path} has version 2, and this release reads only version 1.`));
    // The places that weren't there are numbered on from the items, and the
    // copy holds nothing for them.
    const absent = { ...later, absent: [item('1-mcpl-servers.agent.json', '/srv/host/mcpl-servers.agent.json')] };
    writeFileSync(path, JSON.stringify(absent));
    expect(lastCopy(root)).toEqual(absent as CopyLabel);
    for (const list of [[item('0-agent.json')], [item('1-a', 'relative')], 'none', [null], null]) {
      writeFileSync(path, JSON.stringify({ ...later, absent: list }));
      expect(() => lastCopy(root)).toThrow(unreadable);
    }
    // A mark, when there is one, is a mark's id: one path segment.
    writeFileSync(path, JSON.stringify({ ...later, mark: 'm1' }));
    expect(lastCopy(root)).toEqual({ ...later, mark: 'm1' } as CopyLabel);
    for (const mark of [7, '', '..', 'a/b', null, {}]) {
      writeFileSync(path, JSON.stringify({ ...later, mark }));
      expect(() => lastCopy(root)).toThrow(
        new ContractError(`The copy's label at ${path} names a mark this release can't read: a mark's id is one path segment.`),
      );
    }
  });

  test("a Go back's list of places reads back, and one that's missing or that this release can't read is refused, naming it", () => {
    const path = goBackListPath(root, 'g1');
    expect(path).toBe(join(setAsideDir(root, 'g1'), 'places.json'));
    const unreadable = new ContractError(
      `The Go back under mark g1 has no list of its places at ${path} that this release can read, so what it changed can't be found.`,
    );
    expect(() => readGoBackList(root, 'g1')).toThrow(unreadable);
    mkdirSync(setAsideDir(root, 'g1'), { recursive: true });
    const place = { path: '/srv/host/data', name: '0-data', before: 'dir', target: 'dir' };
    const list: GoBackList = {
      v: 1, places: [place as GoBackList['places'][number], { path: '/srv/kid', name: '1-kid', before: 'dir', target: 'none' }],
    };
    writeJsonAtomic(path, list);
    expect(readGoBackList(root, 'g1')).toEqual(list.places);
    for (const places of [
      undefined, 'none', [], [null], [{ ...place, path: 'srv/host/data' }], [{ ...place, path: 7 }], [{ ...place, name: '0-a/b' }],
      [{ ...place, before: 'link' }], [{ ...place, target: undefined }],
      // Each name is numbered by its place in the list, as copyItemName gives it, so no two share an entry.
      [{ ...place, name: 'data' }], [{ ...place, name: 'places.json' }], [place, { ...place, path: '/srv/kid' }],
      // The position and its "-": position 1 can't take position 10's name, and a name must be there to read.
      [{ ...place, name: '0data' }], [place, { ...place, path: '/srv/kid', name: '10-kid' }],
      [{ ...place, name: undefined }], [{ ...place, name: 7 }],
    ]) {
      writeFileSync(path, JSON.stringify({ v: 1, places }));
      expect(() => readGoBackList(root, 'g1')).toThrow(unreadable);
    }
    // A list the filesystem can't read is its own error, not one this release can't read.
    rmSync(path);
    mkdirSync(path);
    expect(() => readGoBackList(root, 'g1')).toThrow(expect.objectContaining({ code: 'EISDIR' }));
  });

  test("the places a trial's fallback would undo: none without a trial, a switch's copy's, and a Go back's list", () => {
    const { copy } = installPaths(root);
    const data = '/srv/host/data';
    const agent = '/srv/host/mcpl-servers.agent.json';
    moveCurrent(root, '0.10.2');
    expect(trialPlaces(root)).toBeNull();
    // A switch's trial: the copy it took, its items and the places that weren't there.
    mkdirSync(join(copy, copyItemName(0, data)), { recursive: true });
    const label: CopyLabel = {
      v: 1, from: '0.10.2', at: 'T1', mark: 'm1',
      items: [{ path: data, name: copyItemName(0, data) }], absent: [{ path: agent, name: copyItemName(1, agent) }],
    };
    writeJsonAtomic(copyLabelPath(copy), label);
    appendJournal(root, { ...line('copy'), mark: 'm1' });
    appendJournal(root, { ...line('trial-start'), mark: 'm1' });
    expect(trialPlaces(root)).toEqual([data, agent]);
    // A label with no places that weren't there gives its items.
    const whole: CopyLabel = { ...label };
    delete whole.absent;
    writeJsonAtomic(copyLabelPath(copy), whole);
    expect(trialPlaces(root)).toEqual([data]);
    // Another switch's copy, one of another release's data, or one that names
    // no mark, isn't this trial's: the fallback would refuse it.
    for (const other of [{ ...label, mark: 'm0' }, { ...label, from: '0.9.0' }, { ...whole, mark: undefined }]) {
      writeJsonAtomic(copyLabelPath(copy), other);
      expect(() => trialPlaces(root)).toThrow(new ContractError(
        `The copy at ${copy} isn't the one the switch to 0.11.0 under mark m1 took from 0.10.2, the release current names ` +
        `(it holds ${other.from}'s data for mark ${other.mark ?? 'none'}), so what its fallback would undo can't be told.`,
      ));
    }
    // The fallback checks the copy against the release current names, so the reader does too.
    writeJsonAtomic(copyLabelPath(copy), label);
    moveCurrent(root, '0.9.0');
    expect(() => trialPlaces(root)).toThrow(/under mark m1 took from 0\.9\.0, the release current names \(it holds 0\.10\.2's/);
    // With no current at all, which the launcher refuses to start without, the copy is no one's.
    unlinkSync(installPaths(root).current);
    expect(() => trialPlaces(root)).toThrow(/under mark m1 took from no release, the release current names \(it holds 0\.10\.2's/);
    // A label the filesystem can't read is passed on as its own error.
    moveCurrent(root, '0.10.2');
    rmSync(copyLabelPath(copy));
    mkdirSync(copyLabelPath(copy));
    expect(() => trialPlaces(root)).toThrow(expect.objectContaining({ code: 'EISDIR' }));
    rmSync(copy, { recursive: true });
    expect(() => trialPlaces(root)).toThrow(/isn't the one the switch to 0\.11\.0 under mark m1 took from 0\.10\.2, the release current names, so/);
    // Once current names the release it tried, the trial is over, though the
    // commit's line hasn't gone in; and once that line is in.
    moveCurrent(root, '0.11.0');
    expect(trialPlaces(root)).toBeNull();
    appendJournal(root, line('commit'));
    expect(trialPlaces(root)).toBeNull();
    // A Go back's trial: every place in its list, though the last switch's copy is still there.
    mkdirSync(join(copy, copyItemName(0, data)), { recursive: true });
    writeJsonAtomic(copyLabelPath(copy), label);
    const back = (step: JournalLine['step'], outcome: JournalLine['outcome'] = 'ok'): JournalLine =>
      ({ ...line(step, outcome, '0.10.2'), from: '0.11.0', mark: 'g1' });
    appendJournal(root, { ...back('go-back'), keptData: false });
    appendJournal(root, back('trial-start'));
    expect(() => trialPlaces(root)).toThrow(/The Go back under mark g1 has no list of its places/);
    const kid = '/srv/kid';
    mkdirSync(setAsideDir(root, 'g1'), { recursive: true });
    writeJsonAtomic(goBackListPath(root, 'g1'), {
      v: 1, places: [
        { path: data, name: '0-data', before: 'dir', target: 'dir' },
        { path: agent, name: '1-mcpl-servers.agent.json', before: 'file', target: 'none' },
        { path: kid, name: '2-kid', before: 'dir', target: 'none' },
      ],
    } satisfies GoBackList);
    expect(trialPlaces(root)).toEqual([data, agent, kid]);
    // A trial-start that names no mark can't say whose places they are.
    appendJournal(root, back('fallback'));
    appendJournal(root, { ...line('trial-start', 'ok', '0.12.0'), from: '0.11.0' });
    expect(() => trialPlaces(root)).toThrow(/trial-start line for 0\.12\.0 names no mark/);
  });

  test("only an ok go-back line with the trial's own mark makes a trial a Go back's", () => {
    const { copy } = installPaths(root);
    const data = '/srv/host/data';
    moveCurrent(root, '0.11.0');
    mkdirSync(join(copy, copyItemName(0, data)), { recursive: true });
    writeJsonAtomic(copyLabelPath(copy), { v: 1, from: '0.11.0', at: 'T2', mark: 'm2', items: [{ path: data, name: '0-data' }] } satisfies CopyLabel);
    // An earlier Go back, under its own mark, then a switch's trial: the copy's places.
    const goBack = (mark: string, outcome: JournalLine['outcome']): JournalLine =>
      ({ ...line('go-back', outcome, '0.10.2'), from: '0.11.0', mark, keptData: true });
    appendJournal(root, goBack('g1', 'ok'));
    appendJournal(root, { ...line('trial-start', 'ok', '0.10.2'), from: '0.11.0', mark: 'g1' });
    appendJournal(root, { ...line('fallback', 'ok', '0.10.2'), from: '0.11.0', mark: 'g1' });
    const trial = (mark: string): JournalLine => ({ ...line('trial-start', 'ok', '0.12.0'), from: '0.11.0', mark });
    appendJournal(root, trial('m2'));
    expect(trialPlaces(root)).toEqual([data]);
    // A go-back line that isn't ok, under the trial's own mark, left the data untouched.
    appendJournal(root, { ...line('fallback', 'ok', '0.12.0'), from: '0.11.0', mark: 'm2' });
    appendJournal(root, goBack('m3', 'refused'));
    writeJsonAtomic(copyLabelPath(copy), { v: 1, from: '0.11.0', at: 'T3', mark: 'm3', items: [{ path: data, name: '0-data' }] } satisfies CopyLabel);
    appendJournal(root, trial('m3'));
    expect(trialPlaces(root)).toEqual([data]);
  });

  test('the Go back a start goes on with: the last ok go-back with no ok trial-start, commit or fallback after it', () => {
    const goBack = (mark: string, outcome: JournalLine['outcome'] = 'ok'): JournalLine => ({ ...line('go-back', outcome, '0.10.2'), mark });
    expect(pendingGoBack([])).toBeNull();
    expect(pendingGoBack([goBack('g1')])).toEqual(goBack('g1'));
    // A refused or failed go-back left the data untouched.
    expect(pendingGoBack([goBack('g1', 'refused')])).toBeNull();
    expect(pendingGoBack([goBack('g1', 'failed')])).toBeNull();
    // Each ok line after it ends it; a refused trial-start or a failed
    // fallback leaves the data as it may be, so the Go back goes on.
    for (const step of ['trial-start', 'commit', 'fallback'] as const) {
      expect(pendingGoBack([goBack('g1'), line(step)])).toBeNull();
      expect(pendingGoBack([goBack('g1'), line(step, step === 'fallback' ? 'failed' : 'refused')])).toEqual(goBack('g1'));
    }
    // The last one counts.
    expect(pendingGoBack([goBack('g1'), line('fallback'), goBack('g2')])).toEqual(goBack('g2'));
    expect(pendingGoBack([goBack('g1'), goBack('g2'), line('trial-start')])).toBeNull();
  });
});
