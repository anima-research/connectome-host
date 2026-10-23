import { expect, test } from 'bun:test';
import { switchSessionSteps } from '../src/session-switch.js';

/** A switch's steps, recording each in order. `during` runs inside a step,
 *  as a stop that begins while the step is under way. */
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

test('when stopping the made framework fails, the server still closes, and the failure reaches the caller', async () => {
  const app: { stopping?: boolean } = {};
  const { calls, steps } = recorder({
    during: { make: () => { app.stopping = true; } },
    nextStop: async () => { throw new Error('injected stop failure'); },
  });
  const lines: string[] = [];
  await expect(switchSessionSteps(app, steps, (line) => lines.push(line))).rejects.toThrow('injected stop failure');
  expect(calls).toEqual(['stopOld', 'make', 'next.stop', 'stopServer']);
  // Once stopping, nothing draws the switch's failure, so the switch logs it.
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

test('a making that fails with the host running closes nothing, and the failure reaches the caller', async () => {
  const app: { stopping?: boolean } = {};
  const { calls, steps } = recorder({ makeFails: true });
  const lines: string[] = [];
  await expect(switchSessionSteps(app, steps, (line) => lines.push(line))).rejects.toThrow('injected make failure');
  expect(calls).toEqual(['stopOld', 'make']);
  // The caller draws it, so the switch logs nothing.
  expect(lines).toEqual([]);
});
