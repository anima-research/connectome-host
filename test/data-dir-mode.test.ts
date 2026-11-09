import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager } from '../src/session-manager.js';
import { saveState, writeRecipeOut } from '../scripts/evacuator.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'data-dir-mode-'));
  dirs.push(dir);
  return join(dir, 'data');
}

function underUmask022(fn: () => void): void {
  const umask = process.umask(0o022);
  try {
    fn();
  } finally {
    process.umask(umask);
  }
}

const modeOf = (path: string): number => lstatSync(path).mode & 0o777;
const EVACUATOR = fileURLToPath(new URL('../scripts/evacuator.ts', import.meta.url));

describe('a data directory a script makes before any host runs', () => {
  test("SessionManager's first session makes the data directory and its sessions directory for their owner alone", () => {
    const data = freshDataDir();
    underUmask022(() => new SessionManager(data).createSession('imported'));
    expect(modeOf(data)).toBe(0o700);
    expect(modeOf(join(data, 'sessions'))).toBe(0o700);
  });

  test("SessionManager's first save makes the data directory for its owner alone", () => {
    const data = freshDataDir();
    underUmask022(() => new SessionManager(data).save({ version: 1, activeSessionId: '', sessions: {} }));
    expect(modeOf(data)).toBe(0o700);
  });

  test("the evacuator's first saved state makes the data directory for its owner alone", () => {
    const data = freshDataDir();
    underUmask022(() => saveState(data, { model: 'claude-opus-4-1' }));
    expect(modeOf(data)).toBe(0o700);
  });

  test("the evacuator's recipe makes its directory for its owner alone", () => {
    const data = freshDataDir();
    underUmask022(() => writeRecipeOut(join(data, 'evacuated-recipe.json'), { agent: { name: 'Claude' } }));
    expect(modeOf(data)).toBe(0o700);
  });

  test("the evacuator's recipe file and saved state are readable by their owner alone after every write, each written as a new file", () => {
    const data = freshDataDir();
    const out = join(data, 'evacuated-recipe.json');
    const state = join(data, 'evacuator-state.json');
    underUmask022(() => {
      writeRecipeOut(out, { agent: { name: 'Claude' } });
      saveState(data, { model: 'claude-opus-4-1' });
    });
    expect(modeOf(out)).toBe(0o600);
    expect(modeOf(state)).toBe(0o600);
    chmodSync(out, 0o644);
    chmodSync(state, 0o644);
    const beside = `${state}.tmp`;
    writeFileSync(beside, 'a file beside it\n');
    const openedBefore = [openSync(out, 'r'), openSync(state, 'r')];
    try {
      underUmask022(() => {
        writeRecipeOut(out, { agent: { name: 'Rewritten' } });
        saveState(data, { model: 'claude-rewritten' });
      });
      expect(modeOf(out)).toBe(0o600);
      expect(modeOf(state)).toBe(0o600);
      expect(readFileSync(out, 'utf-8')).toContain('Rewritten');
      expect(readFileSync(state, 'utf-8')).toContain('claude-rewritten');
      const [recipeBefore, stateBefore] = openedBefore.map((fd) => readFileSync(fd, 'utf-8'));
      expect(recipeBefore).toContain('Claude');
      expect(recipeBefore).not.toContain('Rewritten');
      expect(stateBefore).toContain('claude-opus-4-1');
      expect(stateBefore).not.toContain('claude-rewritten');
      expect(readFileSync(beside, 'utf-8')).toBe('a file beside it\n');
      expect(readdirSync(data).sort()).toEqual(['evacuated-recipe.json', 'evacuator-state.json', 'evacuator-state.json.tmp']);
    } finally {
      for (const fd of openedBefore) closeSync(fd);
    }
  });

  test("a link at the evacuator's recipe path is replaced by the new file, and what it pointed at is left as it was", () => {
    const data = freshDataDir();
    mkdirSync(data);
    const shared = join(dirname(data), 'shared.json');
    writeFileSync(shared, 'shared\n');
    chmodSync(shared, 0o644);
    const out = join(data, 'evacuated-recipe.json');
    symlinkSync(shared, out);
    underUmask022(() => writeRecipeOut(out, { agent: { name: 'Claude' } }));
    expect(lstatSync(out).isFile()).toBe(true);
    expect(modeOf(out)).toBe(0o600);
    expect(JSON.parse(readFileSync(out, 'utf-8'))).toEqual({ agent: { name: 'Claude' } });
    expect(readFileSync(shared, 'utf-8')).toBe('shared\n');
    expect(modeOf(shared)).toBe(0o644);
  });

  test("a recipe write that fails leaves nothing beside the evacuator's recipe path", () => {
    const data = freshDataDir();
    const out = join(data, 'evacuated-recipe.json');
    mkdirSync(out, { recursive: true });
    expect(() => underUmask022(() => writeRecipeOut(out, { agent: { name: 'Claude' } }))).toThrow();
    expect(readdirSync(data)).toEqual(['evacuated-recipe.json']);
    expect(readdirSync(out)).toEqual([]);
  });

  test('the copy the evacuator opens in an editor is readable by its owner alone, and removed when the editor fails', () => {
    const root = dirname(freshDataDir());
    const tmp = join(root, 'tmp');
    mkdirSync(tmp);
    const editor = join(root, 'editor.sh');
    const modeFile = join(root, 'mode');
    const pathFile = join(root, 'path');
    writeFileSync(editor, `#!/bin/sh\nprintf '%s' "$1" > '${pathFile}'\nTARGET="$1" bun -e 'const fs = require("node:fs"); fs.writeFileSync("${modeFile}", (fs.statSync(process.env.TARGET).mode & 0o7777).toString(8))'\nexit 1\n`, { mode: 0o755 });
    let child: ReturnType<typeof spawnSync> | undefined;
    underUmask022(() => {
      child = spawnSync('bun', ['-e', `import { editInline } from ${JSON.stringify(EVACUATOR)}; editInline('the memories');`], {
        env: { ...process.env, EDITOR: editor, TMPDIR: tmp },
        encoding: 'utf-8',
        timeout: 50_000,
      });
    });
    expect(child?.status).toBe(1);
    expect(readFileSync(modeFile, 'utf-8')).toBe('600');
    expect(existsSync(readFileSync(pathFile, 'utf-8'))).toBe(false);
  });

  test("a legacy store's move into sessions makes the sessions directory for its owner alone", () => {
    const data = freshDataDir();
    mkdirSync(join(data, 'store'), { recursive: true });
    underUmask022(() => new SessionManager(data).migrateIfNeeded());
    expect(modeOf(join(data, 'sessions'))).toBe(0o700);
  });

  test('a script leaves a data directory that is already there its mode', () => {
    for (const make of [
      (data: string) => new SessionManager(data).createSession('imported'),
      (data: string) => new SessionManager(data).save({ version: 1, activeSessionId: '', sessions: {} }),
      (data: string) => saveState(data, { model: 'claude-opus-4-1' }),
      (data: string) => writeRecipeOut(join(data, 'evacuated-recipe.json'), { agent: { name: 'Claude' } }),
    ]) {
      const data = freshDataDir();
      mkdirSync(data, { mode: 0o755 });
      chmodSync(data, 0o755);
      underUmask022(() => make(data));
      expect(modeOf(data)).toBe(0o755);
    }
  });

  test("the Codex importer makes its instance directory and the rollout's copy's directory for their owner alone", () => {
    const out = freshDataDir();
    const rollout = join(dirname(out), 'rollout-test.jsonl');
    writeFileSync(rollout, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'hello' } }) + '\n');
    let run: ReturnType<typeof spawnSync> | undefined;
    underUmask022(() => {
      run = spawnSync('bun', [join(import.meta.dir, '..', 'scripts', 'import-codex-rollout.ts'), rollout, '--out', out], { encoding: 'utf-8', timeout: 50_000 });
    });
    if (run!.status !== 0) throw new Error(`the import exited ${run!.status}: ${run!.stderr}`);
    expect(modeOf(out)).toBe(0o700);
    expect(modeOf(join(out, 'source'))).toBe(0o700);
    expect(modeOf(join(out, 'data'))).toBe(0o700);
  }, 60_000);
});
