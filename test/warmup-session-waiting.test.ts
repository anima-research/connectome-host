import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContextManager } from '@animalabs/context-manager';
import { AutobiographicalStrategy } from '@animalabs/agent-framework';
import { SessionManager } from '../src/session-manager.js';

const script = fileURLToPath(new URL('../scripts/warmup-session.ts', import.meta.url));
const root = resolve(dirname(script), '..');

const prose = (n: number, chars: number) => `Part ${n}. ` + 'The reading goes on through the long afternoon. '.repeat(Math.ceil(chars / 48)).slice(0, chars);

async function runWarmup(options: { toolCalls: boolean; model?: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'warmup-waiting-'));
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const sessions = new SessionManager(dir);
    const session = sessions.createSession('reader');
    const strategy = new AutobiographicalStrategy({ compressionModel: 'claude-sonnet-4-5-20250929', autoTickOnNewMessage: false });
    const cm = await ContextManager.open({ path: sessions.getStorePath(session.id), strategy, namespace: 'agents/Claude' });
    for (let n = 1; n <= 80; n++) {
      cm.addMessage('User', [{ type: 'text', text: prose(n, 2000) }]);
      if (options.toolCalls) {
        cm.addMessage('Claude', [{ type: 'tool_use', id: `t${n}`, name: 'read_file', input: { path: 'notes.md' } }]);
        cm.addMessage('User', [{ type: 'tool_result', toolUseId: `t${n}`, content: prose(n, 2000) }]);
      }
      cm.addMessage('Claude', [{ type: 'text', text: prose(n, 2000) }]);
    }
    cm.close();

    const child = Bun.spawn([
      process.execPath, script, session.id, '--data-dir', dir, '--agent', 'Claude',
      ...(options.model ? ['--model', options.model] : []),
    ], {
      cwd: root, stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' },
    });
    proc = child;
    timer = setTimeout(() => child.kill(), 30_000);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { exitCode, output: stdout + stderr };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    proc?.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

function expectWaitingReport(output: string) {
  const waiting = output.match(/Not converged: (\d+) chunks? wait on the host's tool definitions\./);
  expect(waiting).not.toBeNull();
  const count = Number(waiting![1]);
  expect(count).toBeGreaterThan(0);
  expect(output).toContain('declares no tool definitions');
  expect(output).toContain('maintenanceIntervalMs');
  expect(output).toContain(`[waiting] L1 0/${count} (0.0%)`);
  expect(output).toContain(`${count} waiting on tool definitions`);
  expect(output).not.toContain('Converged.');
  expect(output).not.toContain('[done]');
}

describe('warmup-session with work that waits on the host', () => {
  test('history holding tool calls: says what waits and why, never "Converged.", and exits 0', async () => {
    const { exitCode, output } = await runWarmup({ toolCalls: true });
    expectWaitingReport(output);
    expect(exitCode).toBe(0);
  }, 60_000);

  test('a Fable-family compression model on history without tool calls: the same', async () => {
    const { exitCode, output } = await runWarmup({ toolCalls: false, model: 'claude-fable-5-1' });
    expectWaitingReport(output);
    expect(exitCode).toBe(0);
  }, 60_000);
});
