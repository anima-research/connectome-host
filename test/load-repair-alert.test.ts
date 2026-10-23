/**
 * A load's repair of an agent's summaries, in the words its keeper reads
 * (src/web/load-repair-alert.ts): the spans merged per level, how much text
 * left, how to read the old summaries back, the sentence for the agent, and
 * the alert the host sends for each report context-manager makes.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The strategy through agent-framework's re-export, as the host's start builds
// it (src/framework-strategy.ts); agent-framework exports ContextManager as a
// type only.
import { AutobiographicalStrategy } from '@animalabs/agent-framework';
import { ContextManager } from '@animalabs/context-manager';
import {
  LOAD_REPAIR_KIND,
  loadRepairAlert,
  loadRepairLines,
  loadRepairReadBack,
  loadRepairSpans,
  wireLoadRepairAlert,
  type LoadRepairDroppedSummary,
  type LoadRepairReport,
} from '../src/web/load-repair-alert.js';
import { buildHealthSnapshot, type PanelAppRef } from '../src/web/panel-data.js';
import { HEALTH_STRINGS, keepNamedStrings } from '../src/modules/web-ui-observers.js';

function drop(id: string, level: number | null, firstAt: string | null, lastAt: string | null, over: Partial<LoadRepairDroppedSummary> = {}): LoadRepairDroppedSummary {
  return {
    id,
    level,
    tokens: 1000,
    reason: 'names-missing',
    sourceRange: { first: `${id}-first`, last: `${id}-last`, firstAt, lastAt },
    ...over,
  };
}

function report(dropped: LoadRepairDroppedSummary[], over: Partial<LoadRepairReport> = {}): LoadRepairReport {
  return {
    namespace: 'agents/alice',
    branch: 'main',
    stateId: 'agents/alice/autobio:summaries',
    sequenceBefore: 48213,
    dropped,
    droppedTokens: dropped.reduce((sum, d) => sum + (typeof d.tokens === 'number' ? d.tokens : 0), 0),
    emptyDropped: 0,
    ...over,
  };
}

// One damaged L1 and the two summaries above it: the cascade the words merge.
const cascade = report([
  drop('l1', 1, '2026-10-03T14:02:00.000Z', '2026-10-03T16:40:00.000Z', { tokens: 1210, reason: 'unreadable' }),
  drop('l2', 2, '2026-10-01T09:10:00.000Z', '2026-10-05T22:01:00.000Z', { tokens: 1800 }),
  drop('l3', 3, '2026-10-01T09:10:00.000Z', '2026-10-05T22:01:00.000Z', { tokens: 1200 }),
]);

describe('loadRepairAlert', () => {
  test('a cascade from one damaged L1 reads as one memory changing at three levels, in the words agreed', () => {
    const alert = loadRepairAlert(cascade, 'Alice', '/srv/connectome/sessions/alice/store');
    expect(alert.kind).toBe(LOAD_REPAIR_KIND);
    // The Health tab shows these words, less the last sentence.
    expect(alert.message).toBe([...loadRepairLines(cascade, 'Alice', '/srv/connectome/sessions/alice/store'), 'The message is in failures.log; the Health tab shows the latest repair, and /healthz its full report.'].join(' '));
    expect(alert.message).toBe(
      "Alice's memory changed at load: context-manager's load repair dropped summaries holding 4,210 tokens of summary text, "
      + 'covering 2026-10-03 14:02–16:40 UTC at level 1 and 2026-10-01 09:10 – 2026-10-05 22:01 UTC at levels 2–3. '
      + 'The repair removed summaries, not messages: those the store holds show raw or under the summaries that remain, until '
      + 'compression covers them again. '
      + "A repair looks the same whether it's an upgrade's one-time cleanup or damage (a crash, a bad write, two writers on one store), "
      + 'so one on a store this context-manager version has opened before is worth chasing. '
      + "The old summaries are still in the store's history: in a copy of /srv/connectome/sessions/alice/store taken while the host is stopped, "
      + "open it with Chronicle's JsStore.open({ path }), switchBranch(\"main\"), then getStateJsonAt(\"agents/alice/autobio:summaries\", 48213). "
      + 'If you tell Alice, you could say: "When your memory was loaded, some of your summaries from between Oct 1 and Oct 5 (UTC) were removed. '
      + "Your messages weren't: those still in your history are shown in full or under the summaries that remain, "
      + "until they're summarized again.\" "
      + 'The message is in failures.log; the Health tab shows the latest repair, and /healthz its full report.',
    );
  });

  test("its data is the report's fields at the top level, so each is bounded on its own, with the store's path", () => {
    expect(loadRepairAlert(cascade, 'Alice', '/srv/store').data).toEqual({ ...cascade, store: '/srv/store' });
    expect(loadRepairAlert(cascade, 'Alice').data).toEqual({ ...cascade });
  });

  test("the read-back names the report's branch and state, not always main", () => {
    const onBranch = report(cascade.dropped, { branch: 'rewind-3', stateId: 'agents/bo/autobio:summaries', sequenceBefore: 7 });
    expect(loadRepairReadBack(onBranch, '/s')).toBe(
      "The old summaries are still in the store's history: in a copy of /s taken while the host is stopped, open it with Chronicle's "
      + 'JsStore.open({ path }), switchBranch("rewind-3"), then getStateJsonAt("agents/bo/autobio:summaries", 7).',
    );
    expect(loadRepairReadBack(onBranch)).toStartWith("The old summaries are still in the store's history: in a copy of the agent's store taken while");
  });

  test('the sentence for the agent names the days, with years where they differ, only as "among them" where some have none, and none where none have', () => {
    const sameDay = report([drop('a', 1, '2026-10-03T14:02:00Z', '2026-10-03T16:40:00Z')]);
    expect(loadRepairAlert(sameDay, 'Alice').message).toContain('some of your summaries from Oct 3 (UTC) were removed. Your messages');
    const acrossYears = report([drop('a', 1, '2025-12-30T10:00:00Z', '2026-01-02T10:00:00Z')]);
    expect(loadRepairAlert(acrossYears, 'Alice').message).toContain('from between Dec 30, 2025 and Jan 2, 2026 (UTC) were removed.');
    const mixed = report([drop('a', 1, '2026-10-03T14:02:00Z', '2026-10-03T16:40:00Z'), drop('b', 2, null, null, { sourceRange: null })]);
    expect(loadRepairAlert(mixed, 'Alice').message).toContain('some of your summaries were removed, among them ones from Oct 3 (UTC). Your messages');
    // A summary with only one end's time is untimed: its time names no day.
    const halfTimed = report([drop('a', 1, '2026-10-03T14:02:00Z', null), drop('b', 2, null, null, { sourceRange: null })]);
    expect(loadRepairAlert(halfTimed, 'Alice').message).toContain('"When your memory was loaded, some of your summaries were removed. Your messages');
    const otherHalf = report([drop('a', 1, null, '2026-10-03T14:02:00Z'), drop('b', 2, null, null, { sourceRange: null })]);
    expect(loadRepairAlert(otherHalf, 'Alice').message).toContain('"When your memory was loaded, some of your summaries were removed. Your messages');
    const untimed = report([drop('a', 1, null, null), drop('b', 2, null, null, { sourceRange: null })]);
    expect(loadRepairAlert(untimed, 'Alice').message).toContain('"When your memory was loaded, some of your summaries were removed. Your messages');
  });
});

describe('loadRepairSpans', () => {
  test('spans that overlap, touch or nest at a level merge, in whatever order they come; separate ones are each named', () => {
    const r = report([
      drop('d', 1, '2026-10-04T08:00:00Z', '2026-10-04T09:00:00Z'),
      drop('b', 1, '2026-10-01T11:00:00Z', '2026-10-01T13:00:00Z'),
      drop('a', 1, '2026-10-01T10:00:00Z', '2026-10-01T12:00:00Z'),
      drop('c', 1, '2026-10-01T13:00:00Z', '2026-10-01T14:00:00Z'),
      drop('n', 1, '2026-10-01T10:30:00Z', '2026-10-01T10:45:00Z'),
    ]);
    expect(loadRepairSpans(r)).toBe('2026-10-01 10:00–14:00 UTC and 2026-10-04 08:00–09:00 UTC at level 1');
  });

  test('a span whose last message has the earlier time is read from the earlier to the later', () => {
    expect(loadRepairSpans(report([drop('a', 1, '2026-10-01T12:00:00Z', '2026-10-01T10:00:00Z')]))).toBe('2026-10-01 10:00–12:00 UTC at level 1');
  });

  test('a span within one minute is that minute, not a range from it to itself, and one across days at the same clock time is a range', () => {
    // As a fresh store's first two messages are, a few milliseconds apart.
    const r = report([drop('a', 2, '2026-10-22T23:17:15.418Z', '2026-10-22T23:17:15.427Z')]);
    expect(loadRepairSpans(r)).toBe('2026-10-22 23:17 UTC at level 2');
    expect(loadRepairSpans(report([drop('a', 1, '2025-12-30T10:00:00Z', '2026-01-02T10:00:00Z')]))).toBe('2025-12-30 10:00 – 2026-01-02 10:00 UTC at level 1');
  });

  test('a level names at most three spans, then how many more spans, and three are all named', () => {
    const days = (n: number) => Array.from({ length: n }, (_, i) => drop(`s${i}`, 1, `2026-10-0${i + 1}T10:00:00Z`, `2026-10-0${i + 1}T11:00:00Z`));
    expect(loadRepairSpans(report(days(5)))).toBe('2026-10-01 10:00–11:00 UTC, 2026-10-02 10:00–11:00 UTC, 2026-10-03 10:00–11:00 UTC and 2 more spans at level 1');
    expect(loadRepairSpans(report(days(4)))).toEndWith('2026-10-03 10:00–11:00 UTC and 1 more span at level 1');
    expect(loadRepairSpans(report(days(3)))).toBe('2026-10-01 10:00–11:00 UTC, 2026-10-02 10:00–11:00 UTC and 2026-10-03 10:00–11:00 UTC at level 1');
  });

  test("ranges that couldn't be read are counted on their own, past the three named", () => {
    const r = report([
      ...[1, 2, 3, 4].map((d) => drop(`s${d}`, 1, `2026-10-0${d}T10:00:00Z`, `2026-10-0${d}T11:00:00Z`)),
      drop('u1', 1, null, null, { sourceRange: null }),
      drop('u2', 1, null, null, { sourceRange: null }),
    ]);
    expect(loadRepairSpans(r)).toBe(
      "2026-10-01 10:00–11:00 UTC, 2026-10-02 10:00–11:00 UTC, 2026-10-03 10:00–11:00 UTC, 1 more span and 2 spans whose ranges couldn't be read at level 1",
    );
  });

  test('levels are set apart with semicolons once a level names several spans', () => {
    const r = report([
      drop('a', 1, '2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z'),
      drop('b', 1, '2026-10-02T10:00:00Z', '2026-10-02T11:00:00Z'),
      drop('c', 2, '2026-10-01T10:00:00Z', '2026-10-02T11:00:00Z'),
    ]);
    expect(loadRepairSpans(r)).toBe('2026-10-01 10:00–11:00 UTC and 2026-10-02 10:00–11:00 UTC at level 1; 2026-10-01 10:00 – 2026-10-02 11:00 UTC at level 2');
  });

  test("a span with no times names its messages, once each, and one whose range couldn't be read is counted", () => {
    const r = report([
      drop('a', 1, null, '2026-10-01T10:00:00Z'),
      drop('a', 1, null, '2026-10-01T10:00:00Z'),
      drop('b', 1, 'not a time', 'not a time', { sourceRange: { first: 'm5', last: 'm5', firstAt: 'not a time', lastAt: 'not a time' } }),
      drop('c', 1, null, null, { sourceRange: null }),
      drop('d', 2, null, null, { sourceRange: null }),
      drop('e', 2, null, null, { sourceRange: null }),
    ]);
    expect(loadRepairSpans(r)).toBe(
      "messages a-first to a-last, message m5 and a span whose range couldn't be read at level 1; "
      + "2 spans whose ranges couldn't be read at level 2",
    );
  });

  test("summaries whose level couldn't be read come last, not joined with a level whose spans are the same", () => {
    const span = ['2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z'] as const;
    const r = report([drop('a', null, ...span), drop('b', 2, ...span), drop('c', 1, '2026-10-02T10:00:00Z', '2026-10-02T11:00:00Z')]);
    expect(loadRepairSpans(r)).toBe(
      "2026-10-02 10:00–11:00 UTC at level 1, 2026-10-01 10:00–11:00 UTC at level 2 and 2026-10-01 10:00–11:00 UTC at a level that couldn't be read",
    );
    expect(loadRepairSpans(report([drop('a', null, ...span)]))).toBe("2026-10-01 10:00–11:00 UTC at a level that couldn't be read");
  });

  test('levels join only when all their spans are the same, named or not, and never with a range that could not be read', () => {
    const span = ['2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z'] as const;
    const r = report([drop('a', 1, ...span), drop('b', 3, ...span), drop('c', 2, '2026-10-02T10:00:00Z', '2026-10-02T11:00:00Z')]);
    expect(loadRepairSpans(r)).toBe('2026-10-01 10:00–11:00 UTC at levels 1 and 3; 2026-10-02 10:00–11:00 UTC at level 2');
    // Two levels whose first three spans and count match, but whose fourth differ.
    const days = (level: number, last: number) => [1, 2, 3, last].map((d) => drop(`s${level}-${d}`, level, `2026-10-0${d}T10:00:00Z`, `2026-10-0${d}T11:00:00Z`));
    expect(loadRepairSpans(report([...days(1, 5), ...days(2, 6)]))).toContain('1 more span at level 1; ');
    // Two unreadable ranges at two levels can't be shown to be one.
    const unread = report([drop('u', 2, null, null, { sourceRange: null }), drop('v', 3, null, null, { sourceRange: null })]);
    expect(loadRepairSpans(unread)).toBe("a span whose range couldn't be read at level 2 and a span whose range couldn't be read at level 3");
  });
});

describe('loadRepairLines', () => {
  test("where no summary's size could be read it says so, where some could, at least their total, and one token is one", () => {
    const none = report([drop('a', 1, '2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z', { tokens: null })], { droppedTokens: 0 });
    expect(loadRepairLines(none, 'Alice')[0]).toStartWith(
      "Alice's memory changed at load: context-manager's load repair dropped summaries whose total size couldn't be read, covering 2026-10-01",
    );
    const some = report([
      drop('a', 1, '2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z', { tokens: null }),
      drop('b', 2, '2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z', { tokens: 2500 }),
    ]);
    expect(loadRepairLines(some, 'Alice')[0]).toContain('dropped summaries holding at least 2,500 tokens of summary text, covering');
    const one = report([drop('a', 1, '2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z', { tokens: 1 })]);
    expect(loadRepairLines(one, 'Alice')[0]).toContain('dropped summaries holding 1 token of summary text, covering');
    // A floor of 0 says nothing where a size couldn't be read.
    const zero = report([
      drop('a', 1, '2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z', { tokens: null }),
      drop('b', 2, '2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z', { tokens: 0 }),
    ]);
    expect(loadRepairLines(zero, 'Alice')[0]).toContain("dropped summaries whose total size couldn't be read, covering");
    // Every size read and adding up to none is a size, not an unread one.
    const allZero = report([drop('a', 1, '2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z', { tokens: 0 })]);
    expect(loadRepairLines(allZero, 'Alice')[0]).toContain('dropped summaries holding 0 tokens of summary text, covering');
  });

  test('a report with more times than a call takes arguments still has its words', () => {
    // 1,000,000 summaries give 2,000,000 times. Spreading them into Math.min
    // throws past about 638,000 arguments in Bun 1.4.4.
    const many = report(Array.from({ length: 1_000_000 }, (_, i) => drop(`s${i}`, 1, '2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z')));
    expect(loadRepairLines(many, 'Alice')[3]).toContain('some of your summaries from Oct 1 (UTC) were removed.');
  }, 60_000);
});

describe('wireLoadRepairAlert', () => {
  test("sends each report through notifyOps, under the agent's name, with the store's path", () => {
    let handler: ((r: LoadRepairReport) => void) | undefined;
    const strategy = { setLoadRepairHandler(fn: (r: LoadRepairReport) => void) { handler = fn; } };
    const sent: Array<{ kind: string; agent: string; message: string; data?: Record<string, unknown> }> = [];
    const framework = {
      // A method, as the framework's is: it reads its own state through `this`.
      sent,
      notifyOps(kind: string, agent: string, message: string, data?: Record<string, unknown>) {
        this.sent.push({ kind, agent, message, data });
      },
    };
    expect(wireLoadRepairAlert(strategy, framework, 'Alice', '/srv/store')).toBe(true);
    // A strategy can make more than one report in its life, each sent in turn.
    const later = report([drop('later', 1, '2026-10-09T10:00:00Z', '2026-10-09T11:00:00Z')], { sequenceBefore: 50001 });
    handler!(cascade);
    handler!(later);
    const sends = [cascade, later].map((r) => loadRepairAlert(r, 'Alice', '/srv/store'));
    expect(sent).toEqual(sends.map((alert) => ({ kind: 'memory-load-repair', agent: 'Alice', message: alert.message, data: alert.data })));
  });

  test("a strategy that doesn't report load repairs, or a framework without notifyOps, leaves it unwired", () => {
    const framework = { notifyOps() {} };
    expect(wireLoadRepairAlert({}, framework, 'Alice')).toBe(false);
    expect(wireLoadRepairAlert(null, framework, 'Alice')).toBe(false);
    let set = false;
    expect(wireLoadRepairAlert({ setLoadRepairHandler() { set = true; } }, {}, 'Alice')).toBe(false);
    expect(set).toBe(false);
  });
});

describe("wireLoadRepairAlert after a real strategy's load", () => {
  // A start opens the agent's store inside AgentFramework.create, and the host
  // wires the alert only after create returns (src/index.ts). So the start-up
  // load's report is made with no handler set, held by the strategy, and
  // handed over when the alert sets one.
  test("a report the load made before the alert was wired is sent when it's wired", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'load-repair-wire-'));
    const path = join(dir, 'store');
    const membrane = { complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: 'x' }] }) } as never;
    try {
      // 40 messages and a level-2 summary, L2-x, holding text and naming an
      // L1 that isn't there, so the next load's repair drops it.
      const seed = new AutobiographicalStrategy({ adaptiveResolution: true, hierarchical: true, autoTickOnNewMessage: false, auditOnly: true });
      const seeded = await ContextManager.open({ path, namespace: 'agents/agent', strategy: seed, membrane });
      const ids: string[] = [];
      for (let i = 0; i < 40; i++) {
        ids.push(seeded.addMessage(i % 2 ? 'agent' : 'user', [{ type: 'text', text: `message ${i} ` + 'w '.repeat(20) }]));
      }
      const internals = seed as unknown as { store: { setStateJson(id: string, value: unknown): void }; summariesStateId: string };
      internals.store.setStateJson(internals.summariesStateId, [
        { id: 'L1-a', level: 1, content: 's L1-a', tokens: 50, sourceLevel: 0, sourceIds: ids.slice(4, 14), sourceRange: { first: ids[4], last: ids[13] }, created: 1 },
        { id: 'L2-x', level: 2, content: 's L2-x', tokens: 50, sourceLevel: 1, sourceIds: ['L1-a', 'L1-gone'], sourceRange: { first: ids[4], last: ids[33] }, created: 1 },
      ]);
      seeded.close();

      const strategy = new AutobiographicalStrategy({ adaptiveResolution: true, hierarchical: true, autoTickOnNewMessage: false });
      const manager = await ContextManager.open({ path, namespace: 'agents/agent', strategy, membrane });
      try {
        const latest = strategy.getLatestLoadRepairReport();
        expect(latest?.dropped.map((d) => [d.id, d.reason])).toEqual([['L2-x', 'names-missing']]);
        const sent: Array<{ kind: string; agent: string; message: string; data?: Record<string, unknown> }> = [];
        const framework = {
          sent,
          notifyOps(kind: string, agent: string, message: string, data?: Record<string, unknown>) {
            this.sent.push({ kind, agent, message, data });
          },
        };
        expect(wireLoadRepairAlert(strategy, framework, 'agent', path)).toBe(true);
        const alert = loadRepairAlert(latest!, 'agent', path);
        expect(sent).toEqual([{ kind: LOAD_REPAIR_KIND, agent: 'agent', message: alert.message, data: alert.data }]);
        // Handed over once: nothing is held for a later handler.
        expect(wireLoadRepairAlert(strategy, framework, 'agent', path)).toBe(true);
        expect(sent).toHaveLength(1);
      } finally {
        manager.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the health snapshot', () => {
  // An agent with no `latest` has a strategy without the getter, as on a
  // context-manager that doesn't report load repairs.
  function appWith(agents: Array<{ name: string; latest?: () => unknown }>): PanelAppRef {
    const framework = {
      agents: agents.map((a) => ({
        name: a.name,
        getContextManager: () => ({ getStrategy: () => (a.latest ? { getLatestLoadRepairReport: a.latest } : {}) }),
      })),
      healthSnapshot: () => ({ agents: agents.map((a) => ({ name: a.name })) }),
      getAllAgents() { return this.agents; },
    };
    return { framework, recipe: {} } as unknown as PanelAppRef;
  }

  test("carries each agent's latest load-repair report, and none for an agent whose loads dropped nothing", () => {
    const snapshot = buildHealthSnapshot(appWith([
      { name: 'alice', latest: () => cascade },
      { name: 'bo', latest: () => null },
    ]));
    expect(snapshot.loadRepair).toEqual({ alice: cascade });
  });

  test("an agent whose strategy has no getter has no entry and no read failure", () => {
    const snapshot = buildHealthSnapshot(appWith([{ name: 'alice', latest: () => cascade }, { name: 'bo' }]));
    expect(snapshot.loadRepair).toEqual({ alice: cascade });
    expect(snapshot.readFailures).toBeUndefined();
  });

  test('each snapshot reads the latest report afresh, so a newer one replaces the older', () => {
    let latest: LoadRepairReport = cascade;
    const app = appWith([{ name: 'alice', latest: () => latest }]);
    expect(buildHealthSnapshot(app).loadRepair).toEqual({ alice: cascade });
    latest = report([drop('later', 1, '2026-10-09T10:00:00Z', '2026-10-09T11:00:00Z')], { sequenceBefore: 50001 });
    expect(buildHealthSnapshot(app).loadRepair).toEqual({ alice: latest });
  });

  test('a read that throws is named in readFailures, and the others are still reported', () => {
    const snapshot = buildHealthSnapshot(appWith([
      { name: 'alice', latest: () => cascade },
      { name: 'bo', latest: () => { throw new Error('context manager is not initialized'); } },
    ]));
    expect(snapshot.loadRepair).toEqual({ alice: cascade });
    expect(snapshot.readFailures).toEqual({ bo: { loadRepair: 'context manager is not initialized' } });
  });

  test("an observer without 'ops' still gets the report's names, ids, reasons and times, but not its branch", () => {
    const snapshot = buildHealthSnapshot(appWith([{ name: 'alice', latest: () => ({ ...cascade, branch: 'restore-before-the-move-1792' }) }]));
    const sent = JSON.parse(JSON.stringify(keepNamedStrings(snapshot, HEALTH_STRINGS))) as { loadRepair: Record<string, LoadRepairReport> };
    // HEALTH_STRINGS is what /healthz keeps for an observer without ops; it
    // leaves the branch out, since a checkpoint's restore names its branch
    // after the checkpoint.
    expect(sent.loadRepair).toEqual({ alice: { ...cascade, branch: '' } });
    expect(loadRepairReadBack(sent.loadRepair.alice!)).toContain("open it with Chronicle's JsStore.open({ path }), switch to the branch the repair ran on, which /healthz shows an observer with the ops scope, then getStateJsonAt(");
  });
});
