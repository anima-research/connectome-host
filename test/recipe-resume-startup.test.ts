import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A session resumed with no recipe argument, whose saved recipe can't be
 * used, stops at startup naming the file and the ways out. Starting the
 * default recipe instead would put it in the resumed agent's place without a
 * word.
 */

const INDEX_PATH = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'src', 'index.ts');

// A whole host start, on a loaded machine.
const START_MS = 60_000;

/**
 * Start the host with `place` putting something at the saved recipe's path,
 * in a data directory it may also make one the host can't write.
 */
function start(place: (path: string) => void, args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'resume-startup-'));
  const dataDir = join(dir, 'data');
  try {
    mkdirSync(dataDir);
    const path = join(dataDir, '.recipe.json');
    place(path);
    // cwd=dir keeps the developer's own mcpl-servers.json out of the run.
    // Without the developer's credentials, a startup that ran the default
    // recipe instead would stop at once, at their check, rather than call the API.
    const noCredentials = { ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_OAUTH_CREDENTIALS_FILE: '' };
    // Inside the test's own budget, so a slow start fails here, with its output.
    const r = spawnSync(process.execPath, [INDEX_PATH, '--headless', ...args], {
      cwd: dir, env: { ...process.env, DATA_DIR: dataDir, ...noCredentials }, encoding: 'utf-8', timeout: START_MS - 5_000,
    });
    const entry = lstatSync(path, { throwIfNoEntry: false });
    return {
      status: r.status,
      stdout: r.stdout,
      stderr: r.stderr.replaceAll(dataDir, '<DATA_DIR>'),
      left: entry !== undefined,
      saved: entry?.isFile() ? readFileSync(path, 'utf-8') : undefined,
    };
  } finally {
    chmodSync(dataDir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
}

const startWithSaved = (text: string) => start((path) => writeFileSync(path, text));

/** The line for a directory at the saved recipe's path, whichever way startup met it. */
const directoryLine = 'Move or remove it, then start again: the host saves its recipe there as a file, so the source of a bind mount there has to be a file that exists before the container starts.';

// A refusal stops startup there. Without it, startup would go on to the
// default recipe, which stops at the credential check instead.
const NO_CREDENTIALS_STOP = 'Missing ANTHROPIC_API_KEY';

describe('startup with a saved recipe it can\'t use', () => {
  const remedy = 'Fix what it names (the file, or a variable missing from the environment), start with a recipe file to replace it, or start with --no-recipe to clear it.';

  test('a torn file stops startup, naming the file and the ways out', () => {
    const r = startWithSaved('{"name": "Torn", "agent');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Failed to resume the saved recipe <DATA_DIR>/.recipe.json: it isn't JSON\n");
    expect(r.stderr).toContain(remedy);
    expect(r.stderr).not.toContain(NO_CREDENTIALS_STOP);
  }, START_MS);

  test('one that no longer validates stops startup the same way', () => {
    const r = startWithSaved(JSON.stringify({
      name: 'Resumed', agent: { systemPrompt: 'x' },
      modules: { workspace: { mounts: [{ name: 'notes', path: './notes', readOnly: true }] } },
    }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Failed to resume the saved recipe <DATA_DIR>/.recipe.json: workspace.mounts[0] has unknown key "readOnly"');
    expect(r.stderr).toContain(remedy);
    expect(r.stderr).not.toContain(NO_CREDENTIALS_STOP);
  }, START_MS);

  // A recipe file can't be written over a directory, and --no-recipe leaves
  // one, so the error gives the fix that works instead of those.
  test('a directory at the path stops startup, saying to move or remove it', () => {
    const r = start((path) => mkdirSync(path));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Failed to resume the saved recipe <DATA_DIR>/.recipe.json: it's a directory\n");
    expect(r.stderr).toContain(directoryLine);
    expect(r.stderr).not.toContain(remedy);
    expect(r.stderr).not.toContain(NO_CREDENTIALS_STOP);
    expect(r.left).toBe(true);
  }, START_MS);
});

describe('--no-recipe, the way out it names', () => {
  test('clears a link to nothing at the path and takes the default recipe', () => {
    const r = start((path) => symlinkSync(join(dirname(path), 'gone.json'), path), ['--no-recipe']);
    expect(r.stdout).toContain('Starting with default recipe.');
    expect(r.left).toBe(false);
  }, START_MS);

  test('leaves a directory at the path, which was never a saved recipe, and stops, saying to move or remove it', () => {
    const r = start((path) => mkdirSync(path), ['--no-recipe']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Failed to clear the saved recipe <DATA_DIR>/.recipe.json: it's a directory\n");
    expect(r.stderr).toContain(directoryLine);
    expect(r.stdout).not.toContain('Starting with default recipe.');
    expect(r.left).toBe(true);
  }, START_MS);

  // Root writes any directory, so this case needs another user. A link to a
  // directory is removed like any link, so where removing it fails, that
  // failure is the cause, and the directory's line would send the operator
  // to a fix that fails the same way.
  test.skipIf(process.getuid?.() === 0)("stops with the clear's own error where the link to a directory there can't be removed", () => {
    const r = start((path) => {
      mkdirSync(join(dirname(path), 'target'));
      symlinkSync(join(dirname(path), 'target'), path);
      chmodSync(dirname(path), 0o555);
    }, ['--no-recipe']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Failed to clear the saved recipe <DATA_DIR>\/\.recipe\.json: .*EACCES/);
    expect(r.stderr).not.toContain('a link to a directory');
    expect(r.stderr).not.toContain(directoryLine);
    expect(r.stdout).not.toContain('Starting with default recipe.');
    expect(r.left).toBe(true);
  }, START_MS);
});

describe('a recipe file, the other way out', () => {
  /** A recipe file outside the data directory, valid on its own. */
  function recipeFile(): { path: string; done: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'resume-recipe-'));
    const path = join(dir, 'fresh.json');
    writeFileSync(path, JSON.stringify({ name: 'Fresh', agent: { systemPrompt: 'x' } }));
    return { path, done: () => rmSync(dir, { recursive: true, force: true }) };
  }

  test('replaces a torn saved recipe with the one it loads', () => {
    const file = recipeFile();
    try {
      const r = start((path) => writeFileSync(path, '{"name": "Torn", "agent'), [file.path]);
      expect(r.stdout).toContain('Loaded recipe: Fresh');
      expect(JSON.parse(r.saved ?? 'null')?.name).toBe('Fresh');
    } finally {
      file.done();
    }
  }, START_MS);

  test('stops at a directory at the path with the save\'s own error and the directory\'s line, not blaming the recipe file', () => {
    const file = recipeFile();
    try {
      const r = start((path) => mkdirSync(path), [file.path]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("Failed to save the recipe to <DATA_DIR>/.recipe.json: it's a directory\n");
      expect(r.stderr).toContain(directoryLine);
      expect(r.stderr).not.toContain('Failed to load recipe');
      expect(r.stderr).not.toContain(NO_CREDENTIALS_STOP);
      expect(r.left).toBe(true);
    } finally {
      file.done();
    }
  }, START_MS);

  test('stops at a link to a directory at the path the same way, naming the link', () => {
    const file = recipeFile();
    try {
      const r = start((path) => {
        mkdirSync(join(dirname(path), 'target'));
        symlinkSync(join(dirname(path), 'target'), path);
      }, [file.path]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("Failed to save the recipe to <DATA_DIR>/.recipe.json: it's a link to a directory\n");
      expect(r.stderr).toContain(directoryLine);
      expect(r.stderr).not.toContain(NO_CREDENTIALS_STOP);
      expect(r.left).toBe(true);
    } finally {
      file.done();
    }
  }, START_MS);

  test('one that fails to load stops startup with its own error, and nothing is saved', () => {
    const r = start((path) => writeFileSync(path, JSON.stringify({ name: 'Kept', agent: { systemPrompt: 'x' } })), [join(tmpdir(), 'no-such-recipe-file.json')]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Failed to load recipe from ');
    expect(r.stderr).not.toContain('Failed to save the recipe');
    expect(r.stderr).not.toContain(NO_CREDENTIALS_STOP);
    expect(JSON.parse(r.saved ?? 'null')?.name).toBe('Kept');
  }, START_MS);
});
