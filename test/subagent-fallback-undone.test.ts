/**
 * A subagent run that ends on a tool call, with no speech, answers with the
 * newest text its window holds that isn't the user's or a stored
 * injection's (extractLastAssistantText): any other participant's, a message
 * presented from another agent included, as main's filter took. A text
 * turn an undo or a shed took out of the subagent's window (agent-framework
 * #291: windowStatusOf 'undone') stays in the record, but the subagent was
 * not shown it again, so it is not the run's answer; nor is a stored row the
 * window doesn't hold (`out`).
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '@animalabs/agent-framework';
import type { Module, ToolCall } from '@animalabs/agent-framework';
import type { ContextManager } from '@animalabs/context-manager';
import { Membrane, MockAdapter, NativeFormatter } from '@animalabs/membrane';
import { SubagentModule } from '../src/modules/subagent-module.js';

type Run = (agent: { name: string }, contextManager: ContextManager) => Promise<{ speech: string; toolCallsCount: number }>;

/** A host whose subagent runs are `run`, on the context manager agent-framework creates for the run. */
async function harness(run: Run) {
  const dir = mkdtempSync(join(tmpdir(), 'sub-fallback-'));
  const subagent = new SubagentModule({ parentAgentName: 'parent', defaultModel: 'mock', defaultMaxTokens: 256, maxRetries: 0 });
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: new Membrane(new MockAdapter({ defaultResponse: 'ok' }), { formatter: new NativeFormatter() }),
    agents: [{ name: 'parent', model: 'mock', systemPrompt: 'parent', maxTokens: 256 }],
    modules: [subagent as unknown as Module],
  });
  const fw = framework as unknown as { runEphemeralToCompletion: Run; agents: Map<string, unknown> };
  fw.runEphemeralToCompletion = (agent, contextManager) => {
    fw.agents.set(agent.name, agent);
    const ran = run(agent, contextManager);
    const drop = () => { if (fw.agents.get(agent.name) === agent) fw.agents.delete(agent.name); };
    ran.then(drop, drop);
    return ran;
  };
  subagent.setFramework(framework);
  framework.start();
  return {
    subagent,
    cleanup: async () => {
      try { await framework.stop(); } catch { }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function launch(kind: 'spawn' | 'fork', name: string): ToolCall {
  const input = kind === 'spawn' ? { name, systemPrompt: 'sp', task: 't', sync: true } : { name, task: 't', sync: true };
  return { id: `t-${name}`, name: kind, input, callerAgentName: 'parent' };
}

const text = (t: string) => [{ type: 'text' as const, text: t }];

/** A run on a presented window (as agent-framework writes it down at the
 *  run's start) whose text turn `spoken` is shown to the subagent, after an
 *  earlier text turn, and which then ends on a tool call; with `undo`, the
 *  text turn is taken out of the window as undone (retractRows with undone,
 *  as agent-framework's undo and shed do) before the tool call. */
function toolOnlyRun(spoken: string, undo: boolean): Run {
  return async (agent, cm) => {
    cm.presentRows([]);
    const show = (participant: string, content: unknown[]) => {
      const id = cm.addMessage(participant, content as never);
      cm.presentRows([id]);
      return id;
    };
    show('user', text('Find the config file.'));
    show(agent.name, text('First look: src/ or lib/.'));
    show('user', text('Go on.'));
    const turn = show(agent.name, text(spoken));
    if (undo) {
      cm.retractRows([turn], { undone: true });
      expect(cm.windowStatusOf(turn)).toBe('undone');
    }
    show(agent.name, [{ type: 'tool_use', id: 'tu-1', name: 'look', input: {} }]);
    show('user', [{ type: 'tool_result', toolUseId: 'tu-1', content: 'ok' }]);
    return { speech: '', toolCallsCount: 1 };
  };
}

async function answerOf(run: Run): Promise<string> {
  const h = await harness(run);
  try {
    const res = await h.subagent.handleToolCall(launch('spawn', 'scout'));
    expect(res.success).toBe(true);
    return (res.data as { summary: string }).summary;
  } finally { await h.cleanup(); }
}

describe("a tool-only run's answer", () => {
  test('is the newest text turn the window holds', async () => {
    expect(await answerOf(toolOnlyRun('It is in src/.', false))).toBe('It is in src/.');
  }, 20_000);

  test('is not a text turn an undo or a shed took out of the window, but the newest one it holds', async () => {
    expect(await answerOf(toolOnlyRun('It is in src/.', true))).toBe('First look: src/ or lib/.');
  }, 20_000);

  // Host #485 bot review wave 2, finding 29: a stored row the window doesn't
  // hold yet (status 'out'), such as another agent's mail held out of it past
  // the run's end, was never shown to the subagent either.
  test('is not a text row stored after it that the window does not hold, but the newest one it holds', async () => {
    const run: Run = async (agent, cm) => {
      cm.presentRows([]);
      const show = (participant: string, content: unknown[]) => {
        const id = cm.addMessage(participant, content as never);
        cm.presentRows([id]);
        return id;
      };
      show('user', text('Find the config file.'));
      show(agent.name, text('It is in src/.'));
      const mail = cm.addMessage('mira', text('Mail from mira, not shown to the subagent.') as never);
      expect(cm.windowStatusOf(mail)).toBe('out');
      show(agent.name, [{ type: 'tool_use', id: 'tu-1', name: 'look', input: {} }]);
      show('user', [{ type: 'tool_result', toolUseId: 'tu-1', content: 'ok' }]);
      return { speech: '', toolCallsCount: 1 };
    };
    expect(await answerOf(run)).toBe('It is in src/.');
  }, 20_000);

  // Host #485 bot review wave 3, finding 24: every run above presents its
  // window, so neither of these paths was run.
  /** A run that stores a text turn and then a tool call, on `cm` as `prepare` leaves it, presenting nothing. */
  const storedOnly = (prepare: (cm: ContextManager) => void): Run => async (agent, cm) => {
    prepare(cm);
    cm.addMessage('user', text('Find the config file.') as never);
    cm.addMessage(agent.name, text('It is in src/.') as never);
    cm.addMessage(agent.name, [{ type: 'tool_use', id: 'tu-1', name: 'look', input: {} }] as never);
    cm.addMessage('user', [{ type: 'tool_result', toolUseId: 'tu-1', content: 'ok' }] as never);
    return { speech: '', toolCallsCount: 1 };
  };

  test('is the newest text turn on a legacy window, where the window is the record', async () => {
    expect(await answerOf(storedOnly((cm) => {
      expect(cm.windowMode()).toBe('legacy');
    }))).toBe('It is in src/.');
  }, 20_000);

  test('is the newest text turn from a context manager without windowStatusOf', async () => {
    expect(await answerOf(storedOnly((cm) => {
      (cm as unknown as { windowStatusOf?: unknown }).windowStatusOf = undefined;
    }))).toBe('It is in src/.');
  }, 20_000);
});
