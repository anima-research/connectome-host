/**
 * Household-gateway telemetry headers (x-gate-* stamps).
 *
 * The data boundary these headers exist under: a household inference gateway
 * records them into its ledger and STRIPS them before the vendor — the vendor
 * must never see them. That boundary is only real if the host refuses to
 * attach the stamps anywhere else, so attachment is double-gated:
 *
 *   1. `GATE_TELEMETRY=1` — the operator's explicit declaration that the
 *      configured base URL is such a gateway. Absent/false ⇒ never attach.
 *   2. `ANTHROPIC_BASE_URL` actually set — the flag alone must not stamp
 *      traffic that would go to the vendor's default endpoint.
 *
 * Fail-closed on both (review finding on the first wiring: the stamp was
 * attached unconditionally, so with no base URL configured the value went
 * straight to the vendor).
 *
 * Two stamps ride the same hook:
 *
 *   x-gate-debt-chunks   compression debt at request build (every lane — the
 *                        aux lane is where the debt series is most telling)
 *   x-gate-origin        WHY the turn fired: heartbeat | event | mail |
 *                        operator | <raw reason>  — stream lane ONLY
 *   x-gate-channel       where (adapter-namespaced id)     — stream lane ONLY
 *   x-gate-counterparty  who woke the agent (namespaced id) — stream lane ONLY
 *
 * The origin trio describes the agent's turn; a compression call running in
 * the background is not the turn, so on the 'complete' lane those three are
 * withheld (an older membrane that passes no lane gets them on every call —
 * documented, and the ledger's `streamed` flag lets a reader tell the lanes
 * apart regardless). Values are ids and short class words: never content,
 * never display names.
 */

/** Truthy env-flag parse: unset/''/'0'/'false' (any case) are off. */
function envFlag(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

/** What the framework knows about the turn in progress (agent-framework InferenceRequest). */
export interface TurnTrigger {
  reason: string;
  source: string;
  channelId?: string;
  counterparty?: string;
}

export interface DynamicHeadersContext {
  lane?: 'stream' | 'complete';
}

/**
 * Collapse the framework's free-form reason/source pair into the ledger's
 * origin classes. The raw reason survives when no class fits, clipped and
 * sanitized (ids and words only), so a new event kind shows up as itself
 * instead of vanishing into 'event'.
 */
export function originClass(trigger: TurnTrigger): string {
  const r = trigger.reason.toLowerCase();
  const s = trigger.source.toLowerCase();
  if (r.includes('heartbeat') || s.includes('heartbeat')) return 'heartbeat';
  if (r.includes('mail') || s.includes('mail')) return 'mail';
  if (r === 'mcpl:channel-incoming' || r === 'mcpl:push-event' || r.startsWith('discord')) return 'event';
  if (r.includes('admin') || r.includes('nudge') || r.includes('unstick') || r.includes('operator') || s === 'api' || s === 'tui') return 'operator';
  return r.replace(/[^a-z0-9:_-]/g, '').slice(0, 40) || 'event';
}

/** Header-safe attribute: printable characters only, clipped; empty → null (not sent). */
function attr(v: string | undefined): string | null {
  if (typeof v !== 'string') return null;
  let clean = '';
  for (const ch of v) {
    const code = ch.charCodeAt(0);
    if (code >= 0x20 && code !== 0x7f) clean += ch;
  }
  clean = clean.trim();
  return clean ? clean.slice(0, 120) : null;
}

export function gateTelemetryHeaders(
  env: Record<string, string | undefined>,
  pendingDebtChunks: () => number | null,
  activeTrigger: () => TurnTrigger | null = () => null,
): ((ctx?: DynamicHeadersContext) => Record<string, string | number | null>) | undefined {
  if (!envFlag(env.GATE_TELEMETRY)) return undefined;
  if (!env.ANTHROPIC_BASE_URL) return undefined;
  return (ctx?: DynamicHeadersContext) => {
    const out: Record<string, string | number | null> = { 'x-gate-debt-chunks': pendingDebtChunks() };
    if (ctx?.lane === 'complete') return out;
    const t = activeTrigger();
    if (!t) return out;
    out['x-gate-origin'] = originClass(t);
    out['x-gate-channel'] = attr(t.channelId);
    out['x-gate-counterparty'] = attr(t.counterparty);
    return out;
  };
}
