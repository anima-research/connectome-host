import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const LOCKED = { 'agent.proseRouting': 'locked' };
const START_LIMIT_MS = 30_000;

function recipe(extra: Record<string, unknown>): Record<string, unknown> {
  const base = JSON.parse(readFileSync('recipes/mock-test.json', 'utf-8')) as Record<string, unknown>;
  return {
    ...base,
    ...extra,
    agent: { ...(base.agent as object), mock: { echoMode: false, responseQueue: ['done'] } },
    modules: { ...(base.modules as object), webui: false },
  };
}

interface Request { readonly tools: readonly string[]; readonly messages: string }

function requestsIn(data: string): Request[] {
  const requests: Request[] = [];
  for (const name of readdirSync(data).filter((file) => file.startsWith('llm-calls'))) {
    for (const line of readFileSync(join(data, name), 'utf-8').split('\n')) {
      if (line.trim() === '') continue;
      const record: unknown = JSON.parse(line);
      if (typeof record !== 'object' || record === null || !('requestSummary' in record) || !('rawRequest' in record)) continue;
      const summary = record.requestSummary;
      const raw = record.rawRequest;
      const tools = typeof summary === 'object' && summary !== null && 'toolNames' in summary && Array.isArray(summary.toolNames)
        ? summary.toolNames.filter((tool): tool is string => typeof tool === 'string') : [];
      const messages = typeof raw === 'object' && raw !== null && 'messages' in raw ? JSON.stringify(raw.messages) : '';
      requests.push({ tools, messages });
    }
  }
  return requests;
}

async function start(dir: string, document: Record<string, unknown> | null, env: Record<string, string | undefined> = {}) {
  const path = join(dir, 'recipe.json');
  if (document !== null) writeFileSync(path, JSON.stringify(document));
  const data = join(dir, 'data');
  for (const name of existsSync(data) ? readdirSync(data) : []) if (name.startsWith('llm-calls')) rmSync(join(data, name));
  const childEnv: Record<string, string | undefined> = { ...process.env, DATA_DIR: data };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[name];
    else childEnv[name] = value;
  }
  const host = Bun.spawn(['bun', resolve('src/index.ts'), ...(document === null ? [] : [path])], {
    cwd: dir,
    env: childEnv,
    stdin: new TextEncoder().encode('hello\n'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => host.kill('SIGKILL'), START_LIMIT_MS);
  try {
    const [output, errors] = await Promise.all([new Response(host.stdout).text(), new Response(host.stderr).text()]);
    const code = await host.exited;
    return { code, output: `${output}\n${errors}`, requests: requestsIn(data), data };
  } finally {
    clearTimeout(timer);
    host.kill('SIGKILL');
    await host.exited;
  }
}

describe('a real host process', () => {
  test('a file is parked without the key, put back under a grant, and applied again when the saved recipe resumes (cases 1, 2, 14, 25)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'own-settings-host-'));
    try {
      mkdirSync(join(dir, 'data', 'own-settings'), { recursive: true });
      writeFileSync(join(dir, 'data', 'own-settings', 'own.json'), JSON.stringify(LOCKED));

      const without = await start(dir, recipe({}));
      expect(without.code, without.output).toBe(0);
      expect(readdirSync(join(without.data, 'own-settings'))).toEqual(['own.not-used.json']);
      expect(without.requests.some((request) => request.messages.includes('the host parks your settings file'))).toBe(true);
      expect(without.requests.some((request) => request.tools.includes('prose_locus'))).toBe(false);

      const granted = await start(dir, recipe({ ownSettings: ['agent.proseRouting'] }));
      expect(granted.code, granted.output).toBe(0);
      expect(readdirSync(join(granted.data, 'own-settings'))).toEqual(['own.json']);
      expect(granted.output).toContain('[own-settings] agent.proseRouting is "locked" from the resident\'s file; the recipe sets none.');
      expect(granted.requests.some((request) => request.messages.includes('the host puts your parked settings file back'))).toBe(true);
      expect(granted.requests.some((request) => request.tools.includes('prose_locus'))).toBe(true);
      const saved = JSON.parse(readFileSync(join(granted.data, '.recipe.json'), 'utf-8')) as { agent: Record<string, unknown> };
      expect(saved.agent.proseRouting).toBeUndefined();

      const resumed = await start(dir, null);
      expect(resumed.code, resumed.output).toBe(0);
      expect(resumed.output).toContain('[own-settings] agent.proseRouting is "locked" from the resident\'s file; the recipe sets none.');
      expect(resumed.requests.some((request) => request.tools.includes('prose_locus'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test('a start that ends with an error moves nothing, and the next start moves the file and gives the note (cases 20, 30)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'own-settings-host-'));
    try {
      const own = join(dir, 'data', 'own-settings', 'own.json');
      mkdirSync(join(dir, 'data', 'own-settings'), { recursive: true });
      writeFileSync(own, JSON.stringify(LOCKED));
      const document = recipe({});
      const failed = await start(dir, { ...document, agent: { ...(document.agent as object), provider: 'anthropic' } }, {
        ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_OAUTH_CREDENTIALS_FILE: undefined,
      });
      expect(failed.code, failed.output).toBe(1);
      expect(failed.output).toContain('so the host parks');
      expect(readFileSync(own, 'utf-8')).toBe(JSON.stringify(LOCKED));
      expect(readdirSync(join(dir, 'data', 'own-settings'))).toEqual(['own.json']);

      const next = await start(dir, document);
      expect(next.code, next.output).toBe(0);
      expect(next.requests.some((request) => request.messages.includes('the host parks your settings file'))).toBe(true);
      expect(readdirSync(join(dir, 'data', 'own-settings'))).toEqual(['own.not-used.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
