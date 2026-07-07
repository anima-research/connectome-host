/**
 * Unit tests for createSessionSwitcher (fragility audit 1.4).
 *
 * The crack being closed: `switchSession` did stop() → setActiveSession(new)
 * → createFramework(new) with no failure handling, so a createFramework
 * throw left the app on a stopped framework with the broken session marked
 * active in sessions.json — the next boot went straight back into it.
 */
import { describe, test, expect } from 'bun:test';
import { createSessionSwitcher, type SessionSwitchIO } from '../src/session-switch.js';

interface FakeFramework {
  id: string;
  stopped: boolean;
}

function makeHarness(opts: { failCreateFor?: Set<string>; createDelayMs?: number } = {}) {
  const events: string[] = [];
  let active: string | null = 'sess-old';
  let current: FakeFramework = { id: 'fw-old', stopped: false };
  let created = 0;

  const io: SessionSwitchIO<FakeFramework> = {
    getActiveSessionId: () => active,
    exportBeforeSwitch: () => { events.push('export'); },
    getCurrentFramework: () => current,
    stopFramework: async (fw) => {
      fw.stopped = true;
      events.push(`stop:${fw.id}`);
    },
    setActiveSession: (id) => {
      active = id;
      events.push(`setActive:${id}`);
    },
    getStorePath: (id) => `/store/${id}`,
    createFramework: async (storePath) => {
      if (opts.createDelayMs) await new Promise((r) => setTimeout(r, opts.createDelayMs));
      const sessionId = storePath.split('/').pop()!;
      if (opts.failCreateFor?.has(sessionId)) {
        events.push(`createFailed:${sessionId}`);
        throw new Error(`create failed for ${sessionId}`);
      }
      created += 1;
      const fw = { id: `fw-${sessionId}-${created}`, stopped: false };
      events.push(`create:${fw.id}`);
      return fw;
    },
    activate: (fw, storePath) => {
      current = fw;
      events.push(`activate:${fw.id}@${storePath}`);
    },
  };

  return {
    io,
    events,
    getActive: () => active,
    getCurrent: () => current,
    switcher: createSessionSwitcher(io),
  };
}

describe('createSessionSwitcher', () => {
  test('happy path: stop old, activate new, active session updated', async () => {
    const h = makeHarness();
    await h.switcher('sess-new');
    expect(h.getActive()).toBe('sess-new');
    expect(h.getCurrent().id).toContain('sess-new');
    expect(h.events).toEqual([
      'export',
      'stop:fw-old',
      'setActive:sess-new',
      'create:fw-sess-new-1',
      'activate:fw-sess-new-1@/store/sess-new',
    ]);
  });

  test('createFramework failure rolls back active session and restores previous framework', async () => {
    const h = makeHarness({ failCreateFor: new Set(['sess-broken']) });

    await expect(h.switcher('sess-broken')).rejects.toThrow('create failed for sess-broken');

    // Active-session pointer rolled back — the next process start boots the
    // previous (known-good) session, not the one that just failed.
    expect(h.getActive()).toBe('sess-old');
    // A fresh framework for the previous session was created and activated —
    // the app is not stranded on the stopped one.
    expect(h.getCurrent().id).toContain('sess-old');
    expect(h.getCurrent().stopped).toBe(false);
    expect(h.events).toContain('setActive:sess-old');
  });

  test('rollback restore failure still rolls back the active-session pointer', async () => {
    const h = makeHarness({ failCreateFor: new Set(['sess-broken', 'sess-old']) });

    await expect(h.switcher('sess-broken')).rejects.toThrow('create failed for sess-broken');

    expect(h.getActive()).toBe('sess-old');
    // Framework couldn't be restored — but we did not lose the pointer.
    expect(h.getCurrent().id).toBe('fw-old');
  });

  test('concurrent switches: second call rejects instead of interleaving', async () => {
    const h = makeHarness({ createDelayMs: 50 });

    const first = h.switcher('sess-a');
    await expect(h.switcher('sess-b')).rejects.toThrow('session switch already in progress');
    await first;

    expect(h.getActive()).toBe('sess-a');
    // After the first completes, switching again works.
    await h.switcher('sess-b');
    expect(h.getActive()).toBe('sess-b');
  });

  test('export failure does not abort the switch', async () => {
    const h = makeHarness();
    h.io.exportBeforeSwitch = () => { throw new Error('export exploded'); };
    await h.switcher('sess-new');
    expect(h.getActive()).toBe('sess-new');
  });
});
