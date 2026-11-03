export type AgentNameSource = 'explicit' | 'sidecar' | 'default';

export interface ResolvedAgentName {
  name: string;
  source: AgentNameSource;
  mismatch?: { explicit: string; sidecar: string };
}

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
