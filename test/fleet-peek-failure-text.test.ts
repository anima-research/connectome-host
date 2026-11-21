import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetModule } from '../src/modules/fleet-module.js';
import { AgentTreeReducer } from '../src/state/agent-tree-reducer.js';

const SENTINEL = 'sentinel-5d8b provider said: invalid x-api-key';
const NOTE = "Each event's error and attemptError read \"left out\" in place of their text, and its stack and providerErrorCode, " +
  "an alert's message and data, and an errorType of safety are left out. Streamed chunks (inference:tokens) and panel answers " +
  "(panel-response) are left out too. The final reply of a child's main agent is in its inference:speech, which the child sends " +
  "where its subscription includes it. A reply that the provider refused at its end can still show there.";

const dirs: string[] = [];
const fleets: FleetModule[] = [];
afterEach(async () => {
  await Promise.all(fleets.splice(0).map((fleet) => fleet.stop()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Event = Record<string, unknown>;

/** A fleet with one child, 'leaf', whose buffer took `events` as its socket would. */
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
  return { peek, buffer: () => children.get('leaf')!.events };
}

const ARRIVED: Event[] = [
  { type: 'inference:failed', agentName: 'leaf', error: SENTINEL, stack: `Error: ${SENTINEL}\n    at call`, ts: 1 },
  {
    type: 'inference:exhausted', agentName: 'leaf', error: SENTINEL, retryable: false, errorType: 'invalid_request',
    httpStatus: 400, providerErrorCode: 'sentinel-5d8b-code', ts: 2,
  },
  { type: 'inference:exhausted', agentName: 'leaf', error: SENTINEL, shownReason: 'the stream was aborted', errorType: 'safety', ts: 3 },
  { type: 'ops:alert', kind: 'refusal', agentName: 'leaf', message: `refusal streak 2, category=${SENTINEL}`, data: { category: SENTINEL, streak: 2 }, ts: 4 },
  { type: 'tool:failed', agentName: 'leaf', tool: 'fetch', callId: 'c1', error: SENTINEL, ts: 5 },
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
  { type: 'tool:failed', agentName: 'leaf', tool: 'fetch', callId: 'c1', error: 'left out', ts: 5 },
  { type: 'workspace-file-snapshot', corrId: 'w1', path: 'notes.md', totalLines: 0, fromLine: 1, toLine: 0, content: '', truncated: false, error: 'left out', ts: 6 },
  { type: 'inference:speech', agentName: 'leaf', content: 'Looking into it.', ts: 7 },
];

test("fleet--peek shows a child's events without a failure's own text, says so, and the buffer keeps them whole", async () => {
  const child = childWith(ARRIVED);
  const peek = await child.peek();
  expect(peek.success).toBe(true);
  expect(peek.data).toEqual({ name: 'leaf', count: SHOWN.length, events: SHOWN, note: NOTE });
  expect(child.buffer()).toEqual(ARRIVED);
});

test("no text of a child's failed turn reaches a parent through fleet--peek, its tree's snapshot included", async () => {
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

test("fleet--peek's lines counts the events it shows, with streamed chunks and panel answers left out before the count", async () => {
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
  expect(child.buffer()).toHaveLength(5);
});
