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
