import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework, storedInjectionMarkOf, type Module, type ModuleContext, type ProcessEvent } from '@animalabs/agent-framework';
import { Membrane, MockAdapter, type NormalizedRequest } from '@animalabs/membrane';
import { RetrievalModule } from '../src/modules/retrieval-module.js';
import { toWireEntry } from '../src/modules/web-ui-module.js';
import { compiledWithoutStoredInjections } from '../src/stored-injection.js';
import type { Lesson } from '../src/modules/lessons-module.js';

const dirs: string[] = [];
const frameworks: AgentFramework[] = [];
afterEach(async () => {
  while (frameworks.length) await frameworks.pop()!.stop().catch(() => {});
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

class Inbox implements Module {
  readonly name = 'lessons';
  async start(_ctx: ModuleContext) {}
  async stop() {}
  getTools() { return []; }
  async handleToolCall() { return { success: false, isError: true, error: 'no tools' }; }
  async onProcess(event: ProcessEvent) {
    if (event.type !== 'external-message') return {};
    const content = String((event as { content?: unknown }).content ?? '');
    return content === ''
      ? { requestInference: true }
      : { addMessages: [{ participant: 'user', content: [{ type: 'text' as const, text: content }] }], requestInference: true };
  }
  getLessons(): Lesson[] {
    return [{ id: 'l1', content: 'the memory detail is kept in the vault', confidence: 0.9, tags: ['memory'], evidence: [], created: 1, updated: 1, deprecated: false }];
  }
}

async function make() {
  const dir = mkdtempSync(join(tmpdir(), 'ch-stored-injections-')); dirs.push(dir);
  const retrievalCalls: NormalizedRequest[] = [];
  const retrieval = new RetrievalModule({
    membrane: {
      complete: async (request: NormalizedRequest) => {
        retrievalCalls.push(request);
        return { content: [{ type: 'text', text: '["memory"]' }] };
      },
    } as unknown as Membrane,
  });
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: new Membrane(new MockAdapter()),
    agents: [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.' }],
    modules: [new Inbox(), retrieval],
  });
  frameworks.push(framework);
  await framework.start();
  const say = async (content: string) => {
    framework.pushEvent({ type: 'external-message', source: 'test', content, metadata: {} } as unknown as ProcessEvent);
    await framework.runUntilIdle();
  };
  const window = () => framework.getAgent('prime')!.getContextManager().getAllMessages();
  const lessonRows = () => window().filter((m) => storedInjectionMarkOf(m.metadata)?.namespace === 'retrieval');
  const textOf = (m: { content: unknown }) =>
    (m.content as Array<{ type: string; text?: string }>).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  const replies = () => window().filter((m) => m.participant === 'prime').length;
  return { framework, retrieval, retrievalCalls, say, window, lessonRows, textOf, replies };
}

describe('retrieval\'s block, stored by the framework', () => {
  test('a start with no new message gets the turn\'s block with no model calls, and nothing new is stored', async () => {
    const x = await make();
    await x.say('What is the memory detail?');
    expect(x.retrievalCalls).toHaveLength(1);
    expect(x.lessonRows()).toHaveLength(1);

    const repliesBefore = x.replies();
    await x.say('');
    expect(x.replies()).toBe(repliesBefore + 1);
    expect(x.retrieval.getRetrievalTraces()[0]!.outcome).toBe('cache-hit');
    expect(x.retrievalCalls).toHaveLength(1);
    expect(x.lessonRows()).toHaveLength(1);
  });

  test('each opening message gets its own block, stored after it and naming it', async () => {
    const x = await make();
    await x.say('What is the memory detail?');
    const first = x.lessonRows()[0]!;
    expect(storedInjectionMarkOf(first.metadata)).toMatchObject({ agent: 'prime', namespace: 'retrieval' });
    expect(x.textOf(first)).toStartWith('## Retrieved Knowledge, for the message beginning "What is the memory detail?"\n');
    const rows = x.window();
    expect(x.textOf(rows[rows.findIndex((m) => m.id === first.id) - 1]!)).toBe('What is the memory detail?');

    await x.say('And where is the memory detail kept?');
    expect(x.retrievalCalls).toHaveLength(2);
    expect(x.lessonRows()).toHaveLength(2);
    expect(x.textOf(x.lessonRows()[1]!)).toStartWith('## Retrieved Knowledge, for the message beginning "And where is the memory detail kept?"\n');
  });

  test('its rows read as injected to the host\'s transcript views', async () => {
    const x = await make();
    await x.say('What is the memory detail?');
    const row = x.lessonRows()[0]!;
    const entry = toWireEntry(row, 0);
    expect(entry.participant).toBe('system');
    expect(entry.text).toStartWith('[retrieval, injected for prime]\n');
  });

  test('a reader of a compile leaves the stored block out by the compile\'s own provenance', async () => {
    const x = await make();
    await x.say('What is the memory detail?');
    const compiled = await x.framework.getAgent('prime')!.getContextManager().compile(undefined, undefined, { dryRun: true });
    const kept = compiledWithoutStoredInjections(compiled);
    expect(compiled.messages.some((m) => x.textOf(m).startsWith('## Retrieved Knowledge'))).toBe(true);
    expect(kept.some((m) => x.textOf(m).startsWith('## Retrieved Knowledge'))).toBe(false);
    expect(kept.some((m) => x.textOf(m) === 'What is the memory detail?')).toBe(true);
    expect(kept).toHaveLength(compiled.messages.length - 1);
  });
});
