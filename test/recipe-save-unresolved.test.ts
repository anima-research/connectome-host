import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, chmodSync, symlinkSync, lstatSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  loadRecipe,
  loadRecipeDetailed,
  saveRecipe,
  loadSavedRecipe,
  SavedRecipeDirectoryError,
  savedRecipeDirectory,
  clearSavedRecipe,
  SAVED_RECIPE_UNRESOLVED_KEY,
} from '../src/recipe.js';

const SECRET = 'tok-glpat-supersecret-12345';

describe('unresolved recipe persistence', () => {
  const originalEnv = process.env;
  const originalFetch = globalThis.fetch;
  let tmpDir: string;
  let dataDir: string;
  let recipePath: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    tmpDir = mkdtempSync(join(tmpdir(), 'conhost-save-unresolved-'));
    dataDir = join(tmpDir, 'data');
    recipePath = join(tmpDir, 'recipe.json');
  });

  afterEach(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { }
  });

  function writeSecretRecipe(): void {
    writeFileSync(recipePath, JSON.stringify({
      name: 'Secret Test',
      agent: { systemPrompt: 'be helpful' },
      mcpServers: {
        gitlab: {
          command: 'node',
          env: { GITLAB_PERSONAL_ACCESS_TOKEN: '${CONHOST_TEST_SECRET}' },
        },
      },
    }), 'utf-8');
  }

  test('resolved recipe carries the secret in memory; persistable keeps the ${VAR} literal', async () => {
    process.env.CONHOST_TEST_SECRET = SECRET;
    writeSecretRecipe();

    const { recipe, persistable } = await loadRecipeDetailed(recipePath);
    expect((recipe.mcpServers as any).gitlab.env.GITLAB_PERSONAL_ACCESS_TOKEN).toBe(SECRET);
    expect((persistable.mcpServers as any).gitlab.env.GITLAB_PERSONAL_ACCESS_TOKEN)
      .toBe('${CONHOST_TEST_SECRET}');
  });

  test('the saved .recipe.json never contains the substituted secret', async () => {
    process.env.CONHOST_TEST_SECRET = SECRET;
    writeSecretRecipe();

    const { persistable } = await loadRecipeDetailed(recipePath);
    saveRecipe(dataDir, persistable);

    const onDisk = readFileSync(join(dataDir, '.recipe.json'), 'utf-8');
    expect(onDisk).not.toContain(SECRET);
    expect(onDisk).toContain('${CONHOST_TEST_SECRET}');
    expect(JSON.parse(onDisk)[SAVED_RECIPE_UNRESOLVED_KEY]).toBe(true);
  });

  test('loadSavedRecipe re-resolves against the CURRENT environment (secret rotation)', async () => {
    process.env.CONHOST_TEST_SECRET = SECRET;
    writeSecretRecipe();
    const { persistable } = await loadRecipeDetailed(recipePath);
    saveRecipe(dataDir, persistable);

    process.env.CONHOST_TEST_SECRET = 'tok-rotated-67890';
    const resumed = await loadSavedRecipe(dataDir);
    expect(resumed).not.toBeNull();
    expect((resumed!.mcpServers as any).gitlab.env.GITLAB_PERSONAL_ACCESS_TOKEN)
      .toBe('tok-rotated-67890');
  });

  test('loadSavedRecipe throws (not null) when a required var disappeared from the environment', async () => {
    process.env.CONHOST_TEST_SECRET = SECRET;
    writeSecretRecipe();
    const { persistable } = await loadRecipeDetailed(recipePath);
    saveRecipe(dataDir, persistable);

    delete process.env.CONHOST_TEST_SECRET;
    await expect(loadSavedRecipe(dataDir)).rejects.toThrow(/CONHOST_TEST_SECRET/);
  });

  test('saveRecipe writes the snapshot with mode 0600, and chmods a pre-existing looser file', async () => {
    process.env.CONHOST_TEST_SECRET = SECRET;
    writeSecretRecipe();
    const { persistable } = await loadRecipeDetailed(recipePath);

    saveRecipe(dataDir, persistable);
    const path = join(dataDir, '.recipe.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);

    // writeFileSync's mode applies only when it creates the file.
    chmodSync(path, 0o644);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    saveRecipe(dataDir, persistable);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('round-trip with no ${} patterns is a faithful no-op resolution', async () => {
    writeFileSync(recipePath, JSON.stringify({
      name: 'Plain',
      description: 'no env refs',
      agent: { systemPrompt: 'hello', model: 'claude-opus-4-6' },
    }), 'utf-8');
    const { recipe, persistable } = await loadRecipeDetailed(recipePath);
    saveRecipe(dataDir, persistable);
    const resumed = await loadSavedRecipe(dataDir);
    expect(resumed).not.toBeNull();
    expect(resumed!.name).toBe('Plain');
    expect(resumed!.agent.systemPrompt).toBe(recipe.agent.systemPrompt);
    expect(resumed!.agent.model).toBe('claude-opus-4-6');
  });

  test('relative fleet child recipe paths are persisted absolute (resume has no source base)', async () => {
    writeFileSync(recipePath, JSON.stringify({
      name: 'Fleet Parent',
      agent: { systemPrompt: 'parent' },
      modules: {
        fleet: { children: [{ name: 'child-a', recipe: 'child.json' }] },
      },
    }), 'utf-8');

    const { recipe, persistable } = await loadRecipeDetailed(recipePath);
    const expected = resolve(tmpDir, 'child.json');
    expect((recipe.modules!.fleet as any).children[0].recipe).toBe(expected);
    expect(((persistable.modules as any).fleet.children[0]).recipe).toBe(expected);

    saveRecipe(dataDir, persistable);
    const resumed = await loadSavedRecipe(dataDir);
    expect((resumed!.modules!.fleet as any).children[0].recipe).toBe(expected);
  });

  describe('URL systemPrompt', () => {
    test('persisted as the URL and re-fetched on resume, picking up prompt updates', async () => {
      let fetchCount = 0;
      globalThis.fetch = (async (input: any) => {
        expect(String(input)).toBe('https://prompts.example/agent.txt');
        fetchCount++;
        return new Response(fetchCount === 1 ? 'FETCHED PROMPT v1' : 'FETCHED PROMPT v2');
      }) as typeof fetch;

      writeFileSync(recipePath, JSON.stringify({
        name: 'URL Prompt',
        agent: { systemPrompt: 'https://prompts.example/agent.txt' },
      }), 'utf-8');

      const { recipe, persistable } = await loadRecipeDetailed(recipePath);
      expect(recipe.agent.systemPrompt).toBe('FETCHED PROMPT v1');
      expect((persistable.agent as any).systemPrompt).toBe('https://prompts.example/agent.txt');

      saveRecipe(dataDir, persistable);
      const onDisk = readFileSync(join(dataDir, '.recipe.json'), 'utf-8');
      expect(onDisk).not.toContain('FETCHED PROMPT');

      const resumed = await loadSavedRecipe(dataDir);
      expect(resumed!.agent.systemPrompt).toBe('FETCHED PROMPT v2');
      expect(fetchCount).toBe(2);
    });
  });

  describe('legacy resolved snapshots (no marker)', () => {
    test('load verbatim with no substitution', async () => {
      const legacy = {
        name: 'Legacy',
        agent: { systemPrompt: 'resolved prompt' },
        mcpServers: { gitlab: { command: 'node', env: { TOKEN: SECRET } } },
      };
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, '.recipe.json'), JSON.stringify(legacy, null, 2) + '\n', 'utf-8');

      const resumed = await loadSavedRecipe(dataDir);
      expect(resumed).not.toBeNull();
      expect((resumed!.mcpServers as any).gitlab.env.TOKEN).toBe(SECRET);
    });

    test('a surviving literal ${...} in prose does not hard-fail the load', async () => {
      delete process.env.DEFINITELY_NOT_SET_ANYWHERE;
      const legacy = {
        name: 'Legacy Prose',
        agent: {
          systemPrompt: 'To configure, set ${DEFINITELY_NOT_SET_ANYWHERE} in your .env file.',
        },
      };
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, '.recipe.json'), JSON.stringify(legacy) + '\n', 'utf-8');

      const resumed = await loadSavedRecipe(dataDir);
      expect(resumed).not.toBeNull();
      expect(resumed!.agent.systemPrompt).toContain('${DEFINITELY_NOT_SET_ANYWHERE}');
    });

    test('one that no longer validates throws, naming why, rather than resuming the default recipe', async () => {
      const legacy = {
        name: 'Legacy Mounts',
        agent: { systemPrompt: 'resolved prompt' },
        modules: { workspace: { mounts: [{ name: 'notes', path: './notes', readOnly: true }] } },
      };
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, '.recipe.json'), JSON.stringify(legacy) + '\n', 'utf-8');
      await expect(loadSavedRecipe(dataDir)).rejects.toThrow(/workspace\.mounts\[0\] has unknown key "readOnly"/);
    });

    test('missing snapshot returns null', async () => {
      expect(await loadSavedRecipe(dataDir)).toBeNull();
    });
  });

  describe('a saved recipe that can\'t be used', () => {
    test('a file that is there but is not a JSON object throws, saying what it holds', async () => {
      const cases: Array<[string, RegExp]> = [
        // JSON.parse's message can quote the text.
        ['', /^it isn't JSON$/],
        ['{"name": "Torn", "agent', /^it isn't JSON$/],
        ['{not json', /^it isn't JSON$/],
        ['{"apiKey": sk_live_abc}', /^it isn't JSON$/],
        ['[]', /^it holds an array, not a JSON object$/],
        ['5', /^it holds a number, not a JSON object$/],
        ['null', /^it holds null, not a JSON object$/],
        ['"x"', /^it holds a string, not a JSON object$/],
      ];
      mkdirSync(dataDir, { recursive: true });
      for (const [text, message] of cases) {
        writeFileSync(join(dataDir, '.recipe.json'), text, 'utf-8');
        await expect(loadSavedRecipe(dataDir)).rejects.toThrow(message);
      }
    });

    test("an entry at the path that can't be read throws, saying what's there or why, where only nothing there is no saved recipe", async () => {
      const path = join(dataDir, '.recipe.json');
      mkdirSync(dataDir, { recursive: true });
      mkdirSync(path);
      await expect(loadSavedRecipe(dataDir)).rejects.toThrow(/^it's a directory$/);
      await expect(loadSavedRecipe(dataDir)).rejects.toBeInstanceOf(SavedRecipeDirectoryError);
      rmSync(path, { recursive: true });
      const elsewhere = join(dataDir, 'elsewhere');
      mkdirSync(elsewhere);
      symlinkSync(elsewhere, path);
      await expect(loadSavedRecipe(dataDir)).rejects.toThrow(/^it's a link to a directory$/);
      await expect(loadSavedRecipe(dataDir)).rejects.toBeInstanceOf(SavedRecipeDirectoryError);
      rmSync(path);
      symlinkSync(join(dataDir, 'gone.json'), path);
      await expect(loadSavedRecipe(dataDir)).rejects.toThrow(/^it can't be read \(ENOENT\)$/);
      rmSync(path);
      symlinkSync(path, path);
      expect(savedRecipeDirectory(dataDir)).toBeNull();
      await expect(loadSavedRecipe(dataDir)).rejects.toThrow(/^it can't be read \(ELOOP\)$/);
      rmSync(path);
      expect(await loadSavedRecipe(dataDir)).toBeNull();
    });

    test.skipIf(process.getuid?.() === 0)("a directory at the path that its owner can't read is still a directory", async () => {
      const path = join(dataDir, '.recipe.json');
      mkdirSync(dataDir, { recursive: true });
      mkdirSync(path, { mode: 0o000 });
      try {
        await expect(loadSavedRecipe(dataDir)).rejects.toThrow(/^it's a directory$/);
        await expect(loadSavedRecipe(dataDir)).rejects.toBeInstanceOf(SavedRecipeDirectoryError);
      } finally {
        chmodSync(path, 0o700);
      }
    });

    test.skipIf(process.getuid?.() === 0)("a file at the path that its owner can't read throws, naming why", async () => {
      const path = join(dataDir, '.recipe.json');
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(path, '{}', 'utf-8');
      chmodSync(path, 0o000);
      try {
        await expect(loadSavedRecipe(dataDir)).rejects.toThrow(/^it can't be read \(EACCES\)$/);
      } finally {
        chmodSync(path, 0o600);
      }
    });

    test("clearSavedRecipe removes a file or a link at the path, one to nothing, to itself or to a directory included, never the link's target, and refuses a directory", () => {
      const path = join(dataDir, '.recipe.json');
      const gone = () => lstatSync(path, { throwIfNoEntry: false }) === undefined;
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(path, '{}', 'utf-8');
      clearSavedRecipe(dataDir);
      expect(gone()).toBe(true);
      symlinkSync(join(dataDir, 'gone.json'), path);
      clearSavedRecipe(dataDir);
      expect(gone()).toBe(true);
      symlinkSync(path, path);
      clearSavedRecipe(dataDir);
      expect(gone()).toBe(true);
      const target = join(dataDir, 'kept.json');
      writeFileSync(target, '{}', 'utf-8');
      symlinkSync(target, path);
      clearSavedRecipe(dataDir);
      expect(gone()).toBe(true);
      expect(existsSync(target)).toBe(true);
      const targetDir = join(dataDir, 'kept-dir');
      mkdirSync(targetDir);
      symlinkSync(targetDir, path);
      clearSavedRecipe(dataDir);
      expect(gone()).toBe(true);
      expect(lstatSync(targetDir).isDirectory()).toBe(true);
      clearSavedRecipe(dataDir);
      mkdirSync(path);
      expect(() => clearSavedRecipe(dataDir)).toThrow(/directory/);
      expect(lstatSync(path).isDirectory()).toBe(true);
    });

    test('a marker snapshot that no longer validates throws, as a legacy one does', async () => {
      const snapshot = {
        [SAVED_RECIPE_UNRESOLVED_KEY]: true,
        name: 'Marked Mounts',
        agent: { systemPrompt: 'be helpful' },
        modules: { workspace: { mounts: [{ name: 'notes', path: './notes', readOnly: true }] } },
      };
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, '.recipe.json'), JSON.stringify(snapshot) + '\n', 'utf-8');
      await expect(loadSavedRecipe(dataDir)).rejects.toThrow(/workspace\.mounts\[0\] has unknown key "readOnly"/);
    });
  });

  test('loadRecipe wrapper still returns the resolved recipe', async () => {
    process.env.CONHOST_TEST_SECRET = SECRET;
    writeSecretRecipe();
    const recipe = await loadRecipe(recipePath);
    expect((recipe.mcpServers as any).gitlab.env.GITLAB_PERSONAL_ACCESS_TOKEN).toBe(SECRET);
  });
});
