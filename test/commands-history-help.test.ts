import { expect, test } from 'bun:test';
import { handleCommand } from '../src/commands.js';

function appWithMessages(count: number) {
  const messages = Array.from({ length: count }, (_, i) => ({
    id: `m${i + 1}`,
    participant: 'user',
    content: [{ type: 'text', text: `message ${i + 1}` }],
  }));
  const cm = { queryMessages: () => ({ messages }) };
  return { framework: { getAllAgents: () => [{ getContextManager: () => cm }] } } as never;
}

const rows = (command: string, count: number) =>
  handleCommand(command, appWithMessages(count)).lines.map((l) => l.text).filter((t) => /^ {2}\[m\d+\]/.test(t));

test("/help's /history line says what /history shows: the last n messages, and how many with no n", () => {
  const line = handleCommand('/help', appWithMessages(0)).lines.map((l) => l.text).find((t) => t.trimStart().startsWith('/history'));
  expect(line).toContain('Show the last n messages');
  const byDefault = Number(/\((\d+) by default\)/.exec(line ?? '')?.[1]);
  expect(byDefault).toBeGreaterThan(0);

  const shown = rows('/history', byDefault + 5);
  expect(shown).toHaveLength(byDefault);
  expect(shown[0]).toStartWith('  [m6] ');
  expect(shown.at(-1)).toStartWith(`  [m${byDefault + 5}] `);

  expect(rows('/history 3', byDefault + 5).map((t) => t.split(']')[0])).toEqual([
    `  [m${byDefault + 3}`,
    `  [m${byDefault + 4}`,
    `  [m${byDefault + 5}`,
  ]);
});

// /branchto looks its id up in the command agent's context (app.agentName,
// else the primary), so /history and /find, which give the ids, and
// /branches read that context too, not the first registered agent's: each
// agent's context is its own view (agent-framework #291).
test("/history, /find and /branches read the command agent's context, where /branchto looks their ids up", () => {
  const contextOf = (agent: string, branch: string) => {
    const messages = [{ id: `${agent}-1`, participant: 'user', content: [{ type: 'text', text: `${agent} keeps the ledger` }] }];
    return {
      queryMessages: () => ({ messages }),
      listBranches: () => [{ id: branch, name: branch, head: 1 }],
      currentBranch: () => ({ id: branch, name: branch, head: 1 }),
    };
  };
  const agents = [
    { name: 'clerk', state: { status: 'idle' }, getContextManager: () => contextOf('clerk', 'clerk-view') },
    { name: 'mira', state: { status: 'idle' }, getContextManager: () => contextOf('mira', 'mira-view') },
  ];
  const rolled: string[] = [];
  const app = {
    agentName: 'mira',
    branchState: { checkpoints: new Map() },
    framework: {
      getAllAgents: () => agents,
      getAgent: (name: string) => agents.find((a) => a.name === name),
      getPrimaryAgentName: () => 'clerk',
      getStore: () => ({ currentBranch: () => ({ name: 'mira-view' }) }),
      rollbackToMessage: (_agent: string, opts: { messageId: string }) => {
        rolled.push(opts.messageId);
        return new Promise(() => {});
      },
    },
  } as never;
  const said = (command: string) => handleCommand(command, app).lines.map((l) => l.text).join('\n');

  const history = said('/history');
  expect(history).toContain('[mira-1] user: mira keeps the ledger');
  expect(history).not.toContain('clerk-1');
  const found = said('/find ledger');
  expect(found).toContain('mira-1');
  expect(found).not.toContain('clerk-1');
  const branches = said('/branches');
  expect(branches).toContain('mira-view');
  expect(branches).not.toContain('clerk-view');

  expect(said('/branchto mira-1')).toStartWith('Branching at [mira-1]');
  expect(rolled).toEqual(['mira-1']);
});
