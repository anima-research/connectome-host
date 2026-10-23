/**
 * The health snapshot's per-agent sections read each agent on its own: one
 * agent whose read throws, such as one whose context manager a store surgery
 * left uninitialized, is left out of that section and named in readFailures,
 * and the others are still reported. An agent with nothing to report is left
 * out with no failure.
 */
import { describe, test, expect } from 'bun:test';
import { buildHealthSnapshot, type PanelAppRef } from '../src/web/panel-data.js';
import { healthEntry } from '../src/web/health-lookup.js';

const NOT_READY = 'context manager is not initialized';
const UNDESCRIBED = "the read failed, and its error couldn't be described";
const notReady = (): never => { throw new Error(NOT_READY); };

type Reads = { quarantine?: () => unknown; debt?: () => unknown; render?: () => unknown; settings?: () => unknown };

function agentStub(name: string, reads: Reads = {}) {
  const render = reads.render ?? (() => ({ head: 10, tail: 20 }));
  return {
    name,
    settings: reads.settings ?? (() => ({ contextBudgetTokens: 100_000 })),
    getContextManager: () => ({
      // A strategy that keeps render stats, as the autobiographical one does.
      getStrategy: () => ({
        getCompressionQuarantineStatus: reads.quarantine ?? (() => ({ quarantined: 1 })),
        getCompressionDebt: reads.debt ?? (() => ({ level: 'healthy' })),
        getRenderStats: render,
      }),
      getRenderStats: render,
    }),
  };
}

const broken = (name: string) =>
  agentStub(name, { quarantine: notReady, debt: notReady, render: notReady, settings: notReady });

function appWith(agents: ReturnType<typeof agentStub>[]): PanelAppRef {
  const framework = {
    agents,
    healthSnapshot: () => ({ agents: agents.map((agent) => ({ name: agent.name })) }),
    getAllAgents() { return this.agents; },
    // A method, as the framework's is: it reads its own state through `this`.
    getAgentRuntimeSettings(name: string) {
      const agent = this.agents.find((a) => a.name === name);
      if (!agent) throw new Error(`Unknown agent: ${name}`);
      return agent.settings();
    },
  };
  return { framework, recipe: {} } as unknown as PanelAppRef;
}

describe('health snapshot per agent', () => {
  test('an agent whose reads throw is left out of each section and named in readFailures, and the others are reported', () => {
    const snapshot = buildHealthSnapshot(appWith([broken('broken'), agentStub('steady')]));
    expect(snapshot.runtimeSettings).toEqual({ steady: { contextBudgetTokens: 100_000 } });
    expect(snapshot.compressionQuarantine).toEqual({ steady: { quarantined: 1 } });
    expect(snapshot.compressionDebt).toEqual({ steady: { level: 'healthy' } });
    expect(snapshot.contextComposition).toEqual({ steady: { head: 10, tail: 20 } });
    expect(snapshot.readFailures).toEqual({
      broken: {
        compressionQuarantine: NOT_READY,
        compressionDebt: NOT_READY,
        contextComposition: NOT_READY,
        runtimeSettings: NOT_READY,
      },
    });
  });

  test("one section's failure leaves the agent in the others, and nothing to report is no failure", () => {
    const snapshot = buildHealthSnapshot(appWith([agentStub('partial', { debt: notReady, render: () => null })]));
    expect(snapshot.compressionQuarantine).toEqual({ partial: { quarantined: 1 } });
    expect(snapshot.runtimeSettings).toEqual({ partial: { contextBudgetTokens: 100_000 } });
    expect(snapshot.compressionDebt).toEqual({});
    expect(snapshot.contextComposition).toEqual({});
    expect(snapshot.readFailures).toEqual({ partial: { compressionDebt: NOT_READY } });
  });

  test('with every agent readable, each section has every agent and there are no read failures', () => {
    const snapshot = buildHealthSnapshot(appWith([agentStub('first'), agentStub('second')]));
    for (const section of ['runtimeSettings', 'compressionQuarantine', 'compressionDebt', 'contextComposition']) {
      expect(Object.keys(snapshot[section] as object)).toEqual(['first', 'second']);
    }
    expect(snapshot.readFailures).toBeUndefined();
  });

  test("a thrown value that can't be described still loses only its agent", () => {
    const opaque = { toString() { throw new Error('no string'); } };
    const odd = Object.assign(new Error('x'), { message: 42 as unknown as string });
    const snapshot = buildHealthSnapshot(appWith([
      agentStub('opaque', { debt: () => { throw opaque; } }),
      agentStub('odd', { debt: () => { throw odd; } }),
      agentStub('steady'),
    ]));
    expect(snapshot.compressionDebt).toEqual({ steady: { level: 'healthy' } });
    expect(snapshot.readFailures).toEqual({
      opaque: { compressionDebt: UNDESCRIBED },
      odd: { compressionDebt: UNDESCRIBED },
    });
  });

  test('an object whose message getter throws gets the fixed text, and only its agent is left out', () => {
    const trap = { get message(): string { throw new Error('no message here'); } };
    const snapshot = buildHealthSnapshot(appWith([agentStub('trap', { debt: () => { throw trap; } }), agentStub('steady')]));
    expect(snapshot.compressionDebt).toEqual({ steady: { level: 'healthy' } });
    expect(snapshot.readFailures).toEqual({ trap: { compressionDebt: UNDESCRIBED } });
  });

  test('a thrown primitive is its own text, an object gives its message, and one without a message gets the fixed text', () => {
    const snapshot = buildHealthSnapshot(appWith([
      agentStub('text', { debt: () => { throw 'disk gone'; } }),
      agentStub('nothing', { debt: () => { throw undefined; } }),
      agentStub('carrier', { debt: () => { throw { message: 'quota exhausted' }; } }),
      agentStub('silent', { debt: () => { throw new Error(); } }),
      agentStub('coded', { debt: () => { throw { code: 'ETIMEDOUT' }; } }),
    ]));
    expect(snapshot.readFailures).toEqual({
      text: { compressionDebt: 'disk gone' },
      nothing: { compressionDebt: 'undefined' },
      carrier: { compressionDebt: 'quota exhausted' },
      silent: { compressionDebt: UNDESCRIBED },
      coded: { compressionDebt: UNDESCRIBED },
    });
  });

  test("agents named __proto__ and constructor are recorded under their own names, and Object's prototype is untouched", () => {
    const snapshot = buildHealthSnapshot(appWith([
      agentStub('__proto__', { debt: notReady }),
      agentStub('constructor', { debt: notReady }),
    ]));
    const failures = snapshot.readFailures as Record<string, Record<string, string>>;
    expect(Object.keys(failures).sort()).toEqual(['__proto__', 'constructor']);
    expect(Object.prototype.hasOwnProperty.call(failures, '__proto__')).toBe(true);
    expect(failures['__proto__']!.compressionDebt).toBe(NOT_READY);
    expect(failures['constructor']!.compressionDebt).toBe(NOT_READY);
    expect(({} as Record<string, unknown>).compressionDebt).toBeUndefined();
    expect((Object as unknown as Record<string, unknown>).compressionDebt).toBeUndefined();
    // Their readable sections are keyed by their names too.
    expect(Object.keys(snapshot.runtimeSettings as object).sort()).toEqual(['__proto__', 'constructor']);
  });

  test("a failure's message is cut to 300 characters, never inside one", () => {
    const long = 'x'.repeat(1000);
    const emoji = '\u{1F600}'.repeat(400);
    const snapshot = buildHealthSnapshot(appWith([
      agentStub('noisy', { debt: () => { throw new Error(long); } }),
      agentStub('wide', { debt: () => { throw new Error(emoji); } }),
    ]));
    const failures = snapshot.readFailures as Record<string, Record<string, string>>;
    expect(failures.noisy!.compressionDebt).toBe('x'.repeat(300));
    expect(failures.wide!.compressionDebt).toBe('\u{1F600}'.repeat(300));
  });
});

describe('health panel lookups', () => {
  test('a JSON-parsed snapshot is read by own key, so names that Object.prototype also has read as missing when they are', () => {
    const snapshot = buildHealthSnapshot(appWith([agentStub('constructor', { debt: notReady }), agentStub('steady')]));
    const parsed = JSON.parse(JSON.stringify(snapshot)) as Record<string, Record<string, unknown>>;
    // The panel's debt line: absent for the agent whose read failed, with its failure recorded.
    expect(healthEntry(parsed.compressionDebt, 'constructor')).toBeUndefined();
    expect(healthEntry(healthEntry(parsed.readFailures, 'constructor') as Record<string, string>, 'compressionDebt')).toBe(NOT_READY);
    // Names that are Object.prototype members, and absent from every section.
    for (const name of ['toString', '__proto__', 'hasOwnProperty']) {
      for (const section of ['compressionQuarantine', 'compressionDebt', 'contextComposition', 'runtimeSettings', 'readFailures']) {
        expect(healthEntry(parsed[section], name)).toBeUndefined();
      }
    }
    // The readable agent is found, and its debt read has no failure.
    expect(healthEntry(parsed.compressionDebt, 'steady')).toEqual({ level: 'healthy' });
    expect(healthEntry(parsed.readFailures, 'steady')).toBeUndefined();
  });

  test('readable agents named constructor and toString are found by name', () => {
    const snapshot = buildHealthSnapshot(appWith([agentStub('constructor'), agentStub('toString')]));
    const parsed = JSON.parse(JSON.stringify(snapshot)) as Record<string, Record<string, unknown>>;
    for (const name of ['constructor', 'toString']) {
      expect(healthEntry(parsed.compressionDebt, name)).toEqual({ level: 'healthy' });
      expect(healthEntry(parsed.runtimeSettings, name)).toEqual({ contextBudgetTokens: 100_000 });
    }
  });

  test('a missing or null map has no entries', () => {
    expect(healthEntry(undefined, 'steady')).toBeUndefined();
    expect(healthEntry(null, 'steady')).toBeUndefined();
  });
});
