import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { handleCommand } from '../src/commands.js';
import { SessionManager } from '../src/session-manager.js';
import { trackOperatorWork } from '../src/session-switch.js';

type App = Parameters<typeof handleCommand>[1];

const REPO = join(import.meta.dir, '..');
const INDEX = join(REPO, 'src', 'index.ts');
const WARMUP = join(REPO, 'scripts', 'warmup-session.ts');
const RECIPE = {
  name: 'p',
  description: 'p',
  agent: { name: 'agent', provider: 'mock', systemPrompt: 'Never asked.' },
  modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false, webui: false },
};

const WITHOUT_A_STORE: Array<[string, (dir: string) => void]> = [
  ['an empty directory', (dir) => mkdirSync(dir, { recursive: true })],
  ['a directory that holds only lost+found', (dir) => mkdirSync(join(dir, 'lost+found'), { recursive: true })],
  ['a directory that a create left with only LOCK and blobs', (dir) => {
    mkdirSync(join(dir, 'blobs'), { recursive: true });
    writeFileSync(join(dir, 'LOCK'), '');
  }],
  ['a directory that holds records.log and no MANIFEST', (dir) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'records.log'), 'not a log');
  }],
  ['a link to a directory that is not there', (dir) => {
    mkdirSync(dirname(dir), { recursive: true });
    symlinkSync(join(dirname(dir), 'unmounted', 'store'), dir);
  }],
];

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'no-store-'));
  writeFileSync(join(root, 'recipe.json'), JSON.stringify(RECIPE));
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function contents(dir: string): string[] {
  if (!existsSync(dir)) return [`a link to ${readlinkSync(dir)}`];
  return readdirSync(dir, { recursive: true }).map(String).sort().map((entry) => {
    const path = join(dir, entry);
    return statSync(path).isFile() ? `${entry}: ${readFileSync(path, 'hex')}` : `${entry}/`;
  });
}

function chronicleReason(dir: string): string {
  try {
    JsStore.open({ path: dir }).close();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`${dir} opened as a store`);
}

function makeRealStore(dir: string): void {
  JsStore.openOrCreate({ path: dir }).close();
}

const startWords = (session: { name: string; id: string }, dir: string, reason: string) =>
  `Session "${session.name}" [${session.id}] wasn't started: its store directory, ${dir}, is there, and no store ` +
  `opened in it (${reason}). Nothing was written there. If that directory is on a volume, check that the volume ` +
  'is mounted, and start again. If no store is there and the session is to begin empty, remove that directory, ' +
  'and start again: the resident then begins that session with no past.';

const switchWords = (session: { name: string; id: string }, dir: string, reason: string) =>
  `Session "${session.name}" [${session.id}] wasn't switched to, and the session that runs goes on: its store ` +
  `directory, ${dir}, is there, and no store opened in it (${reason}). Nothing was written there. If that ` +
  'directory is on a volume, check that the volume is mounted, and switch again. If no store is there and the ' +
  'session is to begin empty, remove that directory, and switch again: the resident then begins that session ' +
  'with no past.';

const legacyWords = (dir: string, reason: string) =>
  `The store from before sessions wasn't moved, and nothing was started: ${dir} is there, and no store opened in ` +
  `it (${reason}). Nothing was written there. If that directory is on a volume, check that the volume is ` +
  'mounted, and start again. If no store is there and the resident is to begin empty, remove that directory, ' +
  'and start again: the resident then begins with no past.';

async function start(data: string): Promise<{ exitCode: number; stderr: string; reachedSocket: boolean }> {
  const socket = join(data, 'ipc.sock');
  rmSync(socket, { force: true });
  const child = Bun.spawn([process.execPath, '--no-env-file', INDEX, join(root, 'recipe.json'), '--headless'], {
    cwd: root,
    env: {
      PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: root, DATA_DIR: data, CONNECTOME_UPDATE_CHECK: '0',
      ...(process.env.TMPDIR !== undefined ? { TMPDIR: process.env.TMPDIR } : {}),
    },
    stdin: 'ignore', stdout: 'ignore', stderr: 'pipe', timeout: 60_000,
  });
  const stderr = new Response(child.stderr).text();
  let reachedSocket = false;
  while (child.exitCode === null && child.signalCode === null) {
    if (existsSync(socket)) {
      reachedSocket = true;
      child.kill('SIGTERM');
      break;
    }
    await Bun.sleep(20);
  }
  return { exitCode: await child.exited, stderr: await stderr, reachedSocket };
}

describe('a start', () => {
  for (const [kind, make] of WITHOUT_A_STORE) {
    test(`on a session whose store directory is ${kind} is refused, and nothing is written there`, async () => {
      const data = join(root, 'data');
      const sessions = new SessionManager(data);
      const session = sessions.createSession();
      const dir = sessions.getStorePath(session.id);
      make(dir);
      const before = contents(dir);
      const reason = chronicleReason(dir);

      const { exitCode, stderr, reachedSocket } = await start(data);

      expect(stderr).toBe(`${startWords(session, dir, reason)}\n`);
      expect(exitCode).toBe(1);
      expect(reachedSocket).toBe(false);
      expect(contents(dir)).toEqual(before);
    }, 60_000);
  }

  test('on a new data directory, again on its store, and on an indexed session with no directory, starts', async () => {
    const data = join(root, 'data');
    const first = await start(data);
    expect(first.reachedSocket).toBe(true);
    const sessions = new SessionManager(data);
    const made = sessions.getStorePath(sessions.getActiveSession()!.id);
    expect(existsSync(join(made, 'MANIFEST'))).toBe(true);

    expect((await start(data)).reachedSocket).toBe(true);

    const fresh = sessions.createSession();
    const freshDir = sessions.getStorePath(fresh.id);
    expect(existsSync(freshDir)).toBe(false);
    expect((await start(data)).reachedSocket).toBe(true);
    expect(existsSync(join(freshDir, 'MANIFEST'))).toBe(true);
  }, 120_000);

  test('with no index and a store from before sessions that is an empty directory, moves nothing and starts nothing', async () => {
    const data = join(root, 'data');
    const legacy = join(data, 'store');
    mkdirSync(legacy, { recursive: true });
    const reason = chronicleReason(legacy);

    const { exitCode, stderr, reachedSocket } = await start(data);

    expect(stderr).toBe(`${legacyWords(legacy, reason)}\n`);
    expect(exitCode).toBe(1);
    expect(reachedSocket).toBe(false);
    expect(contents(legacy)).toEqual([]);
    expect(existsSync(join(data, 'sessions.json'))).toBe(false);
    expect(existsSync(join(data, 'sessions'))).toBe(false);
  }, 60_000);

  test('with no index and a store from before sessions that is a link to a directory that is not there, moves nothing and starts nothing', async () => {
    const data = join(root, 'data');
    const legacy = join(data, 'store');
    mkdirSync(data, { recursive: true });
    symlinkSync(join(root, 'unmounted', 'store'), legacy);
    const reason = chronicleReason(legacy);

    const { exitCode, stderr, reachedSocket } = await start(data);

    expect(stderr).toBe(`${legacyWords(legacy, reason)}\n`);
    expect(exitCode).toBe(1);
    expect(reachedSocket).toBe(false);
    expect(contents(legacy)).toEqual([`a link to ${join(root, 'unmounted', 'store')}`]);
    expect(existsSync(join(data, 'sessions.json'))).toBe(false);
    expect(existsSync(join(data, 'sessions'))).toBe(false);
  }, 60_000);

  test('with no index and a real store from before sessions, moves it into a session and starts on it', async () => {
    const data = join(root, 'data');
    const legacy = join(data, 'store');
    makeRealStore(legacy);

    expect((await start(data)).reachedSocket).toBe(true);

    expect(existsSync(legacy)).toBe(false);
    const sessions = new SessionManager(data);
    const active = sessions.getActiveSession();
    expect(active?.name).toBe('Initial Session');
    expect(existsSync(join(sessions.getStorePath(active!.id), 'MANIFEST'))).toBe(true);
  }, 60_000);
});

describe('/session switch', () => {
  function appOn(data: string): { app: App; sessions: SessionManager; first: { id: string; name: string }; other: { id: string; name: string } } {
    const sessions = new SessionManager(data);
    const other = sessions.createSession('Other');
    const first = sessions.createSession('First');
    makeRealStore(sessions.getStorePath(first.id));
    const app = {
      framework: { getHostModeStatus: () => ({ quiesced: false, activeTurnAgents: [] }) },
      sessionManager: sessions,
      recipe: { name: 'test' },
      branchState: { checkpoints: new Map([['before', { branchName: 'main' }]]), undoStack: [], redoStack: [] },
      switchSession: async () => {},
    } as unknown as App;
    return { app, sessions, first, other };
  }

  for (const [kind, make] of WITHOUT_A_STORE) {
    test(`to a session whose store directory is ${kind} is refused, and the session that runs goes on`, () => {
      const { app, sessions, first, other } = appOn(join(root, 'data'));
      const dir = sessions.getStorePath(other.id);
      make(dir);
      const before = contents(dir);
      const reason = chronicleReason(dir);

      const result = handleCommand(`/session switch ${other.id}`, app);

      expect(result.lines.map((line) => line.text)).toEqual([switchWords(other, dir, reason)]);
      expect(result.refused).toBe(true);
      expect(result.switchToSessionId).toBeUndefined();
      expect(sessions.getActiveSession()?.id).toBe(first.id);
      expect([...app.branchState.checkpoints.keys()]).toEqual(['before']);
      expect(contents(dir)).toEqual(before);
    });
  }

  test('while other work runs, answers that the work runs before it looks at the store directory', async () => {
    const { app, sessions, other } = appOn(join(root, 'data'));
    mkdirSync(sessions.getStorePath(other.id), { recursive: true });
    let finish!: () => void;
    const work = trackOperatorWork(app, '/checkout', new Promise<void>((done) => { finish = done; }));

    const result = handleCommand(`/session switch ${other.id}`, app);

    expect(result.lines.map((line) => line.text)).toEqual([
      "/checkout is still running, so the switch isn't started; try again once it has finished.",
    ]);
    finish();
    await work;
  });

  test('/session new after a refused switch switches to a new session', () => {
    const { app, sessions, other } = appOn(join(root, 'data'));
    mkdirSync(sessions.getStorePath(other.id), { recursive: true });
    expect(handleCommand(`/session switch ${other.id}`, app).refused).toBe(true);

    const result = handleCommand('/session new Fresh', app);

    const fresh = sessions.findSession('Fresh');
    expect(result.switchToSessionId).toBe(fresh!.id);
    expect(existsSync(sessions.getStorePath(fresh!.id))).toBe(false);
  });

  test("to a session whose store holds a MANIFEST switches, and doesn't open its store first", () => {
    const { app, sessions, other } = appOn(join(root, 'data'));
    makeRealStore(sessions.getStorePath(other.id));
    const opening = spyOn(JsStore, 'open');
    try {
      expect(handleCommand(`/session switch ${other.id}`, app).switchToSessionId).toBe(other.id);
      expect(opening).not.toHaveBeenCalled();
    } finally {
      opening.mockRestore();
    }
  });

  test('to a directory with no MANIFEST that Chronicle opens all the same switches, and closes what it opened', () => {
    const { app, sessions, other } = appOn(join(root, 'data'));
    const dir = sessions.getStorePath(other.id);
    mkdirSync(dir, { recursive: true });
    let closed = 0;
    const opening = spyOn(JsStore, 'open').mockImplementation(() => ({ close: () => { closed += 1; } }) as unknown as JsStore);
    try {
      expect(handleCommand(`/session switch ${other.id}`, app).switchToSessionId).toBe(other.id);
      expect(opening.mock.calls.map(([config]) => config.path)).toEqual([dir]);
      expect(closed).toBe(1);
    } finally {
      opening.mockRestore();
    }
  });
});

describe('scripts/warmup-session.ts', () => {
  async function warmup(data: string, id: string): Promise<{ exitCode: number; stderr: string }> {
    const child = Bun.spawn([process.execPath, '--no-env-file', WARMUP, id, '--data-dir', data, '--agent', 'agent'], {
      cwd: root,
      env: { ...process.env, ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' },
      stdin: 'ignore', stdout: 'ignore', stderr: 'pipe', timeout: 60_000,
    });
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    return { exitCode, stderr };
  }

  test('on a session whose store directory is empty, or absent, makes no store and says why, with no stack', async () => {
    const data = join(root, 'data');
    const sessions = new SessionManager(data);
    const absent = sessions.createSession('Absent');
    const empty = sessions.createSession('Empty');
    const emptyDir = sessions.getStorePath(empty.id);
    mkdirSync(emptyDir);
    const absentDir = sessions.getStorePath(absent.id);

    for (const [session, dir] of [[empty, emptyDir], [absent, absentDir]] as const) {
      const reason = chronicleReason(dir);
      const { exitCode, stderr } = await warmup(data, session.id);
      const lines = stderr.trimEnd().split('\n');
      expect(lines.at(-1)).toBe(
        `No store opened at ${dir}: ${reason}. Warmup makes no store: it works on the store that an import or a host made.`,
      );
      expect(lines.filter((line) => /^\s+at /.test(line))).toEqual([]);
      expect(exitCode).toBe(1);
    }
    expect(contents(emptyDir)).toEqual([]);
    expect(existsSync(absentDir)).toBe(false);
  }, 60_000);
});
