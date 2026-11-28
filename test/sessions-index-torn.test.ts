/**
 * The sessions index, <data>/sessions.json (#740): written whole, so a stop
 * mid-write leaves it as it was; and refused by name where it isn't JSON,
 * since a parse error's stack names no file.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../src/session-manager.js';
import { StartRefusal } from '../src/update/host.js';

const INDEX = join(import.meta.dir, '..', 'src', 'index.ts');
const RECIPE = {
  name: 'p',
  description: 'p',
  agent: { name: 'agent', provider: 'mock', systemPrompt: 'Never asked.' },
  modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false, webui: false },
};

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sessions-index-'));
  writeFileSync(join(root, 'recipe.json'), JSON.stringify(RECIPE));
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const words = (data: string, reason: string, size: string) =>
  `The sessions index, ${join(data, 'sessions.json')}, isn't the JSON the host wrote (${reason}; ${size}). Nothing was ` +
  `started; the index is as it was, and the sessions' stores are untouched in ${join(data, 'sessions')}. Restore the ` +
  'index from a backup (an update keeps one beside the data directory), or move it aside and start again: the host ' +
  'then begins a new session, and the sessions on disk stay unlisted until an index names them.';

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

const TORN: Array<[string, string]> = [
  ['empty', ''],
  ['cut mid-write', '{\n  "sessions": {\n    "abc": {\n      "id": "abc",\n'],
];
const sizeOf = (text: string) => (text.length === 0 ? 'the file is empty' : `${text.length} characters`);

describe('a torn sessions index', () => {
  for (const [kind, text] of TORN) {
    test(`load refuses one that is ${kind} by name, as a StartRefusal, and a start says that and nothing else, leaving the index as it was`, async () => {
      const data = join(root, 'data');
      mkdirSync(data);
      writeFileSync(join(data, 'sessions.json'), text);
      const sessions = new SessionManager(data);
      let reason = '';
      try { JSON.parse(text); } catch (error) { reason = (error as Error).message; }
      expect(reason).not.toBe('');
      let refusal: unknown;
      try { sessions.load(); } catch (error) { refusal = error; }
      expect(refusal).toBeInstanceOf(StartRefusal);
      expect((refusal as Error).message).toBe(words(data, reason, sizeOf(text)));

      const { exitCode, stderr, reachedSocket } = await start(data);

      expect(stderr).toBe(`${words(data, reason, sizeOf(text))}\n`);
      expect(exitCode).toBe(1);
      expect(reachedSocket).toBe(false);
      expect(readFileSync(join(data, 'sessions.json'), 'utf-8')).toBe(text);
      // The recipe's copy is written before the index is read, as before; no session, no temporary index.
      expect(readdirSync(data).filter((entry) => entry !== '.recipe.json').sort()).toEqual(['sessions.json']);
    }, 60_000);
  }
});

describe('the sessions index is written whole', () => {
  test('save leaves the index and nothing beside it, parseable, after each write', () => {
    const data = join(root, 'data');
    const sessions = new SessionManager(data);
    const first = sessions.createSession('First');
    const second = sessions.createSession('Second');
    sessions.setActiveSession(first.id);
    expect(readdirSync(data).filter((entry) => entry.startsWith('sessions.json'))).toEqual(['sessions.json']);
    const index = JSON.parse(readFileSync(join(data, 'sessions.json'), 'utf-8')) as { activeSessionId: string; sessions: Record<string, unknown> };
    expect(index.activeSessionId).toBe(first.id);
    expect(Object.keys(index.sessions).sort()).toEqual([first.id, second.id].sort());
  });
});
