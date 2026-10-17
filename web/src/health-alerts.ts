/**
 * /healthz reconciliation of the alert strip's condition rows (compression
 * quarantine and inference-exhausted), worked out as a plan the page applies.
 * Kept free of Solid and the DOM so it can be tested alone.
 *
 * A row of either kind whose agent is missing from the snapshot's `agents`
 * list is removed, whatever raised it: the agent was torn down (an ephemeral
 * subagent), and no later snapshot would clear the row. Rows of other kinds
 * are left to the page's own handlers for them. agent-framework 0.22.2 sends
 * no `hard-down-clear`, so a hard-down row leaves only by a dismissal, for a
 * present agent and a departed one alike.
 */

import type { HealthSnapshot } from './Health';

export interface HealthAlertUpsert {
  kind: string;
  agent: string;
  message: string;
}

export interface HealthAlertPlan {
  upsert: HealthAlertUpsert[];
  remove: string[];
}

const QUARANTINE = 'compression-quarantine';
const EXHAUSTED = 'inference-exhausted';

/** The agent part of a `${agent}:${kind}` key, or undefined for another kind. */
function agentOf(key: string, kind: string): string | undefined {
  const suffix = `:${kind}`;
  return key.endsWith(suffix) ? key.slice(0, -suffix.length) : undefined;
}

export function planHealthAlerts(
  h: HealthSnapshot,
  current: ReadonlyMap<string, { message: string }>,
): HealthAlertPlan {
  const plan: HealthAlertPlan = { upsert: [], remove: [] };
  const quarantine = h.compressionQuarantine;
  for (const [agent, q] of Object.entries(quarantine ?? {})) {
    const key = `${agent}:${QUARANTINE}`;
    if ((q.count ?? 0) > 0) {
      if (!current.has(key)) {
        plan.upsert.push({
          kind: QUARANTINE,
          agent,
          message: `${q.count} chunk(s) in compression quarantine — spans stay raw and will eventually exhaust the context budget.`,
        });
      }
    } else {
      plan.remove.push(key);
    }
  }

  const agents = h.agents;
  for (const a of agents ?? []) {
    const key = `${a.name}:${EXHAUSTED}`;
    const streak = a.consecutiveInferenceFailures ?? 0;
    if (streak >= 3) {
      const message = `${streak} consecutive inference failures — agent is down.`
        + (a.lastInference?.lastError ? ` Last: ${a.lastInference.lastError}` : '');
      // Only touch the entry when the condition actually changed —
      // rewriting `at` every poll would show a perpetual "5s ago" and
      // re-sort the strip on every cycle.
      if (current.get(key)?.message !== message) {
        plan.upsert.push({ kind: EXHAUSTED, agent: a.name, message });
      }
    } else {
      plan.remove.push(key);
    }
  }
  // Departed agents; a snapshot without `agents` (an older host) says nothing.
  if (Array.isArray(agents)) {
    const present = new Set(agents.map((a) => a.name));
    for (const key of current.keys()) {
      const agent = agentOf(key, EXHAUSTED) ?? agentOf(key, QUARANTINE);
      if (agent !== undefined && !present.has(agent)) plan.remove.push(key);
    }
  }
  return plan;
}
