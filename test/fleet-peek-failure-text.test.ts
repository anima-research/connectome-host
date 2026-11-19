import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetModule } from '../src/modules/fleet-module.js';

const SENTINEL = 'sentinel-5d8b provider said: invalid x-api-key';

const dirs: string[] = [];
const fleets: FleetModule[] = [];
afterEach(async () => {
  await Promise.all(fleets.splice(0).map((fleet) => fleet.stop()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ARRIVED: Array<Record<string, unknown>> = [
  { type: 'inference:failed', agentName: 'leaf', error: SENTINEL, stack: `Error: ${SENTINEL}\n    at call`, ts: 1 },
  {
    type: 'inference:exhausted', agentName: 'leaf', error: SENTINEL, retryable: false, errorType: 'invalid_request',
    httpStatus: 400, providerErrorCode: 'sentinel-5d8b-code', ts: 2,
  },
  { type: 'inference:exhausted', agentName: 'leaf', error: SENTINEL, shownReason: 'the stream was aborted', errorType: 'safety', ts: 3 },
  { type: 'ops:alert', kind: 'refusal', agentName: 'leaf', message: `refusal streak 2, category=${SENTINEL}`, data: { category: SENTINEL, streak: 2 }, ts: 4 },
  { type: 'tool:failed', agentName: 'leaf', tool: 'fetch', callId: 'c1', error: SENTINEL, ts: 5 },
  { type: 'inference:speech', agentName: 'leaf', content: 'Looking into it.', ts: 6 },
];

const SHOWN: Array<Record<string, unknown>> = [
  { type: 'inference:failed', agentName: 'leaf', ts: 1 },
  { type: 'inference:exhausted', agentName: 'leaf', retryable: false, errorType: 'invalid_request', httpStatus: 400, ts: 2 },
  { type: 'inference:exhausted', agentName: 'leaf', shownReason: 'the stream was aborted', ts: 3 },
  { type: 'ops:alert', kind: 'refusal', agentName: 'leaf', ts: 4 },
  { type: 'tool:failed', agentName: 'leaf', tool: 'fetch', callId: 'c1', ts: 5 },
  { type: 'inference:speech', agentName: 'leaf', content: 'Looking into it.', ts: 6 },
];

test("fleet--peek shows a child's events without a failure's own text, says so, and the buffer keeps them whole", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-peek-'));
  dirs.push(dir);
  const fleet = new FleetModule({ childIndexPath: join(import.meta.dir, 'mock-fleet-lifecycle-child.ts') });
  fleets.push(fleet);
  const children = (fleet as unknown as { children: Map<string, { events: Array<Record<string, unknown>> }> }).children;
  children.set('leaf', {
    name: 'leaf', recipePath: join(dir, 'recipe.json'), dataDir: dir, socketPath: join(dir, 'ipc.sock'), pid: null,
    process: null, socket: null, status: 'ready', startedAt: 1, exitedAt: null, lastEventAt: null, exitCode: null,
    events: [], buffer: '', subscription: ['*'], autoRestart: false, killRequested: false, restartAttempts: [],
  } as unknown as { events: Array<Record<string, unknown>> });
  const record = (fleet as unknown as { recordEvent(child: object, event: object): void }).recordEvent.bind(fleet);
  for (const event of ARRIVED) record(children.get('leaf')!, structuredClone(event));

  const peek = await fleet.handleToolCall({ id: 'peek', name: 'peek', input: { name: 'leaf' } });
  expect(peek.success).toBe(true);
  expect(peek.data).toEqual({
    name: 'leaf', count: SHOWN.length, events: SHOWN,
    note: "Each event is shown without a failure's own text: its error, stack and providerErrorCode, an alert's message and data, and an errorType of safety.",
  });
  expect(JSON.stringify(peek.data)).not.toContain('sentinel-5d8b');
  expect(children.get('leaf')!.events).toEqual(ARRIVED);
});
