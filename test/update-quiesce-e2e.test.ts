import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostModeStatus } from '@animalabs/agent-framework';
import { FleetModule } from '../src/modules/fleet-module.js';
import { isSwitchQuiesce } from '../src/update/contract.js';
import { type QuiesceFramework, quiesceForSwitch, resumeAfterSwitchQuiesce } from '../src/update/quiesce.js';
import { hostModeRecord } from './host-mode-record.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// agent-framework's quiesce waits at least a second, so the first reply below,
// 60 characters 150 ms apart, outlasts the first quiesce's wait.
const RECIPE = {
  name: 'Switch quiesce child',
  agent: {
    name: 'kid', provider: 'mock', systemPrompt: 'answers with the mock reply',
    mock: { echoMode: false, responseQueue: ['a'.repeat(60)], defaultResponse: 'b', streamChunkSize: 1, streamChunkDelayMs: 150 },
  },
  modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
};

const dirs: string[] = [];
const fleets: FleetModule[] = [];

afterAll(async () => {
  await Promise.all(fleets.map((fleet) => fleet.stop()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}, 30_000);

async function until(check: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(25);
  }
}

function idleHost(): QuiesceFramework {
  let quiesced = false;
  let reason: string | undefined;
  const status = (): HostModeStatus => ({
    quiesced, ...(reason !== undefined ? { reason } : {}), drained: true, activeTurns: 0, activeTurnAgents: [],
    parkedAdmissions: 0, gatedRequests: 0, backgroundScripts: 0, deferredWrites: 0,
  });
  return {
    quiesce: async (opts = {}) => { if (!quiesced) { quiesced = true; reason = opts.reason; } return status(); },
    resume: async () => { quiesced = false; reason = undefined; return status(); },
    getHostModeStatus: status,
  };
}

describe("the switch's quiesce of a real fleet child", () => {
  test('waits on its turn, says who holds it, answers a request it can\'t read with why, persists until the resume, and leaves the child serving', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'update-quiesce-e2e-'));
    dirs.push(dir);
    const recipe = join(dir, 'kid.json');
    writeFileSync(recipe, JSON.stringify(RECIPE));
    const dataDir = join(dir, 'kid');
    const fleet = new FleetModule({
      childIndexPath: join(REPO_ROOT, 'src', 'index.ts'),
      socketWaitTimeoutMs: 20_000, readyTimeoutMs: 20_000, gracefulShutdownMs: 5_000, sigtermEscalationMs: 2_000,
      autoStart: [{ name: 'kid', recipe, dataDir }],
    });
    fleets.push(fleet);
    await fleet.start({} as Parameters<FleetModule['start']>[0]);
    fleet.launchAutoStart();
    await until(() => fleet.getChildren().get('kid')?.status === 'ready', 30_000, 'the child is ready');

    const answers: Array<{ ok?: boolean; error?: string }> = [];
    const unsubscribe = fleet.onChildEvent('kid', (_name, event) => {
      if (event.type === 'update-response' && (event as { corrId?: string }).corrId === 'unreadable') answers.push(event as never);
    });
    (fleet as unknown as { sendToChild(child: unknown, command: unknown): void })
      .sendToChild(fleet.getChildren().get('kid'), { type: 'update-request', request: null, corrId: 'unreadable' });
    await until(() => answers.length > 0, 10_000, "the child answers a request it can't read");
    unsubscribe();
    expect(answers[0]!.ok).toBe(false);
    expect(answers[0]!.error).toContain('null');

    const seen: string[] = [];
    fleet.onChildEvent('kid', (_name, event) => {
      const { type, agentName } = event as { type?: string; agentName?: string };
      if (agentName === 'kid' && typeof type === 'string') seen.push(type);
    });
    await fleet.handleToolCall({ id: 'say', name: 'send', input: { name: 'kid', content: 'hello' } });
    await until(() => seen.includes('inference:tokens'), 20_000, 'the child streams its reply');

    const host = idleHost();
    const first = await quiesceForSwitch(host, fleet, { to: '9.9.9', timeoutMs: 300 });
    expect(first.drained).toBe(false);
    expect(first.hosts[0]).toMatchObject({ host: 'this host', answered: true, drained: true });
    expect(first.hosts[1]).toMatchObject({ host: 'kid', answered: true, drained: false, activeTurnAgents: ['kid'] });
    expect(seen).not.toContain('inference:completed');

    const second = await quiesceForSwitch(host, fleet, { to: '9.9.9', timeoutMs: 20_000 });
    expect(second.drained).toBe(true);
    expect(second.hosts[1]).toMatchObject({ host: 'kid', answered: true, drained: true, activeTurnAgents: [] });
    expect(seen).toContain('inference:completed');
    const quiesced = hostModeRecord(dataDir);
    expect(quiesced?.quiesced).toBe(true);
    expect(isSwitchQuiesce(quiesced?.reason)).toBe(true);

    const resumed = await resumeAfterSwitchQuiesce(host, fleet);
    expect(resumed.hosts[1]).toEqual({ host: 'kid', resumed: true });
    expect(hostModeRecord(dataDir)?.quiesced).toBe(false);
    const completed = seen.filter((type) => type === 'inference:completed').length;
    await fleet.handleToolCall({ id: 'again', name: 'send', input: { name: 'kid', content: 'again' } });
    await until(() => seen.filter((type) => type === 'inference:completed').length > completed, 20_000, 'the child takes its next turn');
  }, 120_000);
});
