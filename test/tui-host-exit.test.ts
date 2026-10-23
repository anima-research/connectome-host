/**
 * The host itself in TUI mode, on a pseudo-terminal, with the mock provider
 * and a loopback Web UI. Each way of quitting ends the process with code 0:
 * /quit; SIGTERM, which the Web UI's own quit sends (scheduleShutdown); SIGINT
 * and SIGHUP; and the terminal going away, its window or SSH session closed.
 * Closing Bun's terminal alone doesn't signal the host, so that case also
 * sends the SIGHUP a terminal's hangup brings. The Web UI's server outlives
 * framework.stop() and would keep the process running, so code 0 here also
 * says the TUI's stop settled and the host then closed the server. A recipe
 * without the Web UI quits the same way, with no server to close.
 *
 * The time limits only catch a hang, so they leave a loaded machine room.
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
        // At most one line, naming the terminal's first error. Whether the
        // closed terminal fails before the host has handled its SIGHUP is up
        // to Bun's close, so the line itself is tui-shutdown.test.ts's to
        // check.
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
