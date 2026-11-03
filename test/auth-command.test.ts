import { describe, expect, test } from 'bun:test';
import type { AgentFramework } from '@animalabs/agent-framework';
import { handleCommand } from '../src/commands.js';
import { CredentialMonitor, type CredentialActionId, type CredentialState } from '../src/credential-state.js';

function state(over: Partial<CredentialState> = {}): CredentialState {
  return {
    kind: 'auth-expired', provider: 'anthropic', message: 'anthropic credential expired', since: 0,
    rotatable: true, expiresAt: 1_700_000_000_000,
    actions: [{ id: 'refresh', label: 'Refresh token' }, { id: 'set-token', label: 'Paste new token' }, { id: 'recheck', label: 'Re-check' }],
    ...over,
  };
}

function app(monitor?: { snapshot(): CredentialState; runAction(id: CredentialActionId, params?: { token?: string }): Promise<CredentialState> }) {
  return {
    framework: {} as AgentFramework,
    sessionManager: {} as never,
    recipe: { name: 'test' } as never,
    branchState: {} as never,
    credentials: monitor ?? null,
    switchSession: async () => {},
  };
}

describe('/auth', () => {
  test('explains itself on an API-key host', () => {
    expect(handleCommand('/auth', app()).lines[0]?.text).toMatch(/subscription credential/);
  });

  test('status prints the state, expiry, and the commands that map to the actions', () => {
    const lines = handleCommand('/auth', app({ snapshot: () => state(), runAction: async () => state() })).lines.map((l) => l.text);
    expect(lines[0]).toMatch(/auth-expired/);
    expect(lines.join('\n')).toMatch(/expires 2023-11-14T22:13:20.000Z \(host can refresh\)/);
    expect(lines.join('\n')).toMatch(/actions: \/auth refresh, \/auth token <tok>, \/auth recheck/);
  });

  test('refresh runs the action asynchronously and reports the outcome', async () => {
    const ran: Array<[CredentialActionId, { token?: string } | undefined]> = [];
    const monitor = {
      snapshot: () => state(),
      runAction: async (id: CredentialActionId, params?: { token?: string }) => {
        ran.push([id, params]);
        return state({ kind: 'ok', actions: [], lastAction: { id, at: 0, ok: true, message: 'refreshed; credential verified' } });
      },
    };
    const result = handleCommand('/auth refresh', app(monitor));
    expect(result.lines[0]?.text).toMatch(/running/);
    const done = await result.asyncWork!;
    expect(done.lines[0]?.text).toBe('/auth refresh: done — refreshed; credential verified');
    expect(ran).toEqual([['refresh', {}]]);
  });

  test('token passes the paste through as set-token and never prints it', async () => {
    const ran: Array<[CredentialActionId, { token?: string } | undefined]> = [];
    const monitor = {
      snapshot: () => state(),
      runAction: async (id: CredentialActionId, params?: { token?: string }) => {
        ran.push([id, params]);
        return state({ kind: 'ok', actions: [], lastAction: { id, at: 0, ok: true, message: 'token replaced; credential verified' } });
      },
    };
    const result = handleCommand('/auth token sk-ant-oat01-secret', app(monitor));
    const done = await result.asyncWork!;
    expect(ran).toEqual([['set-token', { token: 'sk-ant-oat01-secret' }]]);
    expect(JSON.stringify([result.lines, done.lines])).not.toContain('secret');
  });

  test('status says the credential may not be in its file while that stands, and how to write it again', () => {
    const monitor = new CredentialMonitor({ source: { provider: 'anthropic', canRefresh: () => true }, alert: () => {} });
    monitor.observeWriteBack('/x/creds.json', 'EACCES: permission denied');
    const unsaved = handleCommand('/auth status', app(monitor)).lines.map((l) => l.text).join('\n');
    expect(unsaved).toContain(`WARNING: ${monitor.snapshot().unsaved}`);
    expect(unsaved).toContain('/auth recheck');
    monitor.observeWriteBack('/x/creds.json');
    expect(handleCommand('/auth status', app(monitor)).lines.map((l) => l.text).join('\n')).not.toContain('WARNING');
    monitor.dispose();
  });

  test('an action whose write to the file fails says so once in its answer, and an answer after a write that succeeds doesn\'t', async () => {
    let writable = false;
    let monitor!: CredentialMonitor;
    const write = () => monitor.observeWriteBack('/x/creds.json', writable ? undefined : 'EACCES: permission denied');
    monitor = new CredentialMonitor({
      source: { provider: 'anthropic', canRefresh: () => true, refresh: async () => { write(); }, writeBack: write, probe: async () => {} },
      alert: () => {},
    });
    const answer = async (line: string) => (await handleCommand(line, app(monitor)).asyncWork!).lines.map((l) => l.text).join('\n');
    const refreshed = await answer('/auth refresh');
    const unsaved = monitor.snapshot().unsaved!;
    expect(unsaved).toContain('/x/creds.json');
    expect(refreshed.split(unsaved).length - 1).toBe(1);
    writable = true;
    const recovered = await answer('/auth recheck');
    expect(recovered).not.toContain(unsaved);
    expect(recovered).not.toContain('WARNING');
    monitor.dispose();
  });

  test('rejects unknown subcommands and a bare token', () => {
    const monitor = { snapshot: () => state(), runAction: async () => state() };
    expect(handleCommand('/auth rotate', app(monitor)).lines[0]?.text).toMatch(/^Usage: \/auth/);
    expect(handleCommand('/auth token', app(monitor)).lines[0]?.text).toMatch(/^Usage: \/auth/);
  });
});
