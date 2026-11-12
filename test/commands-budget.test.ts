import { expect, test } from 'bun:test';
import { handleCommand, parseTokenCount } from '../src/commands.js';
import { fmtTokens } from '../src/tui.js';

function fleet() {
  const agents = [
    { name: 'alpha', model: 'gpt-6.1-sol', maxStreamTokens: 150_000, lastStreamInputTokens: 42_000 },
    { name: 'beta', model: 'gpt-6.1-sol', maxStreamTokens: 150_000, lastStreamInputTokens: 10_000 },
  ];
  const app = { framework: { getAllAgents: () => agents } } as never;
  return { agents, budget: (arg: string) => handleCommand(`/budget ${arg}`, app).lines.map((l) => l.text) };
}

test('/budget takes a whole number of tokens, plain or with a k or m suffix, and sets it for every agent', () => {
  const cases: Array<[string, number]> = [
    ['200000', 200_000], ['150k', 150_000], ['150K', 150_000], ['1.5m', 1_500_000], ['0.5k', 500], ['1.1k', 1100], ['1.50k', 1500],
  ];
  for (const [arg, tokens] of cases) {
    const { agents, budget } = fleet();
    expect(budget(arg)[0]).toBe(`Stream budget set to ${fmtTokens(tokens)} tokens for all agents.`);
    expect(agents.map((a) => a.maxStreamTokens)).toEqual([tokens, tokens]);
  }
});

test('/budget refuses an argument that is not a whole number of tokens, naming it, and changes nothing', () => {
  // parseInt read "1e5" as 1, "200,000" as 200, "1.5" as 1, "150abc" as 150
  // and "12k3" as 12, and the command set that for the whole fleet with a
  // line that read as a success.
  for (const bad of ['1e5', '200,000', '200_000', '1.5', '150abc', '12k3', '0.0015k', '0', '-5', 'abc', '0x10', '1e309k', 'Infinity', 'NaN', '99999999999999999999']) {
    const { agents, budget } = fleet();
    expect(budget(bad)).toEqual([`Invalid token count: "${bad}". Examples: 150k, 1m, 200000`]);
    expect(agents.map((a) => a.maxStreamTokens)).toEqual([150_000, 150_000]);
  }
});

test('parseTokenCount scales by digits, so a decimal with a suffix is exact', () => {
  expect(parseTokenCount('1.1k')).toBe(1100);
  expect(parseTokenCount('2.345m')).toBe(2_345_000);
  expect(parseTokenCount(' 150k ')).toBe(150_000);
  expect(parseTokenCount('1.2345k')).toBeUndefined();
  expect(parseTokenCount('1.0')).toBeUndefined();
});
