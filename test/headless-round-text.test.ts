import { expect, test } from 'bun:test';
import { roundTexts } from '../src/headless.ts';

type Sent = Record<string, unknown>;

function follow(events: Array<Record<string, unknown>>): Sent[] {
  const sent: Sent[] = [];
  const see = roundTexts('resident', (event) => sent.push(event));
  for (const event of events) see(event);
  return sent;
}

const text = (agentName: string, content: string) => ({ type: 'inference:tokens', agentName, blockType: 'text', content });

test("a tool round's text goes out as inference:round_text, and the final round's as inference:speech alone", () => {
  expect(follow([
    { type: 'inference:started', agentName: 'resident' },
    text('resident', 'Checking.'),
    { type: 'inference:tokens', agentName: 'resident', blockType: 'thinking', content: 'Should I look?' },
    { type: 'inference:tool_calls_yielded', agentName: 'resident' },
    { type: 'inference:stream_resumed', agentName: 'resident' },
    text('resident', 'Done.'),
    { type: 'inference:completed', agentName: 'resident' },
  ])).toEqual([
    { type: 'inference:round_text', agentName: 'resident', content: 'Checking.' },
    { type: 'inference:speech', agentName: 'resident', content: 'Done.' },
  ]);
});

test("a subagent's rounds each go out as inference:round_text, and no inference:speech", () => {
  expect(follow([
    { type: 'inference:started', agentName: 'scout-1' },
    text('scout-1', 'Looking.'),
    { type: 'inference:tool_calls_yielded', agentName: 'scout-1' },
    { type: 'inference:stream_resumed', agentName: 'scout-1' },
    text('scout-1', 'Found it.'),
    { type: 'inference:completed', agentName: 'scout-1' },
  ])).toEqual([
    { type: 'inference:round_text', agentName: 'scout-1', content: 'Looking.' },
    { type: 'inference:round_text', agentName: 'scout-1', content: 'Found it.' },
  ]);
});

test("a silent start's text goes out as inference:round_text, and no inference:speech", () => {
  expect(follow([
    { type: 'inference:started', agentName: 'resident', silent: true },
    text('resident', 'Private self-check.'),
    { type: 'inference:completed', agentName: 'resident' },
  ])).toEqual([{ type: 'inference:round_text', agentName: 'resident', content: 'Private self-check.' }]);
});

test("text before an empty text token is a refused attempt's and goes with it", () => {
  expect(follow([
    { type: 'inference:started', agentName: 'scout-1' },
    text('scout-1', 'No'),
    text('scout-1', ''),
    text('scout-1', 'Yes'),
    { type: 'inference:tool_calls_yielded', agentName: 'scout-1' },
  ])).toEqual([{ type: 'inference:round_text', agentName: 'scout-1', content: 'Yes' }]);
});

test('a round that fails, is aborted or is exhausted sends nothing, and a round with no text sends no inference:round_text', () => {
  for (const end of ['inference:failed', 'inference:aborted', 'inference:exhausted']) {
    expect(follow([
      { type: 'inference:started', agentName: 'scout-1' },
      text('scout-1', 'Half a'),
      { type: end, agentName: 'scout-1' },
      { type: 'inference:completed', agentName: 'scout-1' },
    ])).toEqual([]);
  }
  expect(follow([
    { type: 'inference:started', agentName: 'scout-1' },
    { type: 'inference:tool_calls_yielded', agentName: 'scout-1' },
    { type: 'inference:stream_resumed', agentName: 'scout-1' },
    { type: 'inference:completed', agentName: 'scout-1' },
  ])).toEqual([]);
});

test('the primary agent\'s final round with no text still sends inference:speech with no text', () => {
  expect(follow([
    { type: 'inference:started', agentName: 'resident' },
    { type: 'inference:completed', agentName: 'resident' },
  ])).toEqual([{ type: 'inference:speech', agentName: 'resident', content: '' }]);
});
