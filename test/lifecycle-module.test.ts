import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModuleContext, ToolCall } from '@animalabs/agent-framework';
import { LifecycleModule } from '../src/modules/lifecycle-module.js';
import {
  SELF_RESTART_FILE,
  SELF_RESTART_LAST_FILE,
  SelfRestartState,
  type SelfRestartRequest,
} from '../src/self-restart.js';

const T0 = new Date('2026-10-20T12:00:00.000Z');

function setup(opts: { headless?: boolean; cooldownMinutes?: number; now?: () => Date; state?: SelfRestartState; dataDir?: string } = {}) {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'self-restart-'));
  const state = opts.state ?? new SelfRestartState('boot-a');
  if (opts.headless !== false) state.attachHeadless();
  const module = new LifecycleModule({
    dataDir,
    timeZone: 'UTC',
    state,
    now: opts.now ?? (() => T0),
    hostVersion: '9.9.9',
    ...(opts.cooldownMinutes !== undefined ? { cooldownMinutes: opts.cooldownMinutes } : {}),
  });
  const added: Array<{ participant: string; text: string }> = [];
  const ctx = {
    addMessage: (participant: string, content: Array<{ type: string; text?: string }>) => {
      added.push({ participant, text: content.map((c) => c.text ?? '').join('') });
      return 'msg-1';
    },
  } as unknown as ModuleContext;
  return { dataDir, state, module, ctx, added };
}

const call = (input: Record<string, unknown>, callerAgentName: string | null = 'main'): ToolCall =>
  ({ id: 'c1', name: 'restart', input, ...(callerAgentName === null ? {} : { callerAgentName }) } as ToolCall);
const marker = (dataDir: string) => JSON.parse(readFileSync(join(dataDir, SELF_RESTART_FILE), 'utf-8')) as SelfRestartRequest;

describe('LifecycleModule', () => {
  test('offers one tool, lifecycle--restart, whose schema requires nothing, so a cancel needs no reason', () => {
    // The framework refuses a call missing a required argument before the
    // module runs, so a required reason would refuse { cancel: true }.
    const { module } = setup();
    expect(module.name).toBe('lifecycle');
    const tools = module.getTools();
    expect(tools.map((t) => t.name)).toEqual(['restart']);
    expect((tools[0].inputSchema as { required?: string[] }).required).toBeUndefined();
  });

  test('refuses outside headless mode and arms nothing', async () => {
    const { module, dataDir, state } = setup({ headless: false });
    const result = await module.handleToolCall(call({ reason: 'pick up the new recipe' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('not running in headless mode');
    expect(state.isArmed()).toBe(false);
    expect(existsSync(join(dataDir, SELF_RESTART_FILE))).toBe(false);
  });

  test('requires a reason', async () => {
    const { module, state } = setup();
    for (const input of [{}, { reason: '' }, { reason: '   ' }, { reason: 42 }]) {
      const result = await module.handleToolCall(call(input));
      expect(result.success).toBe(false);
      expect(result.error).toContain('`reason` is required');
    }
    expect(state.isArmed()).toBe(false);
  });

  test('arms: writes the request, and the receipt says when and how it happens', async () => {
    const { module, dataDir, state } = setup();
    const result = await module.handleToolCall(call({ reason: '  pick up the new recipe ' }));
    expect(result.success).toBe(true);
    expect(String(result.data)).toContain('once this turn ends and nothing is in flight');
    expect(String(result.data)).toContain('exits with code 75');
    expect(String(result.data)).toContain('if nothing does, it stays down');
    expect(state.isArmed()).toBe(true);
    const m = marker(dataDir);
    expect(m).toMatchObject({ requestedAt: T0.toISOString(), reason: 'pick up the new recipe', requestedBy: 'main', pid: process.pid, bootId: 'boot-a', hostVersion: '9.9.9' });
    expect(m.exitedAt).toBeUndefined();
  });

  test('a second request while one is pending reports the pending one, naming who asked', async () => {
    const { module, dataDir } = setup();
    await module.handleToolCall(call({ reason: 'first' }));
    const again = await module.handleToolCall(call({ reason: 'second' }));
    expect(again.success).toBe(true);
    expect(String(again.data)).toContain('already pending, asked for by you');
    expect(String(again.data)).toContain('first');
    const other = await module.handleToolCall(call({ reason: 'third' }, 'helper'));
    expect(String(other.data)).toContain('asked for by main');
    expect(marker(dataDir).reason).toBe('first');
  });

  test('cancel disarms and removes the request; cancelling nothing says so', async () => {
    const { module, dataDir, state } = setup();
    const none = await module.handleToolCall(call({ cancel: true }));
    expect(none.success).toBe(true);
    expect(String(none.data)).toContain('nothing to cancel');
    await module.handleToolCall(call({ reason: 'pick up the new recipe' }));
    const cancelled = await module.handleToolCall(call({ cancel: true }));
    expect(cancelled.success).toBe(true);
    expect(String(cancelled.data)).toContain('Cancelled the restart you asked for');
    expect(state.isArmed()).toBe(false);
    expect(existsSync(join(dataDir, SELF_RESTART_FILE))).toBe(false);

    await module.handleToolCall(call({ reason: 'again' }));
    const byOther = await module.handleToolCall(call({ cancel: true }, 'helper'));
    expect(String(byOther.data)).toContain('Cancelled the restart main asked for');

    // A request whose file is already gone cancels all the same.
    await module.handleToolCall(call({ reason: 'once more' }));
    unlinkSync(join(dataDir, SELF_RESTART_FILE));
    const gone = await module.handleToolCall(call({ cancel: true }));
    expect(gone.success).toBe(true);
    expect(state.isArmed()).toBe(false);
  });

  test('a call that names no agent is recorded without one, and the texts say "an agent"', async () => {
    const before = setup({ state: new SelfRestartState('boot-a') });
    await before.module.handleToolCall(call({ reason: 'no name' }, null));
    expect(marker(before.dataDir).requestedBy).toBeUndefined();
    const pending = await before.module.handleToolCall(call({ reason: 'again' }));
    expect(String(pending.data)).toContain('asked for by an agent');
    before.state.recordExit('self-restart', 75, new Date('2026-10-20T12:00:20.000Z'));
    const after = setup({ dataDir: before.dataDir, state: new SelfRestartState('boot-b') });
    await after.module.start(after.ctx);
    expect(after.added[0].text).toContain('[self-restart] An agent asked for a host restart');
  });

  test('a cancel whose request file cannot be removed leaves the restart armed and says so', async () => {
    const { module, dataDir, state } = setup();
    await module.handleToolCall(call({ reason: 'pick up the new recipe' }));
    // A directory where the request was: unlink refuses it.
    unlinkSync(join(dataDir, SELF_RESTART_FILE));
    mkdirSync(join(dataDir, SELF_RESTART_FILE));
    const result = await module.handleToolCall(call({ cancel: true }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('still armed');
    expect(state.isArmed()).toBe(true);
  });

  test('cooldown: refuses within it, counted from the last restart\'s return, and allows after', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'self-restart-'));
    writeFileSync(join(dataDir, SELF_RESTART_LAST_FILE), JSON.stringify({
      requestedAt: '2026-10-20T11:49:00.000Z', reason: 'earlier', pid: 1, bootId: 'old',
      exitedAt: '2026-10-20T11:49:30.000Z', backAt: '2026-10-20T11:55:00.000Z', cleanExit: true,
    }));
    const early = setup({ dataDir, cooldownMinutes: 10 });
    const refused = await early.module.handleToolCall(call({ reason: 'again' }));
    expect(refused.success).toBe(false);
    expect(refused.error).toContain("the host's last self-restart came back");
    expect(refused.error).toContain('at least 10 minutes apart');
    expect(refused.error).toContain('2026-10-20T12:05:00');
    expect(early.state.isArmed()).toBe(false);

    const later = setup({ dataDir, cooldownMinutes: 10, now: () => new Date('2026-10-20T12:05:00.000Z') });
    expect((await later.module.handleToolCall(call({ reason: 'again' }))).success).toBe(true);

    const noCooldown = setup({ dataDir: mkdtempSync(join(tmpdir(), 'self-restart-')), cooldownMinutes: 0 });
    writeFileSync(join(noCooldown.dataDir, SELF_RESTART_LAST_FILE), JSON.stringify({ backAt: T0.toISOString() }));
    expect((await noCooldown.module.handleToolCall(call({ reason: 'again' }))).success).toBe(true);
  });

  test('after a clean restart: one context line, and the request moves to self-restart.last.json', async () => {
    const before = setup({ state: new SelfRestartState('boot-a') });
    await before.module.handleToolCall(call({ reason: 'pick up the new recipe' }));
    before.state.recordExit('self-restart', 75, new Date('2026-10-20T12:00:20.000Z'));

    const after = setup({ dataDir: before.dataDir, state: new SelfRestartState('boot-b'), now: () => new Date('2026-10-20T12:00:45.000Z') });
    await after.module.start(after.ctx);
    expect(after.added).toHaveLength(1);
    expect(after.added[0].participant).toBe('user');
    expect(after.added[0].text).toContain('[self-restart] main asked for a host restart at 2026-10-20T12:00:00');
    expect(after.added[0].text).toContain('pick up the new recipe');
    expect(after.added[0].text).toContain('the host stopped at 2026-10-20T12:00:20');
    expect(after.added[0].text).toContain('back at 2026-10-20T12:00:45');
    expect(existsSync(join(before.dataDir, SELF_RESTART_FILE))).toBe(false);
    const last = JSON.parse(readFileSync(join(before.dataDir, SELF_RESTART_LAST_FILE), 'utf-8'));
    expect(last).toMatchObject({ reason: 'pick up the new recipe', exitCode: 75, exitReason: 'self-restart', backAt: '2026-10-20T12:00:45.000Z', cleanExit: true });

    // A second start in the same process (a session switch) adds nothing.
    await after.module.start(after.ctx);
    expect(after.added).toHaveLength(1);
  });

  test('a request whose exit was never recorded says so; another shutdown first is named', async () => {
    const crashed = setup({ state: new SelfRestartState('boot-a') });
    await crashed.module.handleToolCall(call({ reason: 'wedged' }));
    const next = setup({ dataDir: crashed.dataDir, state: new SelfRestartState('boot-b') });
    await next.module.start(next.ctx);
    expect(next.added[0].text).toContain("exit wasn't recorded");
    expect(JSON.parse(readFileSync(join(crashed.dataDir, SELF_RESTART_LAST_FILE), 'utf-8')).cleanExit).toBe(false);

    const sigterm = setup({ state: new SelfRestartState('boot-c') });
    await sigterm.module.handleToolCall(call({ reason: 'wedged' }));
    sigterm.state.recordExit('SIGTERM', 0, new Date('2026-10-20T12:00:10.000Z'));
    const after = setup({ dataDir: sigterm.dataDir, state: new SelfRestartState('boot-d') });
    await after.module.start(after.ctx);
    expect(after.added[0].text).toContain('for another reason first (SIGTERM)');
  });

  test("start leaves this process's own pending request alone (session switch)", async () => {
    const { module, ctx, added, dataDir, state } = setup();
    await module.handleToolCall(call({ reason: 'pending' }));
    await module.start(ctx);
    expect(added).toHaveLength(0);
    expect(existsSync(join(dataDir, SELF_RESTART_FILE))).toBe(true);
    expect(state.isArmed()).toBe(true);
  });

  test('unknown tool names get the module\'s standard answer', async () => {
    const { module } = setup();
    const result = await module.handleToolCall({ id: 'c', name: 'reboot', input: {} } as ToolCall);
    expect(result.success).toBe(false);
  });
});
