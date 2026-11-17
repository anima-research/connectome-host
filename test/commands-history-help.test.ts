import { expect, test } from 'bun:test';
import { handleCommand } from '../src/commands.js';
import { HISTORY_PAGE_MAX } from '../src/web/protocol.js';

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
  const byDefault = Number(/\((\d+) by default/.exec(line ?? '')?.[1]);
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

test('/history refuses a count that is not a whole number above 0, naming it, and shows at most 500 with a last line only where rows were held back', () => {
  // "1e309" read as Infinity, and slice(-Infinity) printed every message in the
  // command's result; "abc", "0" and "-5" fell back to 20 without a word.
  // Number()'s wider grammar ("0x10", "0b11", "1e3") is refused; a leading +
  // and a decimal part of zeros, which main read, still are (#669 reads the same).
  for (const bad of ['1e309', 'abc', '0', '-5', '2.5', '1e9999', 'NaN', 'Infinity', '0x10', '0b11', '1e3', '.5', '5.5', '.', '+', '0.0', '00']) {
    const lines = handleCommand(`/history ${bad}`, appWithMessages(30)).lines.map((l) => l.text);
    expect(lines).toEqual([`Invalid message count: "${bad}". Examples: 20, 200`]);
  }
  for (const ok of ['3', '+3', '3.0', '3.00', '3.', '003']) expect(rows(`/history ${ok}`, 30)).toHaveLength(3);
  expect(rows('/history 1', 30)).toHaveLength(1);
  // Every count past the cap means the cap, a 20-digit one too (R2-7).
  expect(rows('/history 9007199254740992', 30)).toHaveLength(30);
  expect(rows('/history 99999999999999999999', 600)).toHaveLength(500);

  // The whole result, so the cap line is seen or not seen (R2-1, R2-5).
  const all = (command: string, count: number) => handleCommand(command, appWithMessages(count)).lines.map((l) => l.text);
  // A big count on a small store: every row, no line about a cap.
  const small = all('/history 5000', 30);
  expect(small[0]).toBe('--- History (30 messages) ---');
  expect(small).toHaveLength(31);
  expect(small.at(-1)).toStartWith('  [m30] ');
  expect(all('/history 5000', 0)).toEqual(['--- History (0 messages) ---']);
  // Past the cap on a big store: the last 500, then the line, last (R2-3).
  const capped = all('/history 5000', 600);
  expect(capped[0]).toBe('--- History (600 messages) ---');
  expect(capped[1]).toStartWith('  [m101] ');
  expect(capped).toHaveLength(502);
  expect(capped.at(-1)).toBe('Showing the last 500 of 600; /find <text> searches them all.');
  // One row past the cap is enough for the line (R3-4).
  expect(all('/history 500', 501).at(-1)).toBe('Showing the last 500 of 501; /find <text> searches them all.');
  // At the cap, held rows still get the line; a store of exactly 500 doesn't.
  expect(all('/history 500', 600).at(-1)).toBe('Showing the last 500 of 600; /find <text> searches them all.');
  expect(all('/history 500', 500)).toHaveLength(501);
  expect(all('/history 500', 500).at(-1)).toStartWith('  [m500] ');
  expect(all('/history 499', 600)).toHaveLength(500);
  expect(all('/history 499', 600).at(-1)).toStartWith('  [m600] ');
});

test("/history's cap is the Web UI's history page maximum, one constant", () => {
  expect(HISTORY_PAGE_MAX).toBe(500);
  expect(rows('/history 501', 600)).toHaveLength(HISTORY_PAGE_MAX);
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
