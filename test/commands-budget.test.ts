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
    // The grammar main read, kept: a leading +, a leading-dot decimal, a trailing dot, trailing zeros.
    ['+200000', 200_000], ['.5k', 500], ['.5m', 500_000], ['5.k', 5000], ['200000.0', 200_000], ['1.5000k', 1500], ['0.0010k', 1],
  ];
  for (const [arg, tokens] of cases) {
    const { agents, budget } = fleet();
    // None of these is hidden by the rounded form, so none gets the exact count beside it.
    expect(budget(arg)[0]).toBe(`Stream budget set to ${fmtTokens(tokens)} tokens for all agents.`);
    expect(agents.map((a) => a.maxStreamTokens)).toEqual([tokens, tokens]);
  }
  // The exact count is shown only where the rounded form hides it (R1-6).
  expect(fleet().budget('1.001k')[0]).toBe('Stream budget set to 1.0k (1,001) tokens for all agents.');
  expect(fleet().budget('2.345m')[0]).toBe('Stream budget set to 2.3M (2,345,000) tokens for all agents.');
  expect(fleet().budget('1500')[0]).toBe('Stream budget set to 1.5k tokens for all agents.');
  expect(fleet().budget('999')[0]).toBe('Stream budget set to 999 tokens for all agents.');
});

test('/budget refuses an argument that is not a whole number of tokens, naming it, and changes nothing', () => {
  // parseInt read "1e5" as 1, "200,000" as 200, "1.5" as 1, "150abc" as 150
  // and "12k3" as 12, and the command set that for the whole fleet with a
  // line that read as a success.
  // '200 000', '150 k' and '200000 tokens' reach the parser whole: the dispatcher's
  // split on whitespace no longer leaves /budget its first word alone (R1-1).
  for (const bad of ['1e5', '200,000', '200_000', '200 000', '150 k', '200000 tokens', '1.5', '150abc', '12k3', '0.0015k', '0', '-5', 'abc', '0x10', '1e309k', '1e3k', '2.5e2k', 'Infinity', 'NaN', '99999999999999999999', '.', '+', '.k']) {
    const { agents, budget } = fleet();
    expect(budget(bad)).toEqual([`Invalid token count: "${bad}". Examples: 150k, 1m, 200000`]);
    expect(agents.map((a) => a.maxStreamTokens)).toEqual([150_000, 150_000]);
  }
});

test('parseTokenCount scales by digits, so a decimal with a suffix is exact', () => {
  // parseFloat('1.001') * 1000 is 1000.9999999999999 and 1.005 * 1000 is 1004.9999999999999 (R1-4).
  expect(parseTokenCount('1.001k')).toBe(1001);
  expect(parseTokenCount('1.005k')).toBe(1005);
  expect(parseTokenCount('2.345m')).toBe(2_345_000);
  expect(parseTokenCount(' 150k ')).toBe(150_000);
  expect(parseTokenCount('1.2345k')).toBeUndefined();
  expect(parseTokenCount('1.0')).toBe(1);
  expect(parseTokenCount('1.5')).toBeUndefined();
  // Without suffixes, a plain whole count for /history (R1-5).
  expect(parseTokenCount('20', 'none')).toBe(20);
  expect(parseTokenCount('20.0', 'none')).toBe(20);
  expect(parseTokenCount('2k', 'none')).toBeUndefined();
  expect(parseTokenCount('1e2', 'none')).toBeUndefined();
  expect(parseTokenCount('0x10', 'none')).toBeUndefined();
});
