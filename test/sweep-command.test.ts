import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework, asOwnRow } from '@animalabs/agent-framework';
import type { StoredMessage } from '@animalabs/context-manager';
import type { NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { createBranchState, handleCommand, handleSweep } from '../src/commands.js';
import { trackOperatorWork } from '../src/session-switch.js';
import type { Sweep } from '../src/sweeps.js';

const OLD = 'ZQ-OLD-WORDS';
const text = (t: string) => [{ type: 'text' as const, text: t }];
const said = (r: { lines: Array<{ text: string }> }) => r.lines.map((l) => l.text).join('\n');
const textOf = (row: StoredMessage) => row.content.map((b) => ('text' in b ? String(b.text) : '')).join('');

const notes: Sweep = {
  name: 'test-notes',
  line: 'Rewrites the test notes.',
  rewrite(row) {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    if (meta.system !== true || meta.kind !== 'test-note' || !textOf(row).includes(OLD)) return null;
    return { kind: 'test note', text: `[test-note] New words for note ${String(meta.n)}.` };
  },
};

function reply(t: string): NormalizedResponse {
  return {
    content: text(t), stopReason: 'end_turn', rawAssistantText: t, toolCalls: [], toolResults: [],
    usage: { inputTokens: 10, outputTokens: 5 },
    details: { raw: {}, stop: { reason: 'end_turn', wasTruncated: false }, model: { requested: 'test-model', actual: 'test-model' } },
  } as unknown as NormalizedResponse;
}

function provider() {
  const requests: NormalizedRequest[] = [];
  let held: { system: string; released: Promise<void>; started: () => void } | undefined;
  const stream = (response: NormalizedResponse, wait?: Promise<void>): YieldingStream => ({
    async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
      if (wait) await wait;
      const t = response.rawAssistantText;
      yield { type: 'block', event: { event: 'block_start', index: 0, block: { type: 'text' } } } as StreamEvent;
      yield { type: 'tokens', content: t, meta: { type: 'text', visible: true, blockIndex: 0 } } as StreamEvent;
      yield { type: 'block', event: { event: 'block_complete', index: 0, block: { type: 'text', content: t } } } as StreamEvent;
      yield { type: 'usage', usage: response.usage } as StreamEvent;
      yield { type: 'complete', response } as StreamEvent;
    },
    provideToolResults() { throw new Error('Not waiting for tools'); },
    cancel() {},
    isWaitingForTools: false,
    pendingToolCallIds: [],
  } as unknown as YieldingStream);
  const membrane = {
    async complete(): Promise<NormalizedResponse> { return reply('done'); },
    async stream(): Promise<NormalizedResponse> { return reply('done'); },
    streamYielding(request: NormalizedRequest): YieldingStream {
      requests.push(structuredClone(request));
      if (held && JSON.stringify(request.system ?? '').includes(held.system)) {
        const { released, started } = held;
        held = undefined;
        started();
        return stream(reply('answers late'), released);
      }
      return stream(reply('answers'));
    },
  };
  const holdFor = (system: string) => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const streaming = new Promise<void>((resolve) => { started = resolve; });
    held = { system, released, started };
    return { streaming, release };
  };
  return { membrane, requests, holdFor };
}

setDefaultTimeout(30_000);

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

async function host() {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-command-'));
  const { membrane, requests, holdFor } = provider();
  const storePath = join(dir, 'store');
  const framework = await AgentFramework.create({
    storePath,
    membrane: membrane as never,
    agents: [
      { name: 'a', model: 'test-model', systemPrompt: 'You are a.' },
      { name: 'b', model: 'test-model', systemPrompt: 'You are b.' },
    ],
    modules: [],
  });
  cleanup = async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); };
  const agent = (name: string) => framework.getAgent(name)!;
  const note = (owner: string, n: number, words = `[test-note] ${OLD} for note ${n}.`): string => {
    const id = String(agent(owner).getContextManager().addMessage('user', text(words), asOwnRow({ system: true, kind: 'test-note', n }, owner)));
    agent(owner).ownRowsStored([id as never]);
    return id;
  };
  const rowText = (owner: string, id: string) => textOf(agent(owner).getContextManager().getMessage(id as never)!);
  const sessions = [{ id: 'open', name: 'open' }];
  const sessionManager = { listSessions: () => sessions, getActiveSession: () => sessions[0] };
  const app = { framework, branchState: createBranchState(), agentName: 'a', userMessageCount: 0, sessionManager } as never;
  const sweep = (...args: string[]) => handleSweep(app, args, { via: 'test' }, [notes]);
  const turn = async (name: string) => { framework.nudgeAgent(name, 'test'); await framework.runUntilIdle(); };
  const operatorLog = (): Array<Record<string, unknown>> => {
    try {
      return readFileSync(join(storePath, 'operator-actions.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  return { framework, app, requests, holdFor, agent, note, rowText, sweep, turn, operatorLog, sessions };
}

describe('/sweep, the list and its words', () => {
  test('with no name it lists the sweeps it is given, and the host\'s /sweep lists this release\'s', async () => {
    const h = await host();
    expect(said(h.sweep())).toContain('test-notes: Rewrites the test notes.');
    expect(said(handleCommand('/sweep', h.app))).toStartWith('The sweeps this release knows:\n  unstick-fix-11-16: ');
  });

  test('a name it doesn\'t know is refused, naming the sweeps it knows', async () => {
    const h = await host();
    const answer = h.sweep('other');
    expect(answer.refused).toBe(true);
    expect(said(answer)).toContain('No sweep is named other.');
    expect(said(answer)).toContain('test-notes');
  });

  test('a word other than --write, or a word after it, is refused as usage, and nothing is written', async () => {
    const h = await host();
    const id = h.note('a', 1);
    for (const words of [['test-notes', '--wirte'], ['test-notes', '--write', 'now']]) {
      const answer = h.sweep(...words);
      expect(answer.refused).toBe(true);
      expect(said(answer)).toContain('Usage: /sweep [<name> [--write]]');
    }
    expect(h.rowText('a', id)).toContain(OLD);
  });

  test('/help names /sweep', async () => {
    const h = await host();
    expect(said(handleCommand('/help', h.app))).toContain('/sweep [name [--write]]');
  });

  test('while a session switch is under way, /sweep with a name answers refused and writes nothing; another command\'s refusal stays unmarked', async () => {
    const h = await host();
    const id = h.note('a', 1);
    (h.app as { switching?: boolean }).switching = true;
    for (const command of ['/sweep test-notes --write', '/sweep test-notes']) {
      const answer = handleCommand(command, h.app);
      expect(answer.refused).toBe(true);
      expect(said(answer)).toContain('a session switch is under way');
    }
    expect(h.rowText('a', id)).toContain(OLD);
    const undo = handleCommand('/undo', h.app);
    expect(said(undo)).toContain('a session switch is under way');
    expect(undo.refused).toBeUndefined();
  });
});

describe('/sweep NAME shows, and writes nothing', () => {
  test('each row once, with its kind, its time, its window\'s agents, both lengths and its new text; then the cost', async () => {
    const h = await host();
    const id = h.note('a', 1);
    h.note('b', 2);
    h.agent('a').getContextManager().addMessage('user', text(`a person's words, ${OLD}`), {});
    const answer = h.sweep('test-notes');
    const out = said(answer);
    expect(answer.refused).toBeUndefined();
    expect(out).toContain('would rewrite 2 rows. Nothing is written without --write.');
    expect(out.match(/New words for note 1\./g)?.length).toBe(1);
    expect(out).toContain('New words for note 2.');
    const stored = h.agent('a').getContextManager().getMessage(id as never)!;
    const line1 = answer.lines.map((l) => l.text).find((l) => l.includes('note 1.'))!;
    expect(line1).toContain(`test note row ${id} of `);
    expect(line1).toContain(new Date(stored.timestamp).toISOString());
    expect(line1).toContain(`${textOf(stored).length} characters now, ${'[test-note] New words for note 1.'.length} after`);
    expect(line1).toMatch(/in the window of [ab]/);
    expect(out).toMatch(/With --write, each of these agents has its prompt cache rewritten once, from its earliest row above: .*a \(from /);
    expect(h.rowText('a', id)).toContain(OLD);
    expect(h.operatorLog().filter((e) => e.kind === 'sweep')).toEqual([]);
  });

  test('a row no agent\'s window holds is listed for no agent, and the cost names no prompt cache', async () => {
    const h = await host();
    h.agent('a').getContextManager().addMessage('user', text(`[test-note] ${OLD} for note 1.`), asOwnRow({ system: true, kind: 'test-note', n: 1 }, 'a'));
    const out = said(h.sweep('test-notes'));
    expect(out).toContain('in the window of no agent');
    expect(out).toContain('No agent\'s window holds these rows, so --write rewrites no prompt cache.');
  });

  test('a row holding a block other than text isn\'t given to the sweep: it isn\'t listed, and --write leaves it', async () => {
    const h = await host();
    const cm = h.agent('a').getContextManager();
    const id = String(cm.addMessage('user', [{ type: 'thinking', thinking: 'zq-thought' }, ...text(`[test-note] ${OLD} for note 1.`)] as never,
      asOwnRow({ system: true, kind: 'test-note', n: 1 }, 'a')));
    expect(said(h.sweep('test-notes'))).toBe('Sweep test-notes finds no row to rewrite.');
    expect(said(h.sweep('test-notes', '--write'))).toBe('Sweep test-notes finds no row to rewrite.');
    expect(cm.getMessage(id as never)!.content.map((block) => block.type)).toEqual(['thinking', 'text']);
  });

  test('on a host with other sessions, the show, the write and a run that finds nothing each end saying the sweep reached the open session alone', async () => {
    const h = await host();
    const line = 'This host has 2 other sessions: the sweep reached the open session alone. Each other session takes its own run after a /session switch.';
    expect(said(h.sweep('test-notes'))).not.toContain('other session');
    h.sessions.push({ id: 'second', name: 'second' }, { id: 'third', name: 'third' });
    expect(said(h.sweep('test-notes')).split('\n').at(-1)).toBe(line);
    h.note('a', 1);
    expect(said(h.sweep('test-notes')).split('\n').at(-1)).toBe(line);
    expect(said(h.sweep('test-notes', '--write')).split('\n').at(-1)).toBe(line);
  });

  test('a row the sweep returns nothing for isn\'t listed, and with none it says so', async () => {
    const h = await host();
    h.agent('a').getContextManager().addMessage('user', text(`a person's words, ${OLD}`), {});
    h.note('a', 1, '[test-note] already new words.');
    expect(said(h.sweep('test-notes'))).toBe('Sweep test-notes finds no row to rewrite.');
  });
});

describe('/sweep NAME --write', () => {
  test('rewrites each row, the next request carries the new text and not the old, and the operator log records it', async () => {
    const h = await host();
    const id = h.note('a', 1);
    await h.turn('a');
    expect(JSON.stringify(h.requests.at(-1))).toContain(OLD);
    const answer = h.sweep('test-notes', '--write');
    expect(answer.refused).toBeUndefined();
    expect(said(answer)).toContain('Sweep test-notes rewrote 1 of 1 row.');
    expect(h.rowText('a', id)).toBe('[test-note] New words for note 1.');
    await h.turn('a');
    const next = JSON.stringify(h.requests.at(-1));
    expect(next).toContain('New words for note 1.');
    expect(next).not.toContain(OLD);
    const logged = h.operatorLog().filter((e) => e.kind === 'sweep');
    expect(logged.length).toBe(1);
    expect(logged[0]).toMatchObject({ requester: { via: 'test' }, params: { sweep: 'test-notes' }, result: { rewritten: 1, leftForTurns: 0, failed: 0 } });
  });

  test('a row of b\'s that a\'s manager lists first is edited through it, and b\'s next request carries the new text', async () => {
    const h = await host();
    const id = h.note('b', 2);
    await h.turn('b');
    expect(JSON.stringify(h.requests.at(-1))).toContain(OLD);
    expect(h.framework.getAllAgents().map((agent) => agent.name)).toEqual(['a', 'b']);
    expect(h.agent('a').getContextManager().getAllMessages().map((row) => String(row.id))).toContain(id);
    const edited: string[] = [];
    for (const name of ['a', 'b']) {
      const cm = h.agent(name).getContextManager();
      const edit = cm.editMessage.bind(cm);
      cm.editMessage = (rowId, content) => { edited.push(name); edit(rowId, content); };
    }
    const before = h.agent('b').getContextManager().getMessage(id as never)!;
    expect(said(h.sweep('test-notes', '--write'))).toContain('rewrote 1 of 1 row.');
    expect(edited).toEqual(['a']);
    const after = h.agent('b').getContextManager().getMessage(id as never)!;
    expect(after.metadata).toEqual(before.metadata);
    expect(after.timestamp).toEqual(before.timestamp);
    await h.turn('b');
    const next = JSON.stringify(h.requests.at(-1));
    expect(next).toContain('New words for note 2.');
    expect(next).not.toContain(OLD);
  });

  test('while a command that changes the session is still running, --write is refused and writes nothing; a run without --write still answers', async () => {
    const h = await host();
    const id = h.note('a', 1);
    let release!: () => void;
    const running = trackOperatorWork(h.app, '/newtopic', new Promise<void>((resolve) => { release = resolve; }));
    try {
      const answer = h.sweep('test-notes', '--write');
      expect(answer.refused).toBe(true);
      expect(said(answer)).toBe('Sweep test-notes wrote nothing, since /newtopic is still running. Run it again once /newtopic has finished.');
      const none = handleSweep(h.app, ['test-notes', '--write'], { via: 'test' }, [{ ...notes, rewrite: () => null }]);
      expect(none.refused).toBe(true);
      expect(said(none)).toContain('wrote nothing, since /newtopic is still running');
      expect(h.rowText('a', id)).toContain(OLD);
      expect(h.operatorLog().filter((e) => e.kind === 'sweep')).toEqual([]);
      expect(said(h.sweep('test-notes'))).toContain('would rewrite 1 row.');
    } finally {
      release();
      await running;
    }
    expect(said(h.sweep('test-notes', '--write'))).toContain('rewrote 1 of 1 row.');
  });

  test('a second run finds nothing to rewrite', async () => {
    const h = await host();
    h.note('a', 1);
    h.sweep('test-notes', '--write');
    expect(said(h.sweep('test-notes', '--write'))).toBe('Sweep test-notes finds no row to rewrite.');
  });

  test('a row in the window of an agent whose turn is alive is left and named; a run after the turn rewrites it', async () => {
    const h = await host();
    const id = h.note('a', 1);
    const held = h.holdFor('You are a.');
    h.framework.nudgeAgent('a', 'test');
    const turn = h.framework.runUntilIdle();
    await held.streaming;
    try {
      const answer = h.sweep('test-notes', '--write');
      expect(answer.refused).toBe(true);
      expect(said(answer)).toContain('rewrote 0 of 1 row.');
      expect(said(answer)).toContain('left as it was, since a turn of a is alive');
      expect(h.rowText('a', id)).toContain(OLD);
    } finally {
      held.release();
      await turn;
    }
    expect(said(h.sweep('test-notes', '--write'))).toContain('rewrote 1 of 1 row.');
    expect(h.rowText('a', id)).toBe('[test-note] New words for note 1.');
  });

  test('while one agent\'s turn is alive, a row in only another agent\'s window is rewritten', async () => {
    const h = await host();
    const ofA = h.note('a', 1);
    const ofB = h.note('b', 2);
    const held = h.holdFor('You are b.');
    h.framework.nudgeAgent('b', 'test');
    const turn = h.framework.runUntilIdle();
    await held.streaming;
    try {
      const answer = h.sweep('test-notes', '--write');
      expect(said(answer)).toContain('rewrote 1 of 2 rows.');
      expect(said(answer)).toContain('since a turn of b is alive');
      expect(h.rowText('a', ofA)).toBe('[test-note] New words for note 1.');
      expect(h.rowText('b', ofB)).toContain(OLD);
    } finally {
      held.release();
      await turn;
    }
  });

  test('a row whose edit fails is named, without saying it is unchanged, and the rest are rewritten', async () => {
    const h = await host();
    const first = h.note('a', 1);
    const second = h.note('a', 2);
    const cm = h.agent('a').getContextManager();
    const edit = cm.editMessage.bind(cm);
    cm.editMessage = (id, content) => {
      if (String(id) === first) throw new Error('the store refused this edit');
      edit(id, content);
    };
    const answer = h.sweep('test-notes', '--write');
    expect(answer.refused).toBe(true);
    expect(said(answer)).toContain('rewrote 1 of 2 rows.');
    expect(said(answer)).toContain('its edit failed, so it may or may not have changed');
    expect(answer.lines.map((l) => l.text).find((l) => l.includes('its edit failed'))).toContain(`row ${first} of `);
    expect(said(answer)).not.toContain('left as it was, since its edit failed');
    expect(said(answer)).toContain('the store refused this edit');
    expect(said(answer)).toContain('Run the sweep again without --write to see whether a row whose edit failed is still listed.');
    expect(h.rowText('a', first)).toContain(OLD);
    expect(h.rowText('a', second)).toBe('[test-note] New words for note 2.');
    expect(h.operatorLog().find((e) => e.kind === 'sweep')).toMatchObject({ result: { rewritten: 1, leftForTurns: 0, failed: 1 } });
  });
});

test('no answer holds a row\'s old text: the list, the write, a turn alive and a failed edit', async () => {
  const h = await host();
  const first = h.note('a', 1);
  h.note('a', 2);
  h.note('b', 3);
  const answers = [h.sweep('test-notes')];
  const cm = h.agent('a').getContextManager();
  const edit = cm.editMessage.bind(cm);
  cm.editMessage = (id, content) => {
    if (String(id) === first) throw new Error('the store refused this edit');
    edit(id, content);
  };
  const held = h.holdFor('You are b.');
  h.framework.nudgeAgent('b', 'test');
  const turn = h.framework.runUntilIdle();
  await held.streaming;
  try {
    answers.push(h.sweep('test-notes', '--write'));
  } finally {
    held.release();
    await turn;
  }
  expect(said(answers[1]!)).toContain('rewrote 1 of 3 rows.');
  expect(said(answers[1]!)).toContain('- rewrote the test note row');
  expect(said(answers[1]!)).toContain('since a turn of b is alive');
  expect(said(answers[1]!)).toContain('its edit failed');
  for (const answer of answers) expect(said(answer)).not.toContain(OLD);
});

const ROLLBACK = 'A later rollback to a row stored before now (/restore to a message, /branchto or the Web UI\'s Rollback) ' +
  'brings these rows\' old text back. Run the sweep again after one.';
const SHARDS = 'it is stored in 3 shards of body group group-7, which this sweep can\'t rewrite in place, so its old text stays.';

function withFleet(h: Awaited<ReturnType<typeof host>>, children: string[]) {
  const fleet = { name: 'fleet', getChildren: () => new Map(children.map((name) => [name, { name }])) };
  const framework = new Proxy(h.framework, {
    get(target, key) {
      if (key === 'getAllModules') return () => [...target.getAllModules(), fleet];
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const app = { ...(h.app as object), framework } as never;
  return (...args: string[]) => handleSweep(app, args, { via: 'test' }, [notes]);
}

describe('/sweep NAME: what it doesn\'t reach, and what its record keeps', () => {
  test('a later rollback to a row stored before the sweep brings the old words back, and a --write that rewrote a row says so', async () => {
    const h = await host();
    const id = h.note('a', 1);
    await h.turn('a');
    const cm = h.agent('a').getContextManager();
    const target = cm.getAllMessages().at(-1)!;
    cm.addMessage('user', text('a later row'), {});
    await h.turn('a');
    const written = h.sweep('test-notes', '--write');
    expect(said(written)).toContain('Sweep test-notes rewrote 1 of 1 row.');
    expect(said(written)).toContain(ROLLBACK);
    await h.framework.rollbackToMessage('a', { messageId: String(target.id) } as never);
    expect(h.rowText('a', id)).toContain(OLD);
    const again = h.sweep('test-notes');
    expect(said(again)).toContain('Sweep test-notes would rewrite 1 row.');
    expect(said(again)).not.toContain(ROLLBACK);
    expect(said(h.sweep('test-notes', '--write'))).toContain(ROLLBACK);
    expect(said(h.sweep('test-notes', '--write'))).not.toContain(ROLLBACK);
  });

  test('on a host with fleet children, each answer says the sweep reached this host\'s agents alone, and how an agent sweeps a child', async () => {
    const h = await host();
    h.note('a', 1);
    const sweep = withFleet(h, ['kid', 'pup']);
    const line = 'This host has 2 fleet children (kid, pup): the sweep reached this host\'s own agents alone. An agent here ' +
      'sends a child /sweep test-notes, or /sweep test-notes --write, with fleet--command, and reads the child\'s answer ' +
      'with fleet--peek.';
    for (const answer of [sweep('test-notes'), sweep('test-notes', '--write'), sweep('test-notes')]) expect(said(answer)).toContain(line);
    expect(said(withFleet(h, ['kid'])('test-notes'))).toContain('This host has 1 fleet child (kid): ');
    expect(said(withFleet(h, [])('test-notes'))).not.toContain('fleet');
    expect(said(h.sweep('test-notes'))).not.toContain('fleet');
  });

  test('the operator log records the rows rewritten, left and failed, each with its agent, and the branch and the store\'s sequence before the first edit', async () => {
    const h = await host();
    const first = h.note('a', 1);
    const second = h.note('a', 2);
    const cm = h.agent('a').getContextManager();
    const edit = cm.editMessage.bind(cm);
    cm.editMessage = (id, content) => {
      if (String(id) === first) throw new Error('the store refused this edit');
      edit(id, content);
    };
    const store = h.framework.getStore();
    const before = { branch: store.currentBranch().name, sequenceBefore: store.currentSequence() };
    h.sweep('test-notes', '--write');
    const logged = h.operatorLog().find((e) => e.kind === 'sweep')!;
    expect(logged.result).toMatchObject({
      ...before, rewritten: 1, leftForTurns: 0, failed: 1,
      rewrittenRows: [{ agent: 'a', id: second }], leftRows: [], failedRows: [{ agent: 'a', id: first }],
    });
    expect(store.currentSequence()).toBeGreaterThan(before.sequenceBefore);
  });

  test('the logged rows of a kind stop at 50, saying so, while its count is whole', async () => {
    const h = await host();
    for (let n = 1; n <= 51; n++) h.note('a', n);
    h.sweep('test-notes', '--write');
    const result = h.operatorLog().find((e) => e.kind === 'sweep')!.result as Record<string, unknown>;
    expect(result.rewritten).toBe(51);
    expect((result.rewrittenRows as unknown[]).length).toBe(50);
    expect(result.rewrittenRowsTruncated).toBe(true);
    expect(result.leftRowsTruncated).toBeUndefined();
  });

  test('where a holder\'s strategy renders summaries, the show and the write say that a summary already built from these rows keeps their old words', async () => {
    const h = await host();
    h.note('a', 1);
    await h.turn('a');
    const plain = h.sweep('test-notes');
    expect(said(plain)).not.toContain('summar');
    const cm = h.agent('a').getContextManager();
    cm.describeRenderedForms = () => ({ strategy: 'test', forms: ['raw', 'summary'] });
    const line = 'For a, whose strategy renders summaries, a summary already built from these rows keeps their old words.';
    expect(said(h.sweep('test-notes'))).toContain(line);
    expect(said(h.sweep('test-notes', '--write'))).toContain(line);
  });

  test('a row stored in shards is named with its count of shards and left, the show doesn\'t count it, and a --write that meets one answers refused', async () => {
    const h = await host();
    h.note('a', 1);
    const sharded = h.note('a', 2);
    const cm = h.agent('a').getContextManager();
    const all = cm.getAllMessages.bind(cm);
    cm.getAllMessages = () => all().map((row) => (String(row.id) === sharded ? { ...row, bodyGroupId: 'group-7', shardIndex: 0, shardCount: 3 } : row));
    const shown = h.sweep('test-notes');
    expect(said(shown)).toContain('Sweep test-notes would rewrite 1 row.');
    expect(shown.lines.map((l) => l.text).find((l) => l.includes(SHARDS))).toContain(`row ${sharded} of `);
    expect(shown.refused).toBeUndefined();
    const written = h.sweep('test-notes', '--write');
    expect(written.refused).toBe(true);
    expect(said(written)).toContain('Sweep test-notes rewrote 1 of 1 row.');
    expect(said(written)).toContain(`${SHARDS} A second run won't change that.`);
    expect(h.rowText('a', sharded)).toContain(OLD);
    expect(h.operatorLog().find((e) => e.kind === 'sweep')!.result).toMatchObject({ inShards: 1, shardedRows: [{ agent: 'a', id: sharded }] });
    const alone = h.sweep('test-notes');
    expect(said(alone)).toContain('Sweep test-notes finds no row it can rewrite.');
    expect(said(alone)).toContain(SHARDS);
  });
});
