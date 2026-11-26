import { expect, test } from 'bun:test';
import { opsAlertLine, opsAlertOf, type OpsAlertEntry } from '../src/state/ops-alerts.js';

test('one agent retains separate refusal-marker alerts for two servers', () => {
  const active = new Map<string, OpsAlertEntry>();
  for (const serverId of ['discord-east', 'discord-west']) {
    const alert = opsAlertOf({
      kind: 'refusal-reaction-unavailable',
      agentName: 'agent',
      message: `Refusal marker unavailable on ${serverId}`,
      data: { serverId },
    });
    opsAlertLine(active, alert.kind, alert.agent, alert.message, alert.key);
  }
  expect([...active.values()].map(({ message, count }) => [message, count])).toEqual([
    ['Refusal marker unavailable on discord-east', 1],
    ['Refusal marker unavailable on discord-west', 1],
  ]);
});
