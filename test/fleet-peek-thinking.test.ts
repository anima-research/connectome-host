import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetModule } from '../src/modules/fleet-module.js';

const CHILD = join(import.meta.dir, 'mock-headless-thinking-child.ts');
const THOUGHTS = ['Weighing the question.', 'One more thing to say.'];

type Event = { type?: string; blockType?: string; content?: string };
const isThinking = (event: Event) => event.type === 'inference:tokens' && event.blockType === 'thinking';

let dir: string;
let fleet: FleetModule;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-peek-thinking-'));
  fleet = new FleetModule({ childIndexPath: CHILD, socketWaitTimeoutMs: 10_000, readyTimeoutMs: 5_000, gracefulShutdownMs: 3_000, sigtermEscalationMs: 1_000 });
  await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);
  const launched = await fleet.handleToolCall({ id: 'launch', name: 'launch', input: { name: 'thinker', recipe: 'mock-recipe', dataDir: join(dir, 'thinker') } });
  if (!launched.success) throw new Error(`launch failed: ${launched.error}`);
  const sent = await fleet.handleToolCall({ id: 'send', name: 'send', input: { name: 'thinker', content: 'hello' } });
  if (!sent.success) throw new Error(`send failed: ${sent.error}`);
  const events = fleet.getChildren().get('thinker')!.events as Event[];
  const deadline = Date.now() + 20_000;
  while (!events.some((e) => e.type === 'lifecycle' && (e as { phase?: string }).phase === 'idle' && Number((e as { texts?: unknown }).texts) >= 1)) {
    if (Date.now() > deadline) throw new Error('the turn never ended');
    await Bun.sleep(20);
  }
}, 30_000);

afterAll(async () => {
  try { await fleet.stop(); } catch { }
  rmSync(dir, { recursive: true, force: true });
});

test("fleet--peek gives a child's events without its thinking tokens, and its text tokens still", async () => {
  const peek = await fleet.handleToolCall({ id: 'peek', name: 'peek', input: { name: 'thinker' } });
  expect(peek.success).toBe(true);
  const events = (peek.data as { events: Event[] }).events;
  expect(events.filter(isThinking)).toEqual([]);
  for (const thought of THOUGHTS) expect(JSON.stringify(peek)).not.toContain(thought);
  const said = events.filter((e) => e.type === 'inference:tokens' && e.blockType === 'text').map((e) => e.content).join('');
  expect(said).toBe('Hello.World.');
});

test('fleet--peek counts its last N among the events it gives, so a thinking token takes no place of one', async () => {
  const buffer = fleet.getChildren().get('thinker')!.events as Event[];
  const given = buffer.filter((e) => !isThinking(e));
  expect(buffer.length).toBeGreaterThan(given.length);
  const peek = await fleet.handleToolCall({ id: 'peek-n', name: 'peek', input: { name: 'thinker', lines: given.length } });
  const data = peek.data as { count: number; events: Event[] };
  expect(data.count).toBe(given.length);
  expect(data.events).toEqual(given);
});

test("the child's own buffer, which the operator's fleet view reads, keeps its thinking", () => {
  const buffer = fleet.getChildren().get('thinker')!.events as Event[];
  expect(buffer.filter(isThinking).map((e) => e.content).join('')).toBe(THOUGHTS.join(''));
});
