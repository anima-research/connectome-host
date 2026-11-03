/**
 * Closing a Bun.Terminal doesn't signal the process on it, so the terminal's
 * case also sends the SIGHUP a terminal's hangup brings.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const INDEX_PATH = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'src', 'index.ts');

function recipeFor(webui: boolean) {
  return {
    name: 'TUI host exit test',
    agent: { name: 'agent', provider: 'mock', systemPrompt: 'You are a mock agent for offline host testing.' },
    modules: {
      subagents: false, lessons: false, retrieval: false, wake: false, workspace: false,
      ...(webui ? { webui: { host: '127.0.0.1', port: 0 } } : {}),
    },
  };
}

async function until(ready: () => boolean, ms: number, what: string, screen: () => string): Promise<void> {
  const deadline = performance.now() + ms;
  while (!ready()) {
    if (performance.now() > deadline) throw new Error(`no ${what} within ${ms} ms; the terminal showed: ${screen().slice(-2000)}`);
    await Bun.sleep(25);
  }
}

const CASES = [
  ...(['/quit', 'SIGTERM', 'SIGINT', 'SIGHUP', 'its terminal going away'] as const).map(way => ({ way, webui: true })),
  { way: '/quit' as const, webui: false },
];

for (const { way, webui } of CASES) {
  test(`a TUI host ${webui ? 'with' : 'without'} the Web UI ends with code 0 after ${way}`, async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tui-host-exit-')));
    const recipe = join(dir, 'recipe.json');
    writeFileSync(recipe, JSON.stringify(recipeFor(webui)));
    let screen = '';
    const decoder = new TextDecoder();
    const terminal = new Bun.Terminal({
      cols: 120, rows: 40,
      data: (_terminal, data) => { screen += decoder.decode(data, { stream: true }); },
    });
    const host = Bun.spawn([process.execPath, INDEX_PATH, recipe], {
      cwd: dir, env: { ...process.env, DATA_DIR: dir, TERM: 'xterm-256color' }, terminal,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (webui) await until(() => screen.includes('[webui] listening on'), 30_000, 'Web UI', () => screen);
      await until(() => screen.includes('Type /help'), 30_000, 'TUI', () => screen);
      if (way === '/quit') terminal.write('/quit\r');
      else if (way === 'its terminal going away') { terminal.close(); host.kill('SIGHUP'); }
      else host.kill(way);
      const ended = await Promise.race([
        host.exited.then(() => true),
        new Promise<boolean>(done => { timer = setTimeout(() => done(false), 45_000); }),
      ]);
      expect({ ended, exitCode: host.exitCode, signalCode: host.signalCode }).toEqual({ ended: true, exitCode: 0, signalCode: null });
      if (way === 'its terminal going away') {
        // Whether the closed terminal fails before the host handles its SIGHUP is
        // up to Bun's close, so there is one such line or none.
        const failures = readFileSync(join(dir, 'tui-error.log'), 'utf8').split('\n').filter(l => l.startsWith('terminal failed'));
        expect(failures.length).toBeLessThanOrEqual(1);
        for (const line of failures) expect(line).toMatch(/^terminal failed \([^)]+\): stopping as \/quit does$/);
      }
    } finally {
      clearTimeout(timer);
      if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
      await host.exited;
      if (!terminal.closed) terminal.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 150_000);
}
