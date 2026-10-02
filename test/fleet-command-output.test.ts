import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetModule } from '../src/modules/fleet-module.js';

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(20);
  }
}

test('command replies survive fleet narrowing and an empty direct-client subscription', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-command-output-'));
  const recipe = join(dir, 'recipe.json');
  writeFileSync(recipe, JSON.stringify({
    name: 'command-output-test',
    agent: { name: 'leaf', systemPrompt: 'Never asked to infer in this test.' },
    modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
  }));
  const fleet = new FleetModule({
    childIndexPath: new URL('../src/index.ts', import.meta.url).pathname,
    gracefulShutdownMs: 1_000,
    sigtermEscalationMs: 500,
  });
  try {
    // Recipe-only env keeps the fixture's dummy key out of the test runner's
    // environment. This calls the same launch path that autoStart uses.
    const launched = await (fleet as any).handleLaunch({
      name: 'leaf', recipe, dataDir: join(dir, 'data'),
      env: { ANTHROPIC_API_KEY: 'sk-offline-command-output-test' },
      subscription: ['lifecycle'],
    }, { viaAutoStart: true });
    expect(launched.success).toBe(true);
    const child = fleet.getChildren().get('leaf')!;
    const hasReply = (command: string) => child.events.some(
      event => event.type === 'command-output' && String(event.text).includes(command),
    );

    const sent = await fleet.handleToolCall({
      id: 'fleet-command', name: 'command', input: { name: 'leaf', command: '/unknown-fleet-response' },
    });
    expect(sent.success).toBe(true);
    await waitFor(() => hasReply('/unknown-fleet-response'), 'fleet command response');
    const peek = await fleet.handleToolCall({ id: 'peek', name: 'peek', input: { name: 'leaf' } });
    expect(peek.success).toBe(true);
    expect((peek.data as { events: Array<{ type: string; text?: string }> }).events.some(
      event => event.type === 'command-output' && event.text?.includes('/unknown-fleet-response'),
    )).toBe(true);

    // Bypass the parent's forced event floor, as a direct socket client can.
    // Subscribe is synchronous; dispatch processes it before the next line.
    child.socket!.write(JSON.stringify({ type: 'subscribe', events: [] }) + '\n');
    child.socket!.write(JSON.stringify({ type: 'command', command: '/unknown-direct-response' }) + '\n');
    await waitFor(() => hasReply('/unknown-direct-response'), 'empty-subscription response');

    // An empty filter still suppresses telemetry, including the exiting
    // lifecycle event. The process exit, rather than that event, ends stop().
    await fleet.stop();
    expect(child.events.some(event => event.type === 'lifecycle' && event.phase === 'exiting')).toBe(false);
    expect(child.process?.exitCode).toBe(0);
  } finally {
    await fleet.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
