import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { connectWhenAccepting } from './ipc-connect.js';

const INDEX = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const MCP_CHILD = fileURLToPath(new URL('./fixtures/placed-reaction-child.cjs', import.meta.url));
const SETUP_ERROR = 'injected post-create setup failure';
const STOP_ERROR = 'injected replacement stop failure';

const EXTENSION = `
import { writeFileSync } from 'node:fs';
let generation = 0;
export function register(api, { stopped, stopFails }) {
  api.registerModule(() => {
    const replacement = ++generation === 2;
    return {
      name: 'switch-failure-probe',
      getTools() { return []; },
      async start() {},
      async handleToolCall() { return { success: false, error: 'no tools' }; },
      async onProcess() { return {}; },
      setFramework(framework) {
        if (!replacement) return;
        if (!framework.listMcplServers().some((server) => server.id === 'probe' && server.connected)) {
          throw new Error('test MCP server did not connect');
        }
        throw new Error(${JSON.stringify(SETUP_ERROR)});
      },
      async stop() {
        if (!replacement) return;
        writeFileSync(stopped, 'replacement stopped');
        if (stopFails) throw new Error(${JSON.stringify(STOP_ERROR)});
      },
    };
  });
}
`;

async function failedSwitch(socketPath: string): Promise<Record<string, unknown>> {
  const socket = await connectWhenAccepting(socketPath, { timeoutMs: 10_000 });
  const lines = createInterface({ input: socket });
  const deadline = setTimeout(() => socket.destroy(), 10_000);
  try {
    socket.write(JSON.stringify({ type: 'command', command: '/session new replacement', corrId: 'switch' }) + '\n');
    for await (const line of lines) {
      const event = JSON.parse(line);
      if (event.type === 'command-done' && event.corrId === 'switch') return event;
    }
    throw new Error('No response to the session switch');
  } finally {
    clearTimeout(deadline);
    lines.close();
    socket.destroy();
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

for (const stopFails of [false, true]) {
  test(`a failed switch stops the created framework and reports the setup error${stopFails ? ' even when stop fails' : ''}`, async () => {
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
      extensions: { probe: { kind: 'module', path: extension, config: { stopped, stopFails } } },
    }));
    const host = Bun.spawn([process.execPath, INDEX, recipe, '--headless'], {
      cwd: dir, env: { ...process.env, DATA_DIR: dir }, stdout: 'ignore', stderr: 'pipe',
    });
    const stderr = host.stderr.text();
    try {
      expect(await failedSwitch(socketPath)).toHaveProperty('error', SETUP_ERROR);
      expect(readFileSync(stopped, 'utf8')).toBe('replacement stopped');
      const pids = readFileSync(pidsPath, 'utf8').trim().split('\n').map(Number);
      expect(pids).toHaveLength(2);
      // Check before killing the host: otherwise EOF alone can stop the MCP child.
      expect(isAlive(pids[1]!)).toBe(false);
      expect(host.exitCode).toBeNull();
    } finally {
      if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
      await host.exited;
      rmSync(dir, { recursive: true, force: true });
    }
    if (stopFails) {
      const log = await stderr;
      expect(log).toContain('stopping the framework after setup failed:');
      expect(log).toContain(STOP_ERROR);
    }
  }, 30_000);
}
