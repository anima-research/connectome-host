import { describe, expect, test } from 'bun:test';
import { HEALTH_STRINGS, keepNamedStrings } from '../src/modules/web-ui-observers.js';
import { agentActivity, waitText } from '../web/src/composition-text';

const inFor = (ms: number) => `${Math.ceil(ms / 1000)}s`;

describe("the health row's word for what an agent is doing", () => {
  test('a turn waiting for its next try reads retrying, with what it retries as, which try is next, and when', () => {
    const a = { status: 'idle', turnAlive: true, retrying: { since: 100, until: 61_000, nextTry: 7, maxTries: 13, retryClass: 'overloaded' } };
    expect(agentActivity(a, 1_000, inFor)).toEqual({ word: 'retrying', detail: 'overloaded · try 7 of 13 · in 60s' });
  });

  test('it says what the policy said, and no more', () => {
    expect(agentActivity({ status: 'idle', retrying: { nextTry: 2, until: 5_000 } }, 1_000, inFor)).toEqual({ word: 'retrying', detail: 'try 2 · in 4s' });
    expect(agentActivity({ status: 'idle', retrying: {} }, 1_000, inFor)).toEqual({ word: 'retrying' });
  });

  test('a wait whose time has come reads due now, until the next poll', () => {
    expect(agentActivity({ status: 'idle', retrying: { nextTry: 3, until: 900 } }, 1_000, inFor)).toEqual({ word: 'retrying', detail: 'try 3 · due now' });
  });

  test('an idle state with a turn alive says so; any other state reads as it is', () => {
    expect(agentActivity({ status: 'idle', turnAlive: true, retrying: null }, 0, inFor)).toEqual({ word: 'idle+turn-alive' });
    expect(agentActivity({ status: 'idle', turnAlive: false, retrying: null }, 0, inFor)).toEqual({ word: 'idle' });
    expect(agentActivity({ status: 'streaming', turnAlive: true }, 0, inFor)).toEqual({ word: 'streaming' });
    expect(agentActivity({}, 0, inFor)).toEqual({ word: '?' });
  });

  test('a retry record wins over any state and over turnAlive', () => {
    const retrying = { nextTry: 2, until: 5_000 };
    for (const status of ['idle', 'streaming', 'inferring', 'waiting_for_tools']) {
      for (const turnAlive of [true, false, undefined]) {
        expect(agentActivity({ status, turnAlive, retrying }, 1_000, inFor).word).toBe('retrying');
      }
    }
  });

  test('it counts down from the time it is given, as the panel gives it the snapshot\'s', () => {
    expect(agentActivity({ status: 'idle', retrying: { until: 130_000 } }, 10_000).detail).toBe('in 2m');
  });

  test("an agent-framework without the fields reads its status, as before", () => {
    expect(agentActivity({ status: 'idle' }, 0, inFor)).toEqual({ word: 'idle' });
  });
});

describe('a health client gets the retry', () => {
  test('its class, a class name, and its numbers; no other string of it', () => {
    const snapshot = {
      agents: [{
        name: 'main', status: 'idle', turnAlive: true,
        retrying: { since: 100, until: 61_000, nextTry: 7, maxTries: 13, retryClass: 'overloaded', note: 'zz unnamed text' },
      }],
    };
    const sent = JSON.parse(JSON.stringify(keepNamedStrings(snapshot, HEALTH_STRINGS))) as typeof snapshot;
    const r = sent.agents[0]!.retrying as Record<string, unknown>;
    expect(r.retryClass).toBe('overloaded');
    expect(r.nextTry).toBe(7);
    expect(r.maxTries).toBe(13);
    expect(r.until).toBe(61_000);
    expect(r.since).toBe(100);
    expect(JSON.stringify(sent)).not.toContain('zz unnamed text');
    expect(sent.agents[0]!.turnAlive).toBe(true);
    expect(agentActivity(sent.agents[0]!, 1_000, inFor)).toEqual({ word: 'retrying', detail: 'overloaded · try 7 of 13 · in 60s' });
  });
});

describe('the countdown', () => {
  test('seconds under two minutes, rounded up', () => {
    expect(waitText(1)).toBe('1s');
    expect(waitText(59_001)).toBe('60s');
    expect(waitText(119_000)).toBe('119s');
    expect(waitText(119_500)).toBe('2m');
  });

  test('then minutes, then hours and minutes', () => {
    expect(waitText(150_000)).toBe('3m');
    expect(waitText(299_000)).toBe('5m');
    expect(waitText(3_569_000)).toBe('59m');
    expect(waitText(3_599_000)).toBe('1h 0m');
    expect(waitText(5_400_000)).toBe('1h 30m');
  });
});
