import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { SubagentModule, type ActiveSubagent } from '../src/modules/subagent-module.js';

const T0 = Date.UTC(2026, 9, 23, 14, 5, 9);

type StoredRow = { window: string; participant: string; content: Array<{ type: 'text'; text: string }>; metadata: Record<string, unknown> };

const FLEET = 'system_context:subagent-fleet';
const markFor = (agent: string, contentHash: string, namespace = 'subagent-fleet') => ({
  system: true, kind: 'context-injection', contextInjection: { agent, namespace, contentHash, part: 0, parts: 1 },
});

function fleet(timeZone = 'UTC', stored: StoredRow[] = [], opts: { primary?: true } = {}) {
  const residents = new Set(['resident', 'other']);
  const registered = new Set(residents);
  const windowOf = (agent: string) => (residents.has(agent) ? 'residents' : agent);
  const mod = new SubagentModule({ provider: 'mock', timeZone, ...(opts.primary ? { parentAgentName: 'resident' } : {}) });
  let hudEnabled = true;
  (mod as unknown as { ctx: unknown }).ctx = {
    getAgents: () => [...registered].map((name) => ({ name, model: 'mock', status: 'idle' })),
    getState: () => ({ hudEnabled }),
    setState: () => {},
    queryMessages: (filter: { participant?: string }, opts?: { forAgent?: string }) => {
      const window = windowOf(opts?.forAgent ?? 'resident');
      const messages = stored.filter((row) => row.window === window && row.participant === filter.participant);
      return { messages, totalCount: messages.length };
    },
  };
  const add = (name: string, fields: Partial<ActiveSubagent> = {}): ActiveSubagent => {
    const entry: ActiveSubagent = {
      name, type: 'spawn', task: `task for ${name}`, status: 'running',
      startedAt: T0, lastActivityAt: T0, toolCallsCount: 0, findingsCount: 0, ...fields,
    };
    mod.activeSubagents.set(`entry-${name}`, entry);
    mod.parentMap.set(name, 'resident');
    return entry;
  };
  const textOf = async (agent: string): Promise<string | undefined> =>
    ((await mod.gatherContext(agent))[0]?.content[0] as { text: string } | undefined)?.text;
  const status = async (agent = 'resident', shards = 1): Promise<string | undefined> => {
    const injections = await mod.gatherContext(agent);
    expect(injections.length).toBeLessThanOrEqual(1);
    const injection = injections[0];
    if (injection) expect(injection.position).toBe('afterUser');
    const text = (injection?.content[0] as { text: string } | undefined)?.text;
    const mine = stored.filter((row) => row.window === windowOf(agent) && (row.metadata.contextInjection as { agent: string } | undefined)?.agent === agent);
    const newestHash = (mine.at(-1)?.metadata.contextInjection as { contentHash: string } | undefined)?.contentHash;
    const newest = mine.filter((row) => (row.metadata.contextInjection as { contentHash: string }).contentHash === newestHash)
      .map((row) => row.content[0]!.text).join('\n');
    if (text !== undefined && newest !== text) {
      const lines = text.split('\n');
      const size = Math.ceil(lines.length / shards);
      const hash = `h${stored.length}`;
      for (let i = 0; i < lines.length; i += size) {
        stored.push({
          window: windowOf(agent), participant: `system_context:${injection!.namespace}`,
          content: [{ type: 'text', text: lines.slice(i, i + size).join('\n') }], metadata: markFor(agent, hash, injection!.namespace),
        });
      }
    }
    return text;
  };
  const handles = (mod as unknown as { asyncHandles: Map<string, unknown> }).asyncHandles;
  const hud = (on: boolean) => { hudEnabled = on; };
  const internals = mod as unknown as { liveSubagents: Map<string, unknown>; runOfAttempt: Map<string, string> };
  const live = (name: string, frameworkAgentName: string) => {
    internals.runOfAttempt.set(frameworkAgentName, name);
    internals.liveSubagents.set(name, { frameworkAgentName, activeCallIds: new Set() });
  };
  const unlive = (name: string) => { internals.liveSubagents.delete(name); };
  const ended = (name: string) => {
    unlive(name);
    for (const [attempt, run] of internals.runOfAttempt) if (run === name) internals.runOfAttempt.delete(attempt);
  };
  const claim = (name: string, launcher: string) => {
    (mod as unknown as { claimName(name: string, parent: string): void }).claimName(name, launcher);
  };
  return { mod, add, status, preview: textOf, stored, handles, hud, registered, live, unlive, ended, claim };
}

afterEach(() => { setSystemTime(); });

describe('the fleet status', () => {
  test('a running subagent\'s status reads the same at every start', async () => {
    const f = fleet();
    f.add('scout');
    setSystemTime(new Date(T0 + 5_000));
    const first = await f.status();
    setSystemTime(new Date(T0 + 95_000));
    expect(await f.status()).toBe(first);
    expect(first).toBe('[Fleet Status, as of 2026-10-23 14:05:09 UTC]\n  scout [spawn] running since 14:05:09 parent:resident "task for scout"');
  });

  test('a run that ends leaves the list, and its end moves the "as of"', async () => {
    const f = fleet();
    const scout = f.add('scout');
    f.add('miner', { startedAt: T0 + 60_000 });
    const before = await f.status();
    scout.status = 'completed';
    scout.completedAt = T0 + 125_000;
    scout.toolCallsCount = 7;
    const after = await f.status();
    expect(after).not.toBe(before);
    expect(after).toBe('[Fleet Status, as of 2026-10-23 14:07:14 UTC]\n  miner [spawn] running since 14:06:09 parent:resident "task for miner"');
  });

  test('failed and stopped runs leave the list as a completed one does', async () => {
    const f = fleet();
    f.add('scout', { status: 'failed', completedAt: T0 + 3_000 });
    f.add('miner', { status: 'cancelled', completedAt: T0 + 4_000 });
    f.add('clerk');
    expect(await f.status()).toBe('[Fleet Status, as of 2026-10-23 14:05:13 UTC]\n  clerk [spawn] running since 14:05:09 parent:resident "task for clerk"');
  });

  test('when the last run ends, the status says none is running once, so no copy listing it is the newest', async () => {
    const f = fleet();
    const scout = f.add('scout');
    expect(await f.status()).toContain('scout [spawn] running since');
    scout.status = 'completed';
    scout.completedAt = T0 + 30_000;
    expect(await f.status()).toBe('[Fleet Status, as of 2026-10-23 14:05:39 UTC]\n  (none running)');
    expect(await f.status()).toBeUndefined();
    expect(f.stored).toHaveLength(2);
  });

  test('a run that ended with no status ever listing it has nothing to tell', async () => {
    const f = fleet();
    f.add('scout', { status: 'completed', completedAt: T0 + 30_000 });
    expect(await f.status()).toBeUndefined();
  });

  test('a fleet that never started a subagent has no status at all', async () => {
    expect(await fleet().status()).toBeUndefined();
  });

  test('however many runs have ended, the status lists only the running ones', async () => {
    const f = fleet();
    for (let i = 0; i < 300; i++) f.add(`done-${i}`, { status: 'completed', completedAt: T0 + i * 1000 });
    f.add('scout', { startedAt: T0 + 400_000 });
    const text = (await f.status())!;
    expect(text.split('\n')).toHaveLength(2);
    expect(text).toContain('scout [spawn] running since 14:11:49');
  });

  test('its clock times read in the recipe\'s zone, which the heading names', async () => {
    const f = fleet('Europe/Berlin');
    f.add('scout');
    expect(await f.status()).toStartWith('[Fleet Status, as of 2026-10-23 16:05:09 Europe/Berlin]\n  scout [spawn] running since 16:05:09 ');
  });

  test('the "as of" carries its date, so a status read days later says which day it was', async () => {
    const f = fleet();
    f.add('scout');
    setSystemTime(new Date(T0 + 3 * 86_400_000));
    expect(await f.status()).toBe('[Fleet Status, as of 2026-10-23 14:05:09 UTC]\n  scout [spawn] running since 14:05:09 parent:resident "task for scout"');
  });

  test('a run started on an earlier day than the "as of", in the recipe\'s zone, shows its date', async () => {
    const f = fleet('Europe/Berlin');
    f.add('night', { startedAt: Date.UTC(2026, 9, 22, 21, 59, 50) });
    f.add('dawn', { startedAt: Date.UTC(2026, 9, 22, 22, 0, 5) });
    expect(await f.status()).toBe([
      '[Fleet Status, as of 2026-10-23 00:00:05 Europe/Berlin]',
      '  night [spawn] running since 2026-10-22 23:59:50 parent:resident "task for night"',
      '  dawn [spawn] running since 00:00:05 parent:resident "task for dawn"',
    ].join('\n'));
  });

  test('a run started the same day in the recipe\'s zone keeps the bare time, though it was an earlier day in UTC', async () => {
    const f = fleet('America/Los_Angeles');
    f.add('afternoon', { startedAt: Date.UTC(2026, 9, 22, 23, 30, 0) });
    f.add('evening', { startedAt: Date.UTC(2026, 9, 23, 0, 30, 0) });
    expect(await f.status()).toBe([
      '[Fleet Status, as of 2026-10-22 17:30:00 America/Los_Angeles]',
      '  afternoon [spawn] running since 16:30:00 parent:resident "task for afternoon"',
      '  evening [spawn] running since 17:30:00 parent:resident "task for evening"',
    ].join('\n'));
  });

  test('a running spawn isn\'t listed again as waiting beside a finished fork of its name', async () => {
    const f = fleet();
    f.mod.activeSubagents.set('later', {
      name: 'later', type: 'fork', task: 'the fork', status: 'completed',
      startedAt: T0, completedAt: T0 + 1_000, lastActivityAt: T0, toolCallsCount: 0, findingsCount: 0,
    });
    f.mod.activeSubagents.set('spawn-later', {
      name: 'later', type: 'spawn', task: 'task for later', status: 'running',
      startedAt: T0 + 2_000, lastActivityAt: T0, toolCallsCount: 0, findingsCount: 0,
    });
    f.handles.set('later', {});
    f.mod.parentMap.set('later', 'resident');
    expect(await f.status()).toBe('[Fleet Status, as of 2026-10-23 14:05:11 UTC]\n  later [spawn] running since 14:05:11 parent:resident "task for later"');
  });

  test('a running fork isn\'t listed again as waiting beside its own async handle, and a finished one doesn\'t hide a run waiting under its name', async () => {
    const f = fleet();
    const fork = f.add('later', { type: 'fork' });
    f.mod.activeSubagents.delete('entry-later');
    f.mod.activeSubagents.set('later', fork);
    f.handles.set('later', {});
    expect(await f.status()).toBe('[Fleet Status, as of 2026-10-23 14:05:09 UTC]\n  later [fork] running since 14:05:09 parent:resident "task for later"');
    fork.status = 'completed';
    fork.completedAt = T0 + 1_000;
    expect(await f.status()).toBe('[Fleet Status, as of 2026-10-23 14:05:10 UTC]\n  later [async] pending');
  });

  test('a run whose name begins as the heading does still counts as a run', async () => {
    const f = fleet();
    const odd = f.add('[Fleet Status audit]');
    expect(await f.status()).toContain('[Fleet Status audit] [spawn] running since');
    odd.status = 'completed';
    odd.completedAt = T0 + 30_000;
    expect(await f.status()).toBe('[Fleet Status, as of 2026-10-23 14:05:39 UTC]\n  (none running)');
  });

  test('a run whose launcher has ended stays in the primary\'s status until it ends', async () => {
    const f = fleet('UTC', [], { primary: true });
    const lead = f.add('lead');
    f.live('lead', 'lead-d1-1');
    f.registered.add('lead-d1-1');
    const kid = f.add('kid');
    f.claim('kid', 'lead-d1-1');
    expect(await f.status()).toBe([
      '[Fleet Status, as of 2026-10-23 14:05:09 UTC]',
      '  lead [spawn] running since 14:05:09 parent:resident "task for lead"',
      '  kid [spawn] running since 14:05:09 parent:lead "task for kid"',
    ].join('\n'));
    lead.status = 'completed';
    lead.completedAt = T0 + 10_000;
    f.ended('lead');
    f.registered.delete('lead-d1-1');
    expect(await f.status()).toBe('[Fleet Status, as of 2026-10-23 14:05:19 UTC]\n  kid [spawn] running since 14:05:09 parent:lead "task for kid"');
    expect(await f.status('other')).toBeUndefined();
    kid.status = 'completed';
    kid.completedAt = T0 + 30_000;
    expect(await f.status()).toBe('[Fleet Status, as of 2026-10-23 14:05:39 UTC]\n  (none running)');
  });

  test('a run\'s parent label names its launcher by its display name, as the result\'s line does', async () => {
    const f = fleet();
    f.add('lead');
    f.live('lead', 'spawn-lead-1761271234567');
    f.add('kid');
    f.claim('kid', 'spawn-lead-1761271234567');
    f.add('spawn-x', { type: 'fork' });
    f.live('spawn-x', 'spawn-x-d1-1761271234569');
    f.add('kit');
    f.claim('kit', 'spawn-x-d1-1761271234569');
    const text = (await f.status())!;
    expect(text).toContain('  kid [spawn] running since 14:05:09 parent:lead "task for kid"');
    expect(text).toContain('  kit [spawn] running since 14:05:09 parent:spawn-x "task for kit"');
  });

  test('the primary\'s status takes no run whose launcher is listed, or whose launcher\'s run goes on', async () => {
    const f = fleet('UTC', [], { primary: true });
    f.add('theirs');
    f.mod.parentMap.set('theirs', 'other');
    f.add('lead');
    f.mod.parentMap.set('lead', 'other');
    f.live('lead', 'lead-d1-1');
    f.add('kid');
    f.mod.parentMap.set('kid', 'lead-d1-1');
    expect(await f.status()).toBeUndefined();
    expect(await f.status('other')).toContain('kid [spawn] running since');
  });

  test('a child an earlier attempt of a retried run launched stays in that run\'s tree, between attempts too', async () => {
    const f = fleet('UTC', [], { primary: true });
    const attempts = (f.mod as unknown as { runOfAttempt: Map<string, string> }).runOfAttempt;
    f.add('lead');
    f.mod.parentMap.set('lead', 'other');
    attempts.set('lead-d1-1', 'lead');
    f.live('lead', 'lead-d1-retry1-2');
    f.registered.add('lead-d1-retry1-2');
    f.add('kid');
    f.claim('kid', 'lead-d1-1');
    expect(await f.status('other')).toContain('  kid [spawn] running since 14:05:09 parent:lead "task for kid"');
    expect(await f.status()).toBeUndefined();
    expect(await f.status('lead-d1-retry1-2')).toContain('  kid [spawn] running since');
    f.unlive('lead');
    f.registered.delete('lead-d1-retry1-2');
    expect(await f.status('other')).toContain('kid [spawn] running since');
    expect(await f.status()).toBeUndefined();
  });

  test('the runs under an orphaned run still under way are the primary\'s too', async () => {
    const f = fleet('UTC', [], { primary: true });
    f.live('gone', 'gone-d1-1');
    f.add('kid');
    f.claim('kid', 'gone-d1-1');
    f.ended('gone');
    f.live('kid', 'kid-d2-5');
    f.add('grandkid');
    f.claim('grandkid', 'kid-d2-5');
    const text = (await f.status())!;
    expect(text).toContain('  kid [spawn] running since 14:05:09 parent:gone "task for kid"');
    expect(text).toContain('  grandkid [spawn] running since 14:05:09 parent:kid "task for grandkid"');
  });

  test('an ended launcher is labelled by the name it had as it launched the run, whatever its attempt\'s stamp', async () => {
    const f = fleet('UTC', [], { primary: true });
    f.live('lead', 'spawn-lead-1761271234567');
    f.add('kid');
    f.claim('kid', 'spawn-lead-1761271234567');
    f.live('scout', 'scout-d1-retry1-1761271234568');
    f.add('kin');
    f.claim('kin', 'scout-d1-retry1-1761271234568');
    f.ended('lead');
    f.ended('scout');
    const text = (await f.status())!;
    expect(text).toContain('  kid [spawn] running since 14:05:09 parent:lead "task for kid"');
    expect(text).toContain('  kin [spawn] running since 14:05:09 parent:scout "task for kin"');
  });

  test('the primary\'s read walks the links once per orphan going on, however many orphans have finished', async () => {
    class Walked<K, V> extends Map<K, V> {
      walks = 0;
      override [Symbol.iterator]() { this.walks++; return super[Symbol.iterator](); }
    }
    const walksWith = async (finished: number): Promise<number> => {
      const f = fleet('UTC', [], { primary: true });
      const links = new Walked<string, string>();
      (f.mod as unknown as { parentMap: Map<string, string> }).parentMap = links;
      for (let i = 0; i < finished; i++) {
        f.add(`old${i}`, { status: 'completed', completedAt: T0 + 1_000 });
        links.set(`old${i}`, `gone${i}-d1-${i}`);
      }
      f.live('gone', 'gone-d1-1');
      f.add('kid');
      f.claim('kid', 'gone-d1-1');
      f.ended('gone');
      f.live('kid', 'kid-d2-5');
      links.walks = 0;
      expect(await f.status()).toContain('  kid [spawn] running since');
      return links.walks;
    };
    expect(await walksWith(40)).toBe(await walksWith(1));
  });

  test('a run restored without its launcher\'s record doesn\'t name the launcher it had before the restore', async () => {
    const restored = fleet('UTC', [], { primary: true });
    const its = restored.mod as unknown as { restoreFromStore(): void; ctx: { getState: () => unknown } };
    restored.live('scout', 'scout-d1-1761271234568');
    restored.claim('kid', 'scout-d1-1761271234568');
    restored.ended('scout');
    const running = () => restored.mod.activeSubagents.set('kid', { name: 'kid', type: 'spawn', task: 't', status: 'running', startedAt: T0, lastActivityAt: T0, toolCallsCount: 0, findingsCount: 0 });
    const kidLine = async () => (await restored.preview('resident'))?.split('\n').find((line) => line.startsWith('  kid '));
    running();
    expect(await kidLine()).toContain(' parent:scout');
    its.ctx.getState = () => ({ hudEnabled: true, agents: { kid: { name: 'kid', type: 'spawn', task: 't', status: 'running', startedAt: T0, toolCallsCount: 0, findingsCount: 0, parent: 'spawn-lead-1761271234567' } } });
    its.restoreFromStore();
    running();
    const restoredLine = await kidLine();
    expect(restoredLine).toBeDefined();
    expect(restoredLine).not.toContain(' parent:scout');
  });

  test('the runs under an orphaned run between its attempts stay the primary\'s', async () => {
    const f = fleet('UTC', [], { primary: true });
    f.add('kid');
    f.mod.parentMap.set('kid', 'gone-d1-1');
    f.live('kid', 'kid-d2-5');
    f.add('grandkid');
    f.mod.parentMap.set('grandkid', 'kid-d2-5');
    f.unlive('kid');
    const text = (await f.status())!;
    expect(text).toContain('  grandkid [spawn] running since');
  });

  for (const going of [false, true]) {
    test(`a ${going ? 'running' : 'finished'} run named like a resident doesn't bring that resident's runs into its launcher's view`, async () => {
      const f = fleet();
      f.add('resident', going ? {} : { status: 'completed', completedAt: T0 + 1_000 });
      f.mod.parentMap.set('resident', 'other');
      if (going) f.live('resident', 'spawn-resident-1761271234567');
      f.add('secret');
      expect((await f.status('other')) ?? '').not.toContain('secret');
      expect(await f.status()).toContain('  secret [spawn] running since');
    });
  }

  test('with the hud off, nothing is added, a stored status listing a run included', async () => {
    const f = fleet();
    const scout = f.add('scout');
    expect(await f.status()).toContain('scout [spawn] running since');
    f.hud(false);
    expect(await f.status()).toBeUndefined();
    scout.status = 'completed';
    scout.completedAt = T0 + 30_000;
    expect(await f.status()).toBeUndefined();
    expect(f.stored).toHaveLength(1);
  });

  test('a run waiting under the name of one that has finished is listed', async () => {
    const f = fleet();
    f.mod.activeSubagents.set('spawn-later', {
      name: 'later', type: 'spawn', task: 'task for later', status: 'completed',
      startedAt: T0, completedAt: T0 + 1_000, lastActivityAt: T0, toolCallsCount: 0, findingsCount: 0,
    });
    f.handles.set('later', {});
    f.mod.parentMap.set('later', 'resident');
    expect(await f.status()).toBe('[Fleet Status, as of 2026-10-23 14:05:10 UTC]\n  later [async] pending');
  });

  test('an agent whose status listed a run that ended before it started is told once that none is running', async () => {
    const f = fleet();
    f.handles.set('later', {});
    f.mod.parentMap.set('later', 'resident');
    expect(await f.status()).toBe('[Fleet Status]\n  later [async] pending');
    f.handles.delete('later');
    f.mod.parentMap.delete('later');
    expect(await f.status()).toBe('[Fleet Status]\n  (none running)');
    expect(await f.status()).toBeUndefined();
  });

  test('a preview, which stores nothing, leaves the next start to say none is running', async () => {
    const f = fleet();
    const scout = f.add('scout');
    await f.status();
    scout.status = 'completed';
    scout.completedAt = T0 + 30_000;
    expect(await f.preview('resident')).toBe('[Fleet Status, as of 2026-10-23 14:05:39 UTC]\n  (none running)');
    expect(await f.status()).toBe('[Fleet Status, as of 2026-10-23 14:05:39 UTC]\n  (none running)');
  });

  test('after a restart, a stored status listing a run that waited says none is running, once', async () => {
    const stored: StoredRow[] = [];
    const before = fleet('UTC', stored);
    before.handles.set('later', {});
    before.mod.parentMap.set('later', 'resident');
    expect(await before.status()).toBe('[Fleet Status]\n  later [async] pending');
    const after = fleet('UTC', stored);
    expect(await after.status()).toBe('[Fleet Status]\n  (none running)');
    expect(await after.status()).toBeUndefined();
  });

  test('a status stored in shards is judged by its newest row, its last shard, whose first line is a run\'s, not its heading', async () => {
    const f = fleet();
    const scout = f.add('scout');
    const miner = f.add('miner');
    expect(await f.status('resident', 2)).toContain('miner [spawn] running since');
    expect(f.stored.map((row) => row.content[0]!.text)).toEqual([
      '[Fleet Status, as of 2026-10-23 14:05:09 UTC]\n  scout [spawn] running since 14:05:09 parent:resident "task for scout"',
      '  miner [spawn] running since 14:05:09 parent:resident "task for miner"',
    ]);
    for (const run of [scout, miner]) { run.status = 'completed'; run.completedAt = T0 + 30_000; }
    expect(await f.status()).toBe('[Fleet Status, as of 2026-10-23 14:05:39 UTC]\n  (none running)');
  });

  test('a fork is told by the status in its own window, not the residents\'', async () => {
    const f = fleet();
    const scout = f.add('scout');
    f.mod.parentMap.set('scout', 'fork-a');
    expect(await f.status('fork-a')).toContain('scout [spawn] running since');
    expect(f.stored.map((row) => row.window)).toEqual(['fork-a']);
    scout.status = 'completed';
    scout.completedAt = T0 + 30_000;
    expect(await f.status('fork-a')).toBe('[Fleet Status, as of 2026-10-23 14:05:39 UTC]\n  (none running)');
  });

  test('a row that isn\'t the agent\'s own fleet status, by its mark, doesn\'t count', async () => {
    const f = fleet();
    const listing = [{ type: 'text' as const, text: '[Fleet Status]\n  scout [spawn] running since 14:05:09 parent:resident "t"' }];
    const mark = markFor('resident', 'h0');
    const { parts: _parts, ...noParts } = mark.contextInjection;
    f.stored.push(
      { window: 'residents', participant: FLEET, content: listing, metadata: { ...mark, contextInjection: { ...mark.contextInjection, namespace: 'retrieval' } } },
      { window: 'residents', participant: FLEET, content: listing, metadata: { ...mark, contextInjection: noParts } },
      { window: 'residents', participant: FLEET, content: listing, metadata: {} },
    );
    expect(await f.status()).toBeUndefined();
  });

  test('a window that can\'t be read makes the gather throw, which agent-framework\'s registry logs', async () => {
    const f = fleet();
    (f.mod as unknown as { ctx: { queryMessages: () => never } }).ctx.queryMessages = () => { throw new Error('store unavailable'); };
    await expect(f.mod.gatherContext('resident')).rejects.toThrow('store unavailable');
  });

  test('each agent is told by its own stored status, not another\'s', async () => {
    const f = fleet();
    const scout = f.add('scout');
    await f.status('resident');
    scout.status = 'completed';
    scout.completedAt = T0 + 30_000;
    expect(await f.status('other')).toBeUndefined();
    expect(await f.status('resident')).toBe('[Fleet Status, as of 2026-10-23 14:05:39 UTC]\n  (none running)');
  });

  test('an agent\'s older status is found past another agent\'s newer one in the slot they share', async () => {
    const f = fleet();
    const scout = f.add('scout');
    await f.status('resident');
    f.add('theirs');
    f.mod.parentMap.set('theirs', 'other');
    expect(await f.status('other')).toContain('theirs [spawn] running since');
    scout.status = 'completed';
    scout.completedAt = T0 + 30_000;
    expect(await f.status('resident')).toBe('[Fleet Status, as of 2026-10-23 14:05:39 UTC]\n  (none running)');
  });
});

describe('the hud setting', () => {
  test('stays on across a lifecycle transition, whose state write replaces the module\'s state', async () => {
    const mod = new SubagentModule({ provider: 'mock', timeZone: 'UTC' });
    let state: Record<string, unknown> = {};
    (mod as unknown as { ctx: unknown }).ctx = {
      getState: () => state,
      setState: (next: Record<string, unknown>) => { state = next; },
    };
    await mod.handleToolCall({ id: 't1', name: 'hud', input: { enabled: true } } as never);
    mod.activeSubagents.set('entry-scout', {
      name: 'scout', type: 'spawn', task: 'task for scout', status: 'running',
      startedAt: T0, lastActivityAt: T0, toolCallsCount: 0, findingsCount: 0,
    });
    mod.parentMap.set('scout', 'resident');
    (mod as unknown as { persistState: () => void }).persistState();
    expect(state.hudEnabled).toBe(true);
    const text = ((await mod.gatherContext('resident'))[0]?.content[0] as { text: string } | undefined)?.text;
    expect(text).toContain('scout [spawn] running since');
  });
});

describe('an async run\'s result', () => {
  function delivering(registered: string[]) {
    const mod = new SubagentModule({ provider: 'mock', timeZone: 'UTC', parentAgentName: 'resident' });
    const written: Array<{ text: string; forAgent?: string }> = [];
    const woken: string[] = [];
    (mod as unknown as { ctx: unknown }).ctx = {
      getAgents: () => registered.map((name) => ({ name, model: 'mock', status: 'idle' })),
      addMessage: (_participant: string, content: Array<{ text: string }>, _metadata?: unknown, opts?: { forAgent?: string }) => {
        if (opts?.forAgent !== undefined && (opts.forAgent === '' || !registered.includes(opts.forAgent))) throw new Error(`Unknown agent: "${opts.forAgent}"`);
        written.push({ text: content[0]!.text, ...(opts?.forAgent !== undefined ? { forAgent: opts.forAgent } : {}) });
        return 'm1';
      },
      pushEvent: (event: { type: string; agentName?: string }) => { if (event.type === 'inference-request' && event.agentName) woken.push(event.agentName); },
    };
    const deliver = mod as unknown as {
      deliverAsyncResult: (name: string, result: { summary: string }, launcher: string | undefined, launcherShown?: string) => void;
      deliverAsyncError: (name: string, err: unknown, launcher: string | undefined, launcherShown?: string) => void;
    };
    return { written, woken, deliver, mod, registered };
  }

  test('lands in the window of the agent that launched it, naming a launcher that isn\'t the primary', () => {
    const d = delivering(['resident', 'fork-y']);
    d.deliver.deliverAsyncResult('scout', { summary: 'done' }, 'fork-y');
    d.deliver.deliverAsyncError('miner', new Error('broke'), 'fork-y');
    d.deliver.deliverAsyncResult('lead', { summary: 'mine' }, 'resident');
    expect(d.written).toEqual([
      { text: "[Subagent 'scout' returned, for 'fork-y']\n\ndone", forAgent: 'fork-y' },
      { text: "[Subagent 'miner' failed, for 'fork-y']\n\nError: broke", forAgent: 'fork-y' },
      { text: "[Subagent 'lead' returned]\n\nmine", forAgent: 'resident' },
    ]);
    expect(d.woken).toEqual(['fork-y', 'fork-y', 'resident']);
  });

  test('whose launching attempt has ended while its run goes on goes to the run\'s current attempt, or between attempts to the primary', () => {
    const d = delivering(['resident', 'lead-d1-retry1-2']);
    const mod = d.mod as unknown as { runOfAttempt: Map<string, string>; liveSubagents: Map<string, unknown> };
    mod.runOfAttempt.set('lead-d1-1', 'lead');
    mod.runOfAttempt.set('lead-d1-retry1-2', 'lead');
    mod.liveSubagents.set('lead', { frameworkAgentName: 'lead-d1-retry1-2', activeCallIds: new Set() });
    d.deliver.deliverAsyncResult('kid', { summary: 'done' }, 'lead-d1-1', 'lead');
    d.deliver.deliverAsyncError('kit', new Error('broke'), 'lead-d1-1', 'lead');
    d.registered.splice(d.registered.indexOf('lead-d1-retry1-2'), 1);
    d.deliver.deliverAsyncResult('kip', { summary: 'done too' }, 'lead-d1-1', 'lead');
    mod.liveSubagents.delete('lead');
    d.deliver.deliverAsyncError('kin', new Error('broke'), 'lead-d1-1', 'lead');
    expect(d.written).toEqual([
      { text: "[Subagent 'kid' returned, for 'lead': launched by an earlier attempt]\n\ndone", forAgent: 'lead-d1-retry1-2' },
      { text: "[Subagent 'kit' failed, for 'lead': launched by an earlier attempt]\n\nError: broke", forAgent: 'lead-d1-retry1-2' },
      { text: "[Subagent 'kip' returned, for 'lead': launched by an attempt that has ended]\n\ndone too" },
      { text: "[Subagent 'kin' failed, for 'lead': launched by an attempt that has ended]\n\nError: broke" },
    ]);
    expect(d.woken).toEqual(['lead-d1-retry1-2', 'lead-d1-retry1-2']);
  });

  test('whose launcher has ended lands in the residents\' slot, naming whom it was for', () => {
    const d = delivering(['resident']);
    d.deliver.deliverAsyncResult('scout', { summary: 'done' }, 'fork-y');
    d.deliver.deliverAsyncError('miner', new Error('broke'), 'fork-y');
    expect(d.written).toEqual([
      { text: "[Subagent 'scout' returned, for 'fork-y', which has ended]\n\ndone" },
      { text: "[Subagent 'miner' failed, for 'fork-y', which has ended]\n\nError: broke" },
    ]);
    expect(d.woken).toEqual([]);
  });

  test('with no launcher named lands in the residents\' slot as before', () => {
    const d = delivering(['resident']);
    d.deliver.deliverAsyncResult('scout', { summary: 'done' }, undefined);
    expect(d.written).toEqual([{ text: "[Subagent 'scout' returned]\n\ndone" }]);
  });

  test('with the empty name as its launcher lands in the residents\' slot, as with none, even where an agent is registered under it', () => {
    const d = delivering(['resident', '']);
    d.deliver.deliverAsyncResult('scout', { summary: 'done' }, '');
    expect(d.written).toEqual([{ text: "[Subagent 'scout' returned]\n\ndone" }]);
  });

  test('a write that fails for another reason throws, as before', () => {
    const d = delivering(['resident', 'fork-y']);
    (d.deliver as unknown as { ctx: { addMessage: () => never } }).ctx.addMessage = () => { throw new Error('store unavailable'); };
    expect(() => d.deliver.deliverAsyncResult('scout', { summary: 'done' }, 'fork-y')).toThrow('store unavailable');
  });
});
