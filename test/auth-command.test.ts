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
        return state({ kind: 'ok', actions: [], lastAction: { id, at: 0, ok: true, message: 'refreshed; credential verified', said: 'refreshed; credential verified' } });
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
        return state({ kind: 'ok', actions: [], lastAction: { id, at: 0, ok: true, message: 'token replaced; credential verified', said: 'token replaced; credential verified' } });
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

describe('/auth that a fleet parent sent', () => {
  const SENTINEL = 'sentinel-3b7e invalid x-api-key';
  const rejected = state({
    kind: 'auth-rejected',
    message: `anthropic rejected the credential (${SENTINEL})`,
    unsaved: 'the refreshed credential may not be in /x/creds.json: EACCES: permission denied',
    login: { verificationUrl: 'https://example.test/device', userCode: 'ABCD-1234' },
    lastAction: { id: 'refresh', at: 0, ok: false, message: `refresh failed: ${SENTINEL}`, said: 'refresh failed' },
  });
  const monitor = { snapshot: () => rejected, runAction: async () => rejected };
  const said = async (line: string, via: 'fleet' | 'host-console') => {
    const result = handleCommand(line, app(monitor), { requester: { via } });
    const later = result.asyncWork ? (await result.asyncWork).lines : [];
    return [...result.lines, ...later].map((l) => l.text);
  };

  test('status leaves out the credential\'s messages, and keeps its kind, expiry, warning, login and actions', async () => {
    expect(await said('/auth status', 'fleet')).toEqual([
      'Credential (anthropic): auth-rejected',
      '  expires 2023-11-14T22:13:20.000Z (host can refresh)',
      '  WARNING: the refreshed credential may not be in /x/creds.json: EACCES: permission denied. /auth recheck writes it again.',
      '  login: open https://example.test/device and enter code ABCD-1234',
      '  actions: /auth refresh, /auth token <tok>, /auth recheck',
      '  last action: refresh FAILED — refresh failed',
    ]);
    expect((await said('/auth status', 'host-console')).join('\n').split(SENTINEL)).toHaveLength(3);
  });

  test("a token whose check was inconclusive says done, in the host's own words without the error that the check met", async () => {
    const inconclusive = state({
      kind: 'auth-rejected',
      message: `anthropic rejected the credential (${SENTINEL})`,
      lastAction: { id: 'set-token', at: 0, ok: true, message: `token replaced; verification inconclusive (${SENTINEL})`, said: 'token replaced; verification inconclusive' },
    });
    const replaced = { snapshot: () => inconclusive, runAction: async () => inconclusive };
    const result = handleCommand('/auth token sk-new', app(replaced), { requester: { via: 'fleet' } });
    const lines = [...result.lines, ...(result.asyncWork ? (await result.asyncWork).lines : [])].map((l) => l.text);
    expect(lines.slice(0, 2)).toEqual(['/auth set-token: running…', '/auth set-token: done — token replaced; verification inconclusive']);
    expect(lines).toContain('  last action: set-token ok — token replaced; verification inconclusive');
    expect(lines.join('\n')).not.toContain(SENTINEL);
  });

  test("an action says whether it worked, in the host's own words without the error that it met", async () => {
    const lines = await said('/auth refresh', 'fleet');
    expect(lines.slice(0, 2)).toEqual(['/auth refresh: running…', '/auth refresh: FAILED — refresh failed']);
    expect(lines.join('\n')).not.toContain(SENTINEL);
    expect((await said('/auth refresh', 'host-console')).join('\n')).toContain(`/auth refresh: FAILED — refresh failed: ${SENTINEL}`);
  });
});
