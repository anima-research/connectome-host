import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// src/index.ts applies the file at its start and hands the result to the
// framework, and nothing short of running it shows that. The offline mock
// provider answers, and the host's request log shows what the agent was given:
// the tool `prose_locus` is offered only in the mode "locked".
const LOCKED = { 'agent.proseRouting': 'locked' };

function recipe(extra: Record<string, unknown>): Record<string, unknown> {
  const base = JSON.parse(readFileSync('recipes/mock-test.json', 'utf-8')) as Record<string, unknown>;
  return {
    ...base,
    ...extra,
    agent: { ...(base.agent as object), mock: { echoMode: false, responseQueue: ['done'] } },
    modules: { ...(base.modules as object), webui: false },
  };
}

async function start(dir: string, document: Record<string, unknown>, env: Record<string, string | undefined> = {}) {
  const path = join(dir, 'recipe.json');
  writeFileSync(path, JSON.stringify(document));
  const data = join(dir, 'data');
  for (const name of existsSync(data) ? readdirSync(data) : []) if (name.startsWith('llm-calls')) rmSync(join(data, name));
  const childEnv: Record<string, string | undefined> = { ...process.env, DATA_DIR: data };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[name];
    else childEnv[name] = value;
  }
  const host = Bun.spawn(['bun', resolve('src/index.ts'), path], {
    cwd: dir,
    env: childEnv,
    stdin: new TextEncoder().encode('hello\n'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [output, errors] = await Promise.all([new Response(host.stdout).text(), new Response(host.stderr).text()]);
  const code = await host.exited;
  const requests = readdirSync(data).filter((name) => name.startsWith('llm-calls'))
    .map((name) => readFileSync(join(data, name), 'utf-8')).join('\n');
  return { code, output: `${output}\n${errors}`, requests, data };
}

describe('a real host process', () => {
  test('without the key a file is parked, and the next start under a grant puts it back and runs with it (cases 1, 2, 14, 25)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'own-settings-host-'));
    try {
      mkdirSync(join(dir, 'data', 'own-settings'), { recursive: true });
      writeFileSync(join(dir, 'data', 'own-settings', 'own.json'), JSON.stringify(LOCKED));

      const without = await start(dir, recipe({}));
      expect(without.code, without.output).toBe(0);
      expect(readdirSync(join(without.data, 'own-settings'))).toEqual(['own.not-used.json']);
      expect(without.requests).toContain('so the host parked your settings file');
      expect(without.requests).not.toContain('prose_locus');

      const granted = await start(dir, recipe({ ownSettings: ['agent.proseRouting'] }));
      expect(granted.code, granted.output).toBe(0);
      expect(readdirSync(join(granted.data, 'own-settings'))).toEqual(['own.json']);
      expect(granted.output).toContain('[own-settings] agent.proseRouting is "locked" from the resident\'s file; the recipe sets none.');
      expect(granted.requests).toContain('so the host put your parked settings file back');
      expect(granted.requests).toContain('prose_locus');
      const saved = JSON.parse(readFileSync(join(granted.data, '.recipe.json'), 'utf-8')) as { agent: Record<string, unknown> };
      expect(saved.agent.proseRouting).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test('a start that ends with an error leaves the file as it was (case 20)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'own-settings-host-'));
    try {
      const own = join(dir, 'data', 'own-settings', 'own.json');
      mkdirSync(join(dir, 'data', 'own-settings'), { recursive: true });
      writeFileSync(own, JSON.stringify(LOCKED));
      const document = recipe({ ownSettings: 'all' });
      const failed = await start(dir, { ...document, agent: { ...(document.agent as object), provider: 'anthropic' } }, {
        ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_OAUTH_CREDENTIALS_FILE: undefined,
      });
      expect(failed.code, failed.output).toBe(1);
      expect(failed.output).toContain('[own-settings] agent.proseRouting is "locked" from the resident\'s file');
      expect(readFileSync(own, 'utf-8')).toBe(JSON.stringify(LOCKED));
      expect(readdirSync(join(dir, 'data', 'own-settings'))).toEqual(['own.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
