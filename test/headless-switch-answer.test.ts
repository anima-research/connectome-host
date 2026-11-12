import { expect, test } from 'bun:test';
import { answerToQuiesce } from './switch-answer-child.js';

test('a fleet child with nothing in flight answers the switch\'s quiesce drained, with no work in flight beside it', async () => {
  const answer = await answerToQuiesce('quiet');
  expect(answer.ok).toBe(true);
  expect(answer.data).toMatchObject({ drained: true, activeTurnAgents: [], backgroundScripts: 0 });
  expect((answer.data as Record<string, unknown>).inFlight).toBeUndefined();
}, 20_000);

for (const [mode, named] of [
  ['credential', 'a credential action'],
  ['operator', 'an operator\'s work'],
  ['subagents', 'subagent runs'],
  ['switch-begun', 'a session switch'],
] as const) {
  test(`a fleet child with ${named} in flight says so in its answer to the switch's quiesce, beside the framework's drained`, async () => {
    const answer = await answerToQuiesce(mode);
    expect(answer.ok).toBe(true);
    expect(answer.data).toMatchObject({ drained: true, inFlight: [named] });
  }, 20_000);
}

test('a fleet child holding a text its framework refused says turn work is in flight in its answer to the switch\'s quiesce, though the framework reads drained', async () => {
  const answer = await answerToQuiesce('refused-text', [{ type: 'text', content: 'hello while the framework takes none' }]);
  expect(answer.ok).toBe(true);
  expect(answer.data).toMatchObject({ drained: true, inFlight: ['turn work'] });
}, 20_000);

test('a fleet child mid-turn answers the switch\'s quiesce undrained, naming the agent in its turn, and names no turn work beside it', async () => {
  const answer = await answerToQuiesce('mid-turn');
  expect(answer.ok).toBe(true);
  expect(answer.data).toMatchObject({ drained: false, activeTurnAgents: ['fixture'] });
  expect((answer.data as Record<string, unknown>).inFlight).toBeUndefined();
}, 20_000);
