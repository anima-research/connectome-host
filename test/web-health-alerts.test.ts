/**
 * WebUI alert strip, /healthz reconciliation (web/src/health-alerts.ts):
 * a compression-quarantine or inference-exhausted row clears once its agent
 * leaves the snapshot's agents list, as an ephemeral subagent does when it is
 * torn down (#149), whatever raised the row. Rows of other kinds stay.
 */
import { test, expect } from 'bun:test';
import { planHealthAlerts } from '../web/src/health-alerts';
import type { HealthSnapshot } from '../web/src/Health';

type Alerts = Map<string, { message: string }>;

/** Apply a plan as App.tsx does: its removals, then its upserts. */
function apply(h: HealthSnapshot, alerts: Alerts): void {
  const plan = planHealthAlerts(h, alerts);
  for (const key of plan.remove) alerts.delete(key);
  for (const u of plan.upsert) alerts.set(`${u.agent}:${u.kind}`, { message: u.message });
}

const SUB = 'spawn-reader-1760000000';

test("a quarantine row counts records as records, and spans once the snapshot lists them", () => {
  const alerts: Alerts = new Map();
  apply({
    agents: [{ name: 'main' }, { name: SUB }],
    compressionQuarantine: { main: { count: 3 }, [SUB]: { count: 3, spans: [{}, {}] } },
  }, alerts);
  expect(alerts.get('main:compression-quarantine')!.message)
    .toBe('3 quarantine record(s) in compression quarantine (one span can hold several) — spans stay raw and will eventually exhaust the context budget.');
  expect(alerts.get(`${SUB}:compression-quarantine`)!.message)
    .toBe('2 span(s) in compression quarantine (3 record(s)) — spans stay raw and will eventually exhaust the context budget.');
});

test('a subagent quarantine row clears when the subagent leaves the snapshot', () => {
  const alerts: Alerts = new Map();
  apply({
    agents: [{ name: 'main' }, { name: SUB }],
    compressionQuarantine: { main: { count: 0 }, [SUB]: { count: 1 } },
  }, alerts);
  expect(alerts.has(`${SUB}:compression-quarantine`)).toBe(true);

  // Torn down: gone from the agent list and from the quarantine map.
  apply({ agents: [{ name: 'main' }], compressionQuarantine: { main: { count: 0 } } }, alerts);
  expect(alerts.has(`${SUB}:compression-quarantine`)).toBe(false);
});

test('a subagent inference-exhausted row clears when the subagent leaves the snapshot', () => {
  const alerts: Alerts = new Map();
  apply({ agents: [{ name: 'main' }, { name: SUB, consecutiveInferenceFailures: 4 }] }, alerts);
  expect(alerts.has(`${SUB}:inference-exhausted`)).toBe(true);

  apply({ agents: [{ name: 'main' }] }, alerts);
  expect(alerts.has(`${SUB}:inference-exhausted`)).toBe(false);
});

test('a row a live trace raised clears too, once its agent leaves', () => {
  const alerts: Alerts = new Map([[`${SUB}:compression-quarantine`, { message: 'from a live trace' }]]);
  apply({ agents: [{ name: 'main' }], compressionQuarantine: { main: { count: 0 } } }, alerts);
  expect(alerts.has(`${SUB}:compression-quarantine`)).toBe(false);
});

test("a listed agent's row stays when the snapshot has no quarantine entry for it, as when its read fails", () => {
  const alerts: Alerts = new Map();
  apply({ agents: [{ name: SUB }], compressionQuarantine: { [SUB]: { count: 2 } } }, alerts);
  apply({
    agents: [{ name: SUB }],
    compressionQuarantine: {},
    readFailures: { [SUB]: { compressionQuarantine: 'context manager not initialized' } },
  }, alerts);
  expect(alerts.has(`${SUB}:compression-quarantine`)).toBe(true);
});

test("a departed agent's rows of other kinds stay, as does a framework-wide row of another kind", () => {
  const alerts: Alerts = new Map([
    [`${SUB}:hard-down`, { message: '3 consecutive inference failures. Last reason: overloaded' }],
    ['framework:provider-wait', { message: 'recorded provider waits could not be read' }],
  ]);
  apply({ agents: [{ name: 'main' }], compressionQuarantine: { main: { count: 0 } } }, alerts);
  expect([...alerts.keys()].sort()).toEqual(['framework:provider-wait', `${SUB}:hard-down`]);
});

test("a streak row comes at three failures, and is rewritten when its count changes, with the last error", () => {
  const alerts: Alerts = new Map();
  apply({ agents: [{ name: 'main', consecutiveInferenceFailures: 2 }] }, alerts);
  expect(alerts.has('main:inference-exhausted')).toBe(false);

  apply({ agents: [{ name: 'main', consecutiveInferenceFailures: 3 }] }, alerts);
  expect(alerts.get('main:inference-exhausted')?.message).toBe('3 consecutive inference failures — agent is down.');

  // The count alone changes, with a last inference that names no error.
  apply({ agents: [{ name: 'main', consecutiveInferenceFailures: 5, lastInference: {} }] }, alerts);
  expect(alerts.get('main:inference-exhausted')?.message).toBe('5 consecutive inference failures — agent is down.');

  apply({
    agents: [{ name: 'main', consecutiveInferenceFailures: 9, lastInference: { lastError: 'HTTP 529 overloaded' } }],
  }, alerts);
  expect(alerts.get('main:inference-exhausted')?.message)
    .toBe('9 consecutive inference failures — agent is down. Last: HTTP 529 overloaded');
});

test('a snapshot without the sections (older host) clears nothing', () => {
  const alerts: Alerts = new Map();
  apply({
    agents: [{ name: SUB, consecutiveInferenceFailures: 3 }],
    compressionQuarantine: { [SUB]: { count: 1 } },
  }, alerts);
  expect(alerts.size).toBe(2);
  apply({}, alerts);
  expect(alerts.size).toBe(2);
});

test('present agents keep the existing behaviour', () => {
  const alerts: Alerts = new Map();
  const down = { agents: [{ name: 'main', consecutiveInferenceFailures: 3 }], compressionQuarantine: { main: { count: 2 } } };
  apply(down, alerts);
  expect([...alerts.keys()].sort()).toEqual(['main:compression-quarantine', 'main:inference-exhausted']);
  // An unchanged condition is not rewritten.
  expect(planHealthAlerts(down, alerts).upsert).toEqual([]);
  apply({ agents: [{ name: 'main' }], compressionQuarantine: { main: { count: 0 } } }, alerts);
  expect(alerts.size).toBe(0);
});
