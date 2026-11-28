import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { connectWhenAccepting } from './ipc-connect.js';
import { waitForEnd } from './process-ended.js';

const INDEX = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const MCP_CHILD = fileURLToPath(new URL('./fixtures/placed-reaction-child.cjs', import.meta.url));
const SETUP_ERROR = 'injected post-create setup failure';
const STOP_ERROR = 'injected replacement stop failure';
const STOP_TIMEOUT = 'Shutdown timed out after 5000 ms; pending: module:switch-failure-probe';

const EXTENSION = `
import { writeFileSync } from 'node:fs';
let generation = 0;
export function register(api, { stopped, stop, shutdown, boot }) {
  api.registerModule(() => {
    const failsSetup = ++generation === (boot ? 1 : 2);
    return {
      name: 'switch-failure-probe',
      getTools() { return []; },
      async start() {},
      async handleToolCall() { return { success: false, error: 'no tools' }; },
      async onProcess() { return {}; },
      setFramework(framework) {
        if (!failsSetup) return;
        if (!framework.listMcplServers().some((server) => server.id === 'probe' && server.connected)) {
          throw new Error('test MCP server did not connect');
        }
        // Run the host's SIGTERM handler now, before make() can settle.
        if (shutdown) process.emit('SIGTERM');
        throw new Error(${JSON.stringify(SETUP_ERROR)});
      },
      async stop() {
        if (!failsSetup) return;
        writeFileSync(stopped, 'cleanup attempted');
        if (stop === 'reject') throw new Error(${JSON.stringify(STOP_ERROR)});
        if (stop === 'hang') {
          // Keep the boot process alive even if no handles survive teardown.
          setInterval(() => {}, 1_000);
          await new Promise(() => {});
        }
      },
    };
  });
}
`;

async function sessionCommand(socketPath: string, command: string) {
  const socket = await connectWhenAccepting(socketPath, { timeoutMs: 10_000 });
  const lines = createInterface({ input: socket });
  const deadline = setTimeout(() => socket.destroy(), 10_000);
  const output: string[] = [];
  try {
    socket.write(JSON.stringify({ type: 'command', command, corrId: 'switch' }) + '\n');
    for await (const line of lines) {
      const event = JSON.parse(line);
      if (event.corrId !== 'switch') continue;
      if (event.type === 'command-output') output.push(event.text);
      if (event.type === 'command-done') return { done: event as Record<string, unknown>, output };
    }
    throw new Error(`No response to ${command}`);
  } finally {
    clearTimeout(deadline);
    lines.close();
    socket.destroy();
  }
}

for (const [label, stop, shutdown, boot = false] of [
  ['a failed switch stops the created framework and reports the setup error', 'resolve', false],
  ['a failed switch reports the setup error even when stop fails', 'reject', false],
  ['shutdown during a failed switch exits 1 if stopping the created framework fails', 'reject', true],
  ['shutdown during a failed switch reports the setup error and exits 1 if cleanup hangs', 'hang', true],
  ['boot exits 1 with the setup error if cleanup hangs', 'hang', false, true],
] as const) {
  test(label, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'switch-make-'));
    const pidsPath = join(dir, 'mcp-pids');
    const stopped = join(dir, 'replacement-stopped');
    const recipe = join(dir, 'recipe.json');
    const extension = join(dir, 'probe.mjs');
    const socketPath = join(dir, 'ipc.sock');
    writeFileSync(extension, EXTENSION);
    writeFileSync(recipe, JSON.stringify({
      name: 'Failed switch test',
      agent: { name: 'agent', provider: 'mock', systemPrompt: 'This test does not infer.' },
      modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
      mcpServers: { probe: { command: process.execPath, args: [MCP_CHILD, pidsPath] } },
      extensions: { probe: { kind: 'module', path: extension, config: { stopped, stop, shutdown, boot } } },
    }));
    const host = Bun.spawn([process.execPath, INDEX, recipe, '--headless'], {
      cwd: dir, env: { ...process.env, DATA_DIR: dir }, stdout: 'ignore', stderr: 'pipe',
    });
    const stderr = host.stderr.text();
    try {
      if (boot) {
        expect(await waitForEnd(host.pid, 10_000)).toBe(true);
        expect(await host.exited).toBe(1);
        expect(await stderr).toMatch(new RegExp(`Fatal error:[\\s\\S]*[Ee]rror: ${SETUP_ERROR}`));
      } else {
        const { done } = await sessionCommand(socketPath, '/session new replacement');
        expect(done).toHaveProperty('error', SETUP_ERROR);
      }
      expect(readFileSync(stopped, 'utf8')).toBe('cleanup attempted');
      const pids = readFileSync(pidsPath, 'utf8').trim().split('\n').map(Number);
      expect(pids).toHaveLength(boot ? 1 : 2);
      if (shutdown) {
        expect(await waitForEnd(host.pid, 5_000)).toBe(true);
        expect(await host.exited).toBe(1);
      } else if (!boot) {
        // Check before killing the host: otherwise EOF alone can stop the MCP child.
        expect(await waitForEnd(pids[1]!, 5_000)).toBe(true);
        expect(host.exitCode).toBeNull();
        // The failed make left replacement marked active, so switch away first.
        for (const command of ['/session switch Session 1', '/session switch replacement']) {
          const { done, output } = await sessionCommand(socketPath, command);
          expect(done.error).toBeUndefined();
          expect(output).toContain('Session switched.');
        }
      }
    } finally {
      if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
      await host.exited;
      rmSync(dir, { recursive: true, force: true });
    }
    if (stop !== 'resolve') {
      const log = await stderr;
      expect(log).toContain('stopping the framework after setup failed:');
      expect(log).toContain(stop === 'hang' ? STOP_TIMEOUT : STOP_ERROR);
    }
  }, 30_000);
}
