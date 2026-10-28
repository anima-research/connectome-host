import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBranchState, handleCommand } from '../src/commands.js';
import { SessionManager } from '../src/session-manager.js';
import { switchSessionSteps } from '../src/session-switch.js';

function recorder(opts: { during?: Partial<Record<'stopOld' | 'make', () => void>>; nextStop?: () => Promise<void>; makeFails?: boolean } = {}) {
  const calls: string[] = [];
  const next = {
    stop: async () => {
      calls.push('next.stop');
      await opts.nextStop?.();
    },
  };
  const steps = {
    stopOld: async () => { calls.push('stopOld'); opts.during?.stopOld?.(); },
    make: async () => {
      calls.push('make');
      opts.during?.make?.();
      if (opts.makeFails) throw new Error('injected make failure');
      return next;
    },
    install: (made: typeof next) => { calls.push(made === next ? 'install' : 'install(other)'); },
    stopServer: async () => { calls.push('stopServer'); },
  };
  return { calls, steps };
}

test('a switch with the host running stops the old framework, makes the new one and installs it', async () => {
  const app = {};
  const { calls, steps } = recorder();
  await switchSessionSteps(app, steps);
  expect(calls).toEqual(['stopOld', 'make', 'install']);
});

test('a switch asked for once the host is stopping is refused, and stops nothing', async () => {
  const app = { stopping: true };
  const { calls, steps } = recorder();
  await expect(switchSessionSteps(app, steps)).rejects.toThrow('the host is stopping, so it starts no session switch');
  expect(calls).toEqual([]);
});

test('a stop that begins while the old framework stops leaves the switch making nothing', async () => {
  const app: { stopping?: boolean } = {};
  const { calls, steps } = recorder({ during: { stopOld: () => { app.stopping = true; } } });
  await switchSessionSteps(app, steps);
  expect(calls).toEqual(['stopOld']);
});

test('a stop that begins while the new framework is made stops it and the Web UI server, and installs nothing', async () => {
  const app: { stopping?: boolean } = {};
  const { calls, steps } = recorder({ during: { make: () => { app.stopping = true; } } });
  await switchSessionSteps(app, steps);
  expect(calls).toEqual(['stopOld', 'make', 'next.stop', 'stopServer']);
});

test('when stopping the made framework fails, the server still closes, the failure reaches the caller, and the switch logs it', async () => {
  const app: { stopping?: boolean } = {};
  const { calls, steps } = recorder({
    during: { make: () => { app.stopping = true; } },
    nextStop: async () => { throw new Error('injected stop failure'); },
  });
  const lines: string[] = [];
  await expect(switchSessionSteps(app, steps, (line) => lines.push(line))).rejects.toThrow('injected stop failure');
  expect(calls).toEqual(['stopOld', 'make', 'next.stop', 'stopServer']);
  expect(lines).toEqual([expect.stringContaining('stopping the framework the switch had made failed: injected stop failure')]);
});

test('a making that fails once the stop has begun closes the Web UI server, and the failure reaches the caller', async () => {
  const app: { stopping?: boolean } = {};
  const { calls, steps } = recorder({ during: { make: () => { app.stopping = true; } }, makeFails: true });
  const lines: string[] = [];
  await expect(switchSessionSteps(app, steps, (line) => lines.push(line))).rejects.toThrow('injected make failure');
  expect(calls).toEqual(['stopOld', 'make', 'stopServer']);
  expect(lines).toEqual([expect.stringContaining("making the switched-to session's framework failed: injected make failure")]);
});

test('a making that fails with the host running closes nothing, and the failure reaches the caller, with nothing logged by the switch', async () => {
  const app: { stopping?: boolean } = {};
  const { calls, steps } = recorder({ makeFails: true });
  const lines: string[] = [];
  await expect(switchSessionSteps(app, steps, (line) => lines.push(line))).rejects.toThrow('injected make failure');
  expect(calls).toEqual(['stopOld', 'make']);
  expect(lines).toEqual([]);
});

test('a switch asked for while another is under way is refused, saying how to go on, and starts nothing', async () => {
  const app: { switching?: boolean } = {};
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const first = recorder();
  const firstSwitch = switchSessionSteps(app, { ...first.steps, stopOld: async () => { first.calls.push('stopOld'); await held; } });
  const second = recorder();
  await expect(switchSessionSteps(app, second.steps))
    .rejects.toThrow("a session switch is under way, so this one isn't started; try again once it has finished");
  expect(second.calls).toEqual([]);
  release();
  await firstSwitch;
  expect(first.calls).toEqual(['stopOld', 'make', 'install']);
});

test('a switch after one whose making failed, or one the host\'s stop ended, isn\'t refused', async () => {
  const app: { stopping?: boolean; switching?: boolean } = {};
  await expect(switchSessionSteps(app, recorder({ makeFails: true }).steps)).rejects.toThrow('injected make failure');
  const after = recorder();
  await switchSessionSteps(app, after.steps);
  expect(after.calls).toEqual(['stopOld', 'make', 'install']);
  await switchSessionSteps(app, recorder({ during: { make: () => { app.stopping = true; } } }).steps);
  app.stopping = false;
  const again = recorder();
  await switchSessionSteps(app, again.steps);
  expect(again.calls).toEqual(['stopOld', 'make', 'install']);
});

test('a switch whose old framework\'s stop, install or server close throws doesn\'t refuse the next switch', async () => {
  const app: { stopping?: boolean; switching?: boolean } = {};
  const failing = (step: 'stopOld' | 'install' | 'stopServer') => {
    const { steps } = recorder({ during: { make: () => { if (step === 'stopServer') app.stopping = true; } }, makeFails: step === 'stopServer' });
    return { ...steps, [step]: async () => { throw new Error(`injected ${step} failure`); } };
  };
  for (const step of ['stopOld', 'install', 'stopServer'] as const) {
    app.stopping = false;
    await expect(switchSessionSteps(app, failing(step), () => {})).rejects.toThrow(`injected ${step} failure`);
    app.stopping = false;
    const next = recorder();
    await switchSessionSteps(app, next.steps);
    expect(next.calls).toEqual(['stopOld', 'make', 'install']);
  }
});

test('/session new and /session switch during a switch are refused before any session is made or made active', () => {
  const sessions = new SessionManager(mkdtempSync(join(tmpdir(), 'session-switch-')));
  const running = sessions.createSession('running');
  const other = sessions.createSession('other');
  sessions.setActiveSession(running.id);
  const app = { switching: true, sessionManager: sessions, branchState: createBranchState() } as unknown as Parameters<typeof handleCommand>[1];
  const refusal = "A session switch is under way, so this one isn't started; try again once it has finished.";
  for (const line of ['/session new later', `/session switch ${other.id}`]) {
    const answer = handleCommand(line, app);
    expect(answer.lines.map((l) => l.text)).toEqual([refusal]);
    expect(answer.switchToSessionId).toBeUndefined();
  }
  expect(sessions.listSessions().map((s) => s.name).sort()).toEqual(['other', 'running']);
  expect(sessions.getActiveSession()?.id).toBe(running.id);
});
