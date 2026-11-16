import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework, asOwnRow } from '@animalabs/agent-framework';
import type { StoredMessage } from '@animalabs/context-manager';
import type { NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { createBranchState, handleCommand, handleSweep } from '../src/commands.js';
import type { Sweep } from '../src/sweeps.js';

// What `connectome sweep` asks of the running host: `/sweep NAME` shows the
// rows a sweep would rewrite and writes nothing, and `/sweep NAME --write`
// rewrites them. These run it on a real framework whose agents share the
// residents' slot, with a sweep of the test's own: the mechanism ships with
// no sweep.

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

// A real framework's turns and stop run past bun's 5 s default on a loaded host.
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
  const app = { framework, branchState: createBranchState(), agentName: 'a', userMessageCount: 0 } as never;
  const sweep = (...args: string[]) => handleSweep(app, args, { via: 'test' }, [notes]);
  const turn = async (name: string) => { framework.nudgeAgent(name, 'test'); await framework.runUntilIdle(); };
  const operatorLog = (): Array<Record<string, unknown>> => {
    try {
      return readFileSync(join(storePath, 'operator-actions.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  return { framework, app, requests, holdFor, agent, note, rowText, sweep, turn, operatorLog };
}

describe('/sweep, the list and its words', () => {
  test('with no name it lists the sweeps it is given, and this release ships with none', async () => {
    const h = await host();
    expect(said(h.sweep())).toContain('test-notes: Rewrites the test notes.');
    expect(said(handleCommand('/sweep', h.app))).toBe('This release knows no sweep.');
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

  test('while a session switch is under way, /sweep with a name is refused and writes nothing', async () => {
    const h = await host();
    const id = h.note('a', 1);
    (h.app as { switching?: boolean }).switching = true;
    const answer = handleCommand('/sweep test-notes --write', h.app);
    expect(said(answer)).toContain('a session switch is under way');
    expect(h.rowText('a', id)).toContain(OLD);
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
    expect(line1).toContain('test note row of ');
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
    expect(h.agent('a').getContextManager().getMessage(id as never)).not.toBeNull();
    expect(said(h.sweep('test-notes', '--write'))).toContain('rewrote 1 of 1 row.');
    await h.turn('b');
    const next = JSON.stringify(h.requests.at(-1));
    expect(next).toContain('New words for note 2.');
    expect(next).not.toContain(OLD);
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

  test('a row whose edit fails is named and left, and the rest are rewritten', async () => {
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
    expect(said(answer)).toContain('left as it was, since its edit failed');
    expect(said(answer)).toContain('the store refused this edit');
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
  expect(said(answers[1]!)).toContain('since a turn of b is alive');
  expect(said(answers[1]!)).toContain('since its edit failed');
  for (const answer of answers) expect(said(answer)).not.toContain(OLD);
});
