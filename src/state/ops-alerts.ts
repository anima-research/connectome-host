export interface OpsAlertEntry {
  kind: string;
  agent: string;
  message: string;
  count: number;
}

export interface OpsAlertLine {
  text: string;
  cleared: boolean;
}

export function credentialActionHint(data: unknown): string {
  const actions = (data as { actions?: unknown } | undefined)?.actions;
  if (!Array.isArray(actions) || actions.length === 0) return '';
  const ids = actions
    .map((a) => (a as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === 'string')
    .map((id) => (id === 'set-token' ? '/auth token <tok>' : `/auth ${id}`));
  return ids.length > 0 ? ` — ${ids.join(' | ')}` : '';
}

export function opsAlertOf(event: Record<string, unknown>, child?: string): { kind: string; agent: string; message: string } {
  const kind = typeof event.kind === 'string' ? event.kind : 'unknown';
  const agentName = typeof event.agentName === 'string' ? event.agentName : '?';
  const message = typeof event.message === 'string' ? event.message : '';
  return child === undefined
    ? { kind, agent: agentName, message: message + credentialActionHint(event.data) }
    : { kind, agent: `${child}/${agentName}`, message };
}

export function opsAlertLine(active: Map<string, OpsAlertEntry>, kind: string, agent: string, message: string): OpsAlertLine | null {
  if (kind.endsWith('-clear')) {
    const baseKey = `${agent}:${kind.slice(0, -'-clear'.length)}`;
    return active.delete(baseKey) ? { text: `✓ [${agent}] ${kind}: ${message}`, cleared: true } : null;
  }
  const key = `${agent}:${kind}`;
  const existing = active.get(key);
  active.set(key, { kind, agent, message, count: (existing?.count ?? 0) + 1 });
  const times = existing ? ` (×${existing.count + 1})` : '';
  return { text: `⚠ [${agent}] ${kind}${times}: ${message}`, cleared: false };
}
