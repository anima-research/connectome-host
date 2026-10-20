/**
 * Reading observers.json: a file that parses is read grant by grant, what
 * the registry and the tools are told about a file of any shape, without a
 * throw, and what the registry admits and logs as the file changes.
 */
import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, utimesSync } from 'node:fs';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadObserversFile, observerStatement, readObserversFile, ObserverRegistry } from '../src/modules/web-ui-observers.js';

// A canonical key: 43 base64url characters whose last one carries no stray bits.
const key = (c: string) => `ed25519:${c.repeat(42)}A`;
const SCOPES = '(the scopes are health, ops, messages, tools, thinking, debug)';
const realReadFileSync = fs.readFileSync;

// A file an operator set up and then broke by hand: a grant with a scope
// that doesn't exist.
const BAD_SCOPE = JSON.stringify({
  observers: [
    { key: key('A'), label: 'baseline', scopes: ['health'], protected: true },
    { key: key('B'), label: 'antra-phone', scopes: ['messages', 'tool-calls'] },
  ],
}, null, 2);

describe('reading the grants file', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'observers-read-'));
    path = join(dir, 'observers.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('a document of another shape is unreadable or holds no grants, never a throw', () => {
    for (const [body, kind, problem] of [
      ['null', 'unreadable', 'isn\'t a grants file: it holds null, not an object with an "observers" list'],
      ['[]', 'unreadable', 'isn\'t a grants file: it holds a list, not an object with an "observers" list'],
      ['42', 'unreadable', 'isn\'t a grants file: it holds a number, not an object with an "observers" list'],
      ['"observers"', 'unreadable', 'isn\'t a grants file: it holds a string, not an object with an "observers" list'],
      ['{"observers": {}}', 'unreadable', 'has an "observers" that isn\'t a list'],
    ] as const) {
      writeFileSync(path, body);
      const read = readObserversFile(path) as { kind: string; problem?: string };
      expect([read.kind, read.problem]).toEqual([kind, problem]);
      expect(loadObserversFile(path)).toBeNull();
    }
    for (const [body, problems] of [['{}', []], ['{"observers": [null]}', ['grant 1 isn\'t an object']]] as const) {
      writeFileSync(path, body);
      const read = readObserversFile(path) as { kind: string; file: { observers: unknown[] }; problems: string[] };
      expect([read.kind, read.file.observers, read.problems]).toEqual(['ok', [], [...problems]]);
    }
  });

  test('an expiry is read as the viewer reads it: falsy is no end, and otherwise Date.parse must read it', () => {
    const withExpiry = (grant: Record<string, unknown>) =>
      JSON.stringify({ observers: [{ key: key('A'), label: 'x', scopes: ['health'], ...grant }] });
    for (const grant of [{}, { expires: null }, { expires: '' }, { expires: false }, { expires: 0 },
      { expires: '2030-01-01T00:00:00Z' }, { expires: 2026 }, { expires: '2024' }, { expires: ['2026-01-01'] }]) {
      writeFileSync(path, withExpiry(grant));
      expect(loadObserversFile(path)?.observers.length).toBe(1);
    }
    for (const expires of ['next week', 1792000000000, true, '2026-13-01', ' ']) {
      writeFileSync(path, withExpiry({ expires }));
      const read = readObserversFile(path) as { kind: string; file: { observers: unknown[] }; problems: string[] };
      expect([read.kind, read.file.observers, read.problems]).toEqual(['ok', [], [`grant 1 ("x") has an expiry that isn't a date: ${JSON.stringify(expires)}`]]);
    }
  });

  test('only a syntax error is unparsed; a parse that gives out otherwise can\'t be checked', () => {
    writeFileSync(path, BAD_SCOPE.slice(0, -10));
    expect(readObserversFile(path).kind).toBe('unparsed');
    writeFileSync(path, BAD_SCOPE);
    const spy = spyOn(JSON, 'parse').mockImplementation(() => { throw new RangeError('Maximum call stack size exceeded'); });
    let read;
    try {
      read = readObserversFile(path);
    } finally {
      spy.mockRestore();
    }
    expect(read).toEqual({ kind: 'unreadable', problem: 'can\'t be checked (Maximum call stack size exceeded)' });
  });

  test('a check that throws makes the file unreadable rather than throwing', () => {
    writeFileSync(path, BAD_SCOPE);
    const spy = spyOn(JSON, 'stringify').mockImplementation(() => { throw new RangeError('boom'); });
    let read;
    try {
      read = readObserversFile(path);
    } finally {
      spy.mockRestore();
    }
    expect(read).toEqual({ kind: 'unreadable', problem: 'can\'t be checked (boom)' });
  });

  // Each of the two reads checks a value nested 100,000 deep until the stack
  // overflows. That takes seconds, and on a busy machine it has run past the
  // default 5 s limit, so the case has a limit of its own. The time is the
  // overflow's, not the depth's: 50,000 deep takes about as long. The depth
  // stays, since a shallower value might not overflow the check on another
  // platform.
  test('a value too deep to check gives no grants, not a throw', () => {
    const deep = '['.repeat(100_000) + ']'.repeat(100_000);
    writeFileSync(path, `{"observers": [{"key": "${key('A')}", "label": "x", "scopes": [${deep}]}]}`);
    // Bun 1.4.3 and 1.3.14 both parse this and overflow checking it, with
    // this text, so a check that threw anything else would fail the case.
    const read = readObserversFile(path) as { kind: string; problem?: string };
    expect(read.kind).toBe('unreadable');
    expect(read.problem).toBe('can\'t be checked (Maximum call stack size exceeded.)');
    expect(loadObserversFile(path)).toBeNull();
  }, 20_000);

  test('a path a read fails on, such as a directory, is unreadable and marked as a failed read', () => {
    mkdirSync(path);
    const read = readObserversFile(path) as { kind: string; problem?: string; readFailed?: boolean };
    expect(read.kind).toBe('unreadable');
    expect(read.problem).toStartWith('can\'t be read (');
    expect(read.readFailed).toBe(true);
  });
});

describe('the registry', () => {
  let dir: string;
  let path: string;
  let bump = 0;
  let lines: string[];
  let spy: ReturnType<typeof spyOn>;
  let readSpy: ReturnType<typeof spyOn>;
  let registry: ObserverRegistry;
  let reads: number;
  let readAs: (() => string) | null;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'observers-registry-'));
    path = join(dir, 'observers.json');
    lines = [];
    reads = 0;
    readAs = null;
    spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    // The registry reads the file with readFileSync. This counts its reads of
    // the file and, while `readAs` is set, stands in for what a read finds (a
    // read that fails, or a save half-written) while the file and its stat
    // stay as they are. A stand-in can end itself after one read.
    readSpy = spyOn(fs, 'readFileSync').mockImplementation(((file: unknown, ...rest: unknown[]) => {
      if (file === path) {
        reads++;
        if (readAs) return readAs();
      }
      return (realReadFileSync as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.readFileSync);
    registry = new ObserverRegistry(path, 20);
  });
  afterEach(() => {
    registry.stop();
    readSpy.mockRestore();
    spy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  /** For a case that runs the registry's checks itself, to count them: a
   *  registry whose own timer doesn't check within the case. */
  const checkedByHand = () => {
    registry = new ObserverRegistry(path, 60_000);
  };
  /** Run one of the registry's checks now, as its timer would. */
  const check = () => (registry as unknown as { check(): void }).check();

  /** Write the file with an mtime of its own, or the one given. */
  const write = (body: string, mtime = new Date(Date.now() + ++bump * 2_000)) => {
    writeFileSync(path, body);
    utimesSync(path, mtime, mtime);
    return mtime;
  };
  /** Wait for what a check should bring about, rather than for a set time. */
  const until = async (done: () => boolean, ms = 3_000) => {
    const end = Date.now() + ms;
    while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  };
  const admitted = () => registry.grants().map((g) => g.label);
  const same = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);
  const file = (...grants: Array<Record<string, unknown>>) => JSON.stringify({ observers: grants });
  const X = { key: key('X'), label: 'x', scopes: ['health'] };
  const Z = { key: key('Z'), label: 'z', scopes: ['health'] };
  const keeping = (l: string) => l.startsWith(`[webui-observers] ${path} isn't valid JSON`) && l.endsWith('— keeping the previous grants until it parses');
  /** A read that fails while the stat succeeds, as with too many files open. */
  const tooManyOpen = (): string => { throw Object.assign(new Error('EMFILE: too many open files, open'), { code: 'EMFILE' }); };

  test('an edit that drops a grant and adds a bad one admits exactly the file\'s good grants', async () => {
    write(file(X, Z));
    registry.start();
    expect(admitted()).toEqual(['x', 'z']);
    write(file({ key: key('Y'), label: 'y', scopes: 'health', expires: 'next week' }, Z));
    await until(() => same(admitted(), ['z']));
    expect(admitted()).toEqual(['z']);
    expect(lines).toContain(`[webui-observers] ${path}: 1 grant(s) not used: grant 1 ("y") has an expiry that isn't a date: "next week"; grant 1 ("y") has no list of scopes`);
  });

  test('at start, the log names each grant it won\'t use', () => {
    write(BAD_SCOPE);
    registry.start();
    expect(admitted()).toEqual(['baseline']);
    expect(lines).toEqual([
      `[webui-observers] ${path}: 1 grant(s) not used: grant 2 ("antra-phone") names a scope that doesn't exist: "tool-calls" ${SCOPES}`,
    ]);
  });

  test('a later write that isn\'t valid JSON keeps the previous grants until it parses, and says so once', () => {
    checkedByHand();
    write(file(X));
    registry.start();
    write('{"observers": [');
    for (let i = 0; i < 4; i++) check();
    // Start's read, then one at each check: it's read again while it doesn't
    // parse, and said once.
    expect(reads).toBe(5);
    expect(admitted()).toEqual(['x']);
    expect(lines).toHaveLength(1);
    expect(lines.filter(keeping)).toHaveLength(1);
    write(file(Z));
    check();
    expect(admitted()).toEqual(['z']);
  });

  test('a read that finds a save half-written is read again at the next check, though the file\'s stat hasn\'t changed', () => {
    checkedByHand();
    write(file(X));
    registry.start();
    // The next read finds the save half-written. The file itself is whole and
    // stays as it is, its stat included.
    const whole = file(Z);
    readAs = () => {
      readAs = null;
      return whole.slice(0, -5);
    };
    write(whole);
    check();
    expect(admitted()).toEqual(['x']);
    expect(lines.filter(keeping)).toHaveLength(1);
    check();
    expect(admitted()).toEqual(['z']);
    // Read whole, it isn't read again until it changes.
    check();
    expect(reads).toBe(3);
  });

  test('a read at start that finds a save half-written is read again at the next check', () => {
    checkedByHand();
    const whole = file(X);
    write(whole);
    readAs = () => {
      readAs = null;
      return whole.slice(0, -5);
    };
    registry.start();
    expect(admitted()).toEqual([]);
    check();
    expect(admitted()).toEqual(['x']);
  });

  test('started on a file that isn\'t valid JSON, it admits none until it parses, and says so once', () => {
    checkedByHand();
    write('{"observers": [');
    registry.start();
    for (let i = 0; i < 3; i++) check();
    // Read again at each check, and said once: it had no grants to keep.
    expect(reads).toBe(4);
    expect(admitted()).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEndWith('— admitting no grants until it parses');
    write(file(X));
    check();
    expect(admitted()).toEqual(['x']);
  });

  test('a later write that isn\'t a grants file admits nothing', async () => {
    write(file(X));
    registry.start();
    write('null');
    await until(() => admitted().length === 0);
    expect(admitted()).toEqual([]);
    expect(lines).toContain(`[webui-observers] ${path} isn't a grants file: it holds null, not an object with an "observers" list — admitting no grants from it`);
  });

  test('a read that keeps failing admits nothing, is tried again at each check, and is named once', () => {
    checkedByHand();
    write(file(X));
    registry.start();
    // Every read fails while this stands. The file and its stat stay as they
    // are, so only a read tried again finds its grants.
    readAs = tooManyOpen;
    write(file(Z));
    for (let i = 0; i < 4; i++) check();
    expect(reads).toBe(5); // start's read, then one at each check
    expect(admitted()).toEqual([]);
    expect(lines).toEqual([`[webui-observers] ${path} can't be read (EMFILE: too many open files, open) — admitting no grants from it`]);
    readAs = null;
    check();
    expect(admitted()).toEqual(['z']);
  });

  test('a read that fails at start is tried again at the next check, though the file\'s stat hasn\'t changed', () => {
    checkedByHand();
    write(file(X));
    readAs = tooManyOpen;
    registry.start();
    expect(admitted()).toEqual([]);
    readAs = null;
    check();
    expect(admitted()).toEqual(['x']);
  });

  test('a file gone between the stat and the read at start is read again at the next check', () => {
    checkedByHand();
    write(file(X));
    // The stat at start finds the file and the read then doesn't, as when a
    // save removes the file before writing it. Here the file and its stat stay
    // as they are, so only a read tried again finds its grants.
    readAs = () => {
      readAs = null;
      throw Object.assign(new Error('ENOENT: no such file or directory, open'), { code: 'ENOENT' });
    };
    registry.start();
    expect(admitted()).toEqual([]);
    expect(lines).toEqual([`[webui-observers] ${path} is gone — admitting no grants from it`]);
    check();
    expect(admitted()).toEqual(['x']);
  });

  test('started on a link whose file is gone, it says so', () => {
    symlinkSync(join(dir, 'gone', 'observers.json'), path);
    registry.start();
    expect(lines).toEqual([`[webui-observers] ${path} is a link to a file that can't be read (ENOENT) — admitting no grants from it`]);
  });

  test('a hello is found whichever spelling of its key the file or the client uses', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
    const raw = spki.subarray(spki.length - 32);
    const url = `ed25519:${raw.toString('base64url')}`;
    const std = `ed25519:${raw.toString('base64')}`;
    const host = 'agent.example:7342';
    const hello = (id: string) => {
      const timestamp = new Date().toISOString();
      const proof = cryptoSign(null, Buffer.from(observerStatement(host, timestamp), 'utf8'), privateKey).toString('base64url');
      return { scheme: 'ed25519' as const, id, proof, timestamp };
    };
    write(file({ key: std, label: 'phone', scopes: ['health'] }));
    registry.start();
    expect(registry.grants().map((g) => g.key)).toEqual([url]);
    expect(registry.verifyHello(hello(url), host)?.grant.label).toBe('phone');
    expect(registry.verifyHello(hello(std), host)?.grant.label).toBe('phone');
    expect(registry.verifyHello(hello(url.slice(0, -1)), host)).toBeNull();
  });
});
