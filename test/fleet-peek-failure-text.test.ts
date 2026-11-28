import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetModule, HOST_FORCED_TELEMETRY_EVENTS } from '../src/modules/fleet-module.js';
import { AgentTreeReducer } from '../src/state/agent-tree-reducer.js';

const SENTINEL = 'sentinel-5d8b provider said: invalid x-api-key';
const NOTE = "Each event's error and attemptError read \"left out\" in place of their text, but for a failed tool call's own " +
  "error, which shows. An event's stack and providerErrorCode, an alert's message and data, and an errorType of safety are left " +
  "out. Streamed chunks (inference:tokens) are not kept. When a round ends, its text shows as an inference:round_text, or, for " +
  "the final reply of a child's main agent, as the inference:speech that the child sends where its subscription includes it. A " +
  "reply that the provider refused at its end can still show in either.";

const dirs: string[] = [];
const fleets: FleetModule[] = [];
afterEach(async () => {
  await Promise.all(fleets.splice(0).map((fleet) => fleet.stop()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Event = Record<string, unknown>;

function childWith(events: Event[]) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-peek-'));
  dirs.push(dir);
  const fleet = new FleetModule({ childIndexPath: join(import.meta.dir, 'mock-fleet-lifecycle-child.ts') });
  fleets.push(fleet);
  const children = (fleet as unknown as { children: Map<string, { events: Event[] }> }).children;
  children.set('leaf', {
    name: 'leaf', recipePath: join(dir, 'recipe.json'), dataDir: dir, socketPath: join(dir, 'ipc.sock'), pid: null,
    process: null, socket: null, status: 'ready', startedAt: 1, exitedAt: null, lastEventAt: null, exitCode: null,
    events: [], buffer: '', subscription: ['*'], autoRestart: false, killRequested: false, restartAttempts: [],
  } as unknown as { events: Event[] });
  const record = (fleet as unknown as { recordEvent(child: object, event: object): void }).recordEvent.bind(fleet);
  for (const event of events) record(children.get('leaf')!, structuredClone(event));
  const peek = async (lines?: number) => fleet.handleToolCall({ id: 'peek', name: 'peek', input: { name: 'leaf', ...(lines === undefined ? {} : { lines }) } });
  const reconnect = () => (fleet as unknown as { attach(child: object, socket: object): void }).attach(children.get('leaf')!, { on: () => {} });
  const more = (later: Event[]) => { for (const event of later) record(children.get('leaf')!, structuredClone(event)); };
  return {
    peek, more, reconnect, buffer: () => children.get('leaf')!.events,
    lastSpeech: () => (children.get('leaf') as unknown as { lastCompletedSpeech?: string }).lastCompletedSpeech,
    keptRounds: () => [...((children.get('leaf') as unknown as { rounds?: Map<string, unknown> }).rounds?.keys() ?? [])],
  };
}

const ARRIVED: Event[] = [
  { type: 'inference:failed', agentName: 'leaf', error: SENTINEL, stack: `Error: ${SENTINEL}\n    at call`, ts: 1 },
  {
    type: 'inference:exhausted', agentName: 'leaf', error: SENTINEL, retryable: false, errorType: 'invalid_request',
    httpStatus: 400, providerErrorCode: 'sentinel-5d8b-code', ts: 2,
  },
  { type: 'inference:exhausted', agentName: 'leaf', error: SENTINEL, shownReason: 'the stream was aborted', errorType: 'safety', ts: 3 },
  { type: 'ops:alert', kind: 'refusal', agentName: 'leaf', message: `refusal streak 2, category=${SENTINEL}`, data: { category: SENTINEL, streak: 2 }, ts: 4 },
  { type: 'tool:failed', agentName: 'leaf', tool: 'files', callId: 'c1', error: 'ENOENT: notes.md', stack: `Error: ${SENTINEL}`, result: { error: SENTINEL }, ts: 5 },
  { type: 'workspace-file-snapshot', corrId: 'w1', path: 'notes.md', totalLines: 0, fromLine: 1, toLine: 0, content: '', truncated: false, error: 'no such file', ts: 6 },
  { type: 'inference:speech', agentName: 'leaf', content: 'Looking into it.', ts: 7 },
  { type: 'inference:tokens', agentName: 'leaf', content: SENTINEL, blockType: 'text', ts: 8 },
  { type: 'panel-response', corrId: 'p1', op: 'credential', ok: true, data: { subscription: true, agent: 'leaf', provider: 'anthropic', kind: 'rejected', message: `anthropic rejected the credential (${SENTINEL})` }, ts: 9 },
];

const SHOWN: Event[] = [
  { type: 'inference:failed', agentName: 'leaf', error: 'left out', ts: 1 },
  { type: 'inference:exhausted', agentName: 'leaf', error: 'left out', retryable: false, errorType: 'invalid_request', httpStatus: 400, ts: 2 },
  { type: 'inference:exhausted', agentName: 'leaf', error: 'left out', shownReason: 'the stream was aborted', ts: 3 },
  { type: 'ops:alert', kind: 'refusal', agentName: 'leaf', ts: 4 },
  { type: 'tool:failed', agentName: 'leaf', tool: 'files', callId: 'c1', error: 'ENOENT: notes.md', result: { error: 'left out' }, ts: 5 },
  { type: 'workspace-file-snapshot', corrId: 'w1', path: 'notes.md', totalLines: 0, fromLine: 1, toLine: 0, content: '', truncated: false, error: 'left out', ts: 6 },
  { type: 'inference:speech', agentName: 'leaf', content: 'Looking into it.', ts: 7 },
];

test("fleet--peek shows a child's events without a failure's own text but for a failed tool call's own error, says so, and the buffer keeps them whole but holds no panel answer", async () => {
  const child = childWith(ARRIVED);
  const peek = await child.peek();
  expect(peek.success).toBe(true);
  expect(peek.data).toEqual({ name: 'leaf', count: SHOWN.length, events: SHOWN, note: NOTE });
  expect(child.buffer()).toEqual(ARRIVED.filter((event) => event.type !== 'panel-response' && event.type !== 'inference:tokens'));
});

test("no text of a child's failed round reaches a parent through fleet--peek, its tree's snapshot included", async () => {
  const failure = [
    { type: 'inference:started', agentName: 'leaf', ts: 10 },
    { type: 'inference:tokens', agentName: 'leaf', content: SENTINEL, blockType: 'text', ts: 10 },
    { type: 'inference:failed', agentName: 'leaf', error: SENTINEL, stack: `Error: ${SENTINEL}`, ts: 11 },
    { type: 'inference:exhausted', agentName: 'leaf', error: SENTINEL, errorType: 'auth', httpStatus: 401, providerErrorCode: 'sentinel-5d8b-code', ts: 12 },
  ];
  const tree = new AgentTreeReducer();
  for (const event of failure) tree.applyEvent(event);
  const snap = tree.getSnapshot();
  const snapshot = {
    type: 'snapshot', corrId: 'd1', asOfTs: snap.asOfTs,
    child: { name: 'leaf', pid: 1, recipe: 'leaf', startedAt: 1 },
    tree: { nodes: snap.nodes, callIdIndex: snap.callIdIndex },
    ts: 13,
  };
  expect(JSON.stringify(snapshot)).toContain('sentinel-5d8b');
  const alert = { type: 'ops:alert', kind: 'refusal', agentName: 'leaf', message: `category=${SENTINEL}`, data: { category: SENTINEL, streak: 2 }, ts: 14 };
  const panel = { type: 'panel-response', corrId: 'p1', op: 'credential', ok: true, data: { subscription: true, agent: 'leaf', provider: 'anthropic', kind: 'rejected', message: `anthropic rejected the credential (${SENTINEL})` }, ts: 15 };
  const child = childWith([...failure, snapshot, alert, panel]);
  const peek = await child.peek();
  expect(peek.success).toBe(true);
  expect((peek.data as { count: number }).count).toBe(5);
  expect((peek.data as { events: Event[] }).events.map((e) => e.type)).toEqual(['inference:started', 'inference:failed', 'inference:exhausted', 'snapshot', 'ops:alert']);
  expect(JSON.stringify(peek.data)).not.toContain('sentinel-5d8b');
  const node = (peek.data as { events: Array<{ tree?: { nodes: Array<{ attemptError?: unknown }> } }> }).events[3]!.tree!.nodes[0]!;
  expect(node.attemptError).toBe('left out');
});

test("fleet--peek's lines counts the events it shows, and the buffer keeps no streamed chunk and no panel answer", async () => {
  const child = childWith([
    { type: 'inference:speech', agentName: 'leaf', content: 'First reply.', ts: 1 },
    { type: 'inference:tokens', agentName: 'leaf', content: 'Sec', blockType: 'text', ts: 2 },
    { type: 'inference:tokens', agentName: 'leaf', content: 'ond', blockType: 'text', ts: 3 },
    { type: 'inference:speech', agentName: 'leaf', content: 'Second reply.', ts: 4 },
    { type: 'panel-response', corrId: 'p2', op: 'health', ok: true, data: { agent: 'leaf' }, ts: 5 },
  ]);
  const peek = await child.peek(2);
  expect(peek.data).toEqual({
    name: 'leaf', count: 2, note: NOTE,
    events: [
      { type: 'inference:speech', agentName: 'leaf', content: 'First reply.', ts: 1 },
      { type: 'inference:speech', agentName: 'leaf', content: 'Second reply.', ts: 4 },
    ],
  });
  expect(child.buffer()).toHaveLength(2);
});

const round = (agentName: string, words: string[], at: number): Event[] =>
  words.map((content, i) => ({ type: 'inference:tokens', agentName, content, blockType: 'text', ts: at + i }));
const shownEvents = async (child: ReturnType<typeof childWith>) => ((await child.peek(500)).data as { events: Event[] }).events;

test("fleet--peek shows a tool round's text before its tool calls, and the final reply one time, as the child's inference:speech", async () => {
  const child = childWith([
    { type: 'inference:started', agentName: 'leaf', ts: 1 },
    { type: 'inference:tokens', agentName: 'leaf', content: 'weighing it', blockType: 'thinking', ts: 2 },
    ...round('leaf', ['Check', 'ing.'], 3),
    { type: 'inference:tool_calls_yielded', agentName: 'leaf', calls: [{ id: 'c1', name: 'files' }], ts: 5 },
    { type: 'inference:stream_resumed', agentName: 'leaf', ts: 6 },
    ...round('leaf', ['Done', '.'], 7),
    { type: 'inference:completed', agentName: 'leaf', ts: 9 },
    { type: 'inference:speech', agentName: 'leaf', content: 'Done.', ts: 9 },
  ]);
  expect(await shownEvents(child)).toEqual([
    { type: 'inference:started', agentName: 'leaf', ts: 1 },
    { type: 'inference:round_text', agentName: 'leaf', content: 'Checking.', ts: 5 },
    { type: 'inference:tool_calls_yielded', agentName: 'leaf', calls: [{ id: 'c1', name: 'files' }], ts: 5 },
    { type: 'inference:stream_resumed', agentName: 'leaf', ts: 6 },
    { type: 'inference:completed', agentName: 'leaf', ts: 9 },
    { type: 'inference:speech', agentName: 'leaf', content: 'Done.', ts: 9 },
  ]);
  expect(child.lastSpeech()).toBe('Done.');
  expect(child.buffer().some((event) => event.type === 'inference:tokens')).toBe(false);
});

test("fleet--peek shows the text of a round that no inference:speech carries: a final round without one, a subagent's, a silent start's, and a replayed one", async () => {
  const child = childWith([
    { type: 'inference:started', agentName: 'leaf', ts: 1 },
    { type: 'inference:started', agentName: 'scout-1', ts: 1 },
    ...round('leaf', ['Done.'], 2),
    ...round('scout-1', ['Looking.'], 2),
    { type: 'inference:completed', agentName: 'scout-1', ts: 3 },
    { type: 'inference:completed', agentName: 'leaf', ts: 4 },
    { type: 'inference:started', agentName: 'leaf', silent: true, ts: 5 },
    ...round('leaf', ['Quietly.'], 6),
    { type: 'inference:completed', agentName: 'leaf', ts: 7 },
    { type: 'inference:started', agentName: 'leaf', replay: true, ts: 8 },
    { type: 'inference:tokens', agentName: 'leaf', content: 'Before.', blockType: 'text', replay: true, ts: 8 },
    { type: 'inference:completed', agentName: 'leaf', replay: true, ts: 8 },
  ]);
  expect((await shownEvents(child)).filter((event) => event.type === 'inference:round_text')).toEqual([
    { type: 'inference:round_text', agentName: 'scout-1', content: 'Looking.', ts: 3 },
    { type: 'inference:round_text', agentName: 'leaf', content: 'Done.', ts: 4 },
    { type: 'inference:round_text', agentName: 'leaf', content: 'Quietly.', ts: 7 },
    { type: 'inference:round_text', agentName: 'leaf', content: 'Before.', replay: true, ts: 8 },
  ]);
  expect(child.lastSpeech()).toBeUndefined();
  expect(child.keptRounds()).toEqual([]);
});

test("fleet--peek shows no text of a refused attempt that an empty chunk discards, of a round whose start this host didn't see, or of a round open across a new connection", async () => {
  const child = childWith([
    { type: 'inference:started', agentName: 'leaf', ts: 1 },
    ...round('leaf', [SENTINEL, '', 'Fresh.'], 2),
    { type: 'inference:completed', agentName: 'leaf', ts: 5 },
    ...round('scout-1', ['Unseen start.'], 6),
    { type: 'inference:completed', agentName: 'scout-1', ts: 7 },
    { type: 'inference:started', agentName: 'leaf', ts: 8 },
    ...round('leaf', ['Before the gap.'], 9),
  ]);
  child.reconnect();
  child.more([...round('leaf', ['After.'], 10), { type: 'inference:completed', agentName: 'leaf', ts: 11 }]);
  expect((await shownEvents(child)).filter((event) => event.type === 'inference:round_text')).toEqual([
    { type: 'inference:round_text', agentName: 'leaf', content: 'Fresh.', ts: 5 },
  ]);
  expect(JSON.stringify(child.buffer())).not.toContain('sentinel-5d8b');
});

test("a round with more chunks than the buffer holds pushes no other event out, and its text comes whole", async () => {
  const words = Array.from({ length: 600 }, (_, i) => `w${i} `);
  const child = childWith([
    { type: 'command-output', text: 'Topic reset.', style: 'system', ts: 1 },
    { type: 'inference:started', agentName: 'leaf', ts: 2 },
    ...round('leaf', words, 3),
    { type: 'inference:completed', agentName: 'leaf', ts: 700 },
  ]);
  expect(child.buffer()).toEqual([
    { type: 'command-output', text: 'Topic reset.', style: 'system', ts: 1 },
    { type: 'inference:started', agentName: 'leaf', ts: 2 },
    { type: 'inference:round_text', agentName: 'leaf', content: words.join(''), ts: 700 },
    { type: 'inference:completed', agentName: 'leaf', ts: 700 },
  ]);
});

test('the host forces into every subscription the events from which it assembles a round\'s text', () => {
  for (const type of ['inference:started', 'inference:stream_resumed', 'inference:tokens', 'inference:tool_calls_yielded',
    'inference:completed', 'inference:failed', 'inference:aborted', 'inference:exhausted']) {
    expect(HOST_FORCED_TELEMETRY_EVENTS).toContain(type);
  }
});
