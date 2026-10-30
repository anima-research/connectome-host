import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { runHeadless } from '../src/headless.js';
import type { AppContext } from '../src/index.js';
import { SURFACE_TAG_KEY, TuiModule, surfaceAnswers, type SurfaceQuestion } from '../src/modules/tui-module.js';

const dir = process.env.DATA_DIR!;
const tui = new TuiModule();
const listeners: Array<(event: unknown) => void> = [];
const trace = (event: Record<string, unknown>): void => { for (const listener of [...listeners]) listener(event); };
const record = (line: unknown): void => appendFileSync(join(dir, 'answers.jsonl'), `${JSON.stringify(line)}\n`);
const stream = (rounds: string | string[]): void => {
  trace({ type: 'inference:started', agentName: 'fixture' });
  for (const [index, said] of [rounds].flat().entries()) {
    if (index > 0) {
      trace({ type: 'inference:tool_calls_yielded', agentName: 'fixture', calls: [] });
      trace({ type: 'inference:stream_resumed', agentName: 'fixture' });
    }
    trace({ type: 'inference:tokens', agentName: 'fixture', content: said, blockType: 'text', blockIndex: 0 });
  }
  trace({ type: 'inference:completed', agentName: 'fixture' });
};

await runHeadless({
  recipe: { name: 'answer-test', agent: { name: 'fixture' } },
  agentName: 'fixture',
  framework: {
    getAllAgents: () => [{ name: 'fixture', state: { status: 'idle' } }],
    getAllModules: () => [],
    getHostModeStatus: () => ({ drained: true, activeTurnAgents: [], parkedAdmissions: 0, gatedRequests: 0, backgroundScripts: 0 }),
    getQueueDepth: () => 0,
    pushEvent: async (event: unknown) => {
      const added = (await tui.onProcess(event as never, {} as never)).addMessages?.[0] as { metadata?: Record<string, unknown> } | undefined;
      const tag = added?.metadata?.[SURFACE_TAG_KEY] as { connection?: string } | undefined;
      const content = String((event as { content?: unknown }).content ?? '');
      const command = content.startsWith('{')
        ? JSON.parse(content) as { stream?: string | string[]; blocks?: Array<{ content: string; blockType: string }>; ask?: { text: string; connections: string[]; final?: boolean } }
        : undefined;
      if (command?.ask) {
        record({ asked: surfaceAnswers.answer('headless', { agentName: 'fixture', final: true, ...command.ask }) ?? null });
        return;
      }
      if (command?.blocks) {
        trace({ type: 'inference:started', agentName: 'fixture' });
        command.blocks.forEach((block, blockIndex) => trace({ type: 'inference:tokens', agentName: 'fixture', ...block, blockIndex }));
        trace({ type: 'inference:completed', agentName: 'fixture' });
        record({ streamed: command.blocks, tag: tag ?? null });
        return;
      }
      if (command?.stream) {
        stream(command.stream);
        record({ streamed: command.stream, tag: tag ?? null });
        return;
      }
      stream('Hi there.');
      const connections = tag?.connection ? [tag.connection] : [];
      const ask = (question: Partial<SurfaceQuestion>) =>
        surfaceAnswers.answer('headless', { agentName: 'fixture', text: 'Hi there.', final: true, connections, ...question }) ?? null;
      record({
        tag: tag ?? null,
        final: ask({}),
        round: ask({ final: false }),
        notWritten: ask({ text: 'Looking around.' }),
        anotherBoot: ask({ connections: ['an-id-from-another-boot'] }),
        anotherAgent: ask({ agentName: 'helper' }),
      });
    },
    onTrace: (listener: (event: unknown) => void) => { listeners.push(listener); return () => {}; },
    stop: async () => {},
  },
} as unknown as AppContext);
