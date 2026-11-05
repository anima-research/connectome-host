import type { HealthSnapshot } from './Health';
import { quarantineHeld } from '@conhost/web/quarantine-alert';

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
          message: `${quarantineHeld(q)} — spans stay raw and will eventually exhaust the context budget.`,
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
      if (current.get(key)?.message !== message) {
        plan.upsert.push({ kind: EXHAUSTED, agent: a.name, message });
      }
    } else {
      plan.remove.push(key);
    }
  }
  if (Array.isArray(agents)) {
    const present = new Set(agents.map((a) => a.name));
    for (const key of current.keys()) {
      const agent = agentOf(key, EXHAUSTED) ?? agentOf(key, QUARANTINE);
      if (agent !== undefined && !present.has(agent)) plan.remove.push(key);
    }
  }
  return plan;
}
