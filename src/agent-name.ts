/**
 * Resolve which participant name an agent should use when several sources
 * (CLI flag, import-source sidecar, hard-coded default) disagree.
 *
 * Centralising this priority is load-bearing: warmup and conhost agree on
 * the name → strategy state lives at the same Chronicle namespace → the
 * live agent reads what warmup wrote. The original bug
 * (`agents/agent/autobio:summaries` empty vs `default/autobio:summaries`
 * populated) was caused by exactly this resolution drifting between two
 * scripts that defaulted differently and never compared notes.
 */

/** Which input the chosen name came from, for log lines and warnings. */
export type AgentNameSource = 'explicit' | 'sidecar' | 'default';

export interface ResolvedAgentName {
  name: string;
  source: AgentNameSource;
  /**
   * Set when both `explicit` and `sidecar` were provided and disagree.
   * Callers should warn on this — the agent will use `explicit` (because
   * an operator override beats a stored record) but the disagreement
   * means some other consumer (e.g. warmup that wrote summaries under
   * `sidecar`) has produced artifacts the live agent can't reach.
   */
  mismatch?: { explicit: string; sidecar: string };
}

/**
 * Priority: `explicit` (CLI flag or non-default recipe field) > `sidecar`
 * (per-session record written by the importer) > `default` (caller's
 * context-specific fallback — `"Claude"` for the claudeai-revival
 * scripts, `"agent"` for native conhost sessions).
 *
 * Empty strings on `explicit` or `sidecar` are treated as absent so an
 * accidental `--agent ""` or a sidecar with `"agentName": ""` doesn't
 * silently override the chain.
 */
export function resolveAgentName(inputs: {
  explicit?: string;
  sidecar?: string;
  default: string;
}): ResolvedAgentName {
  const explicit = nonEmpty(inputs.explicit);
  const sidecar = nonEmpty(inputs.sidecar);

  const mismatch = explicit && sidecar && explicit !== sidecar
    ? { explicit, sidecar }
    : undefined;

  if (explicit) return { name: explicit, source: 'explicit', ...(mismatch && { mismatch }) };
  if (sidecar) return { name: sidecar, source: 'sidecar' };
  return { name: inputs.default, source: 'default' };
}

function nonEmpty(s: string | undefined): string | undefined {
  return typeof s === 'string' && s.length > 0 ? s : undefined;
}
