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

/**
 * Fail-closed env-flag parse: ONLY an allowlisted affirmative — `1` or
 * `true` (case-insensitive, trimmed) — enables the flag. Everything else is
 * off, matching the documented contract (an explicit `GATE_TELEMETRY=1`
 * declaration). The previous parser treated every non-empty string except
 * '0'/'false' as ON, so `off`, `no` and ordinary typos ENABLED telemetry —
 * exactly the values operators use to turn a flag off (#119). Unrecognized
 * non-empty values warn once, naming the value and the accepted forms, so a
 * typo explains itself instead of silently disabling (or enabling) anything.
 */
const ENV_FLAG_ON = new Set(['1', 'true']);
const ENV_FLAG_OFF = new Set(['', '0', 'false', 'off', 'no']);
const warnedEnvFlagValues = new Set<string>();
function envFlag(value: string | undefined, name = 'GATE_TELEMETRY'): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  if (ENV_FLAG_ON.has(normalized)) return true;
  if (!ENV_FLAG_OFF.has(normalized) && !warnedEnvFlagValues.has(value)) {
    warnedEnvFlagValues.add(value);
    console.error(
      `[gate-telemetry] ${name}=${JSON.stringify(value)} is not a recognized value — ` +
        `treating as DISABLED (fail-closed). Use ${name}=1 (or true) to enable.`,
    );
  }
  return false;
}

/** What the framework knows about the turn in progress (agent-framework InferenceRequest). */
export interface TurnTrigger {
  reason: string;
  source: string;
  /** Routing locus of the turn (direct channel wakes set it). */
  channelId?: string;
  /** Telemetry-only channel of a gate-batched wake (agent-framework ≥0.14:
   *  InferenceRequest.wakeChannelId) — never a locus. */
  wakeChannelId?: string;
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
  // channel/push events, directly or batched through the framework's EventGate
  if (r === 'mcpl:channel-incoming' || r === 'mcpl:push-event' || r.startsWith('discord') || r.startsWith('gate:') || s === 'gate') return 'event';
  // a person typing at the host itself: headless IPC, CLI, TUI, web UI, API
  if (r === 'external-message' || ['headless', 'cli', 'tui', 'webui', 'api'].includes(s)) return 'operator';
  if (r.includes('admin') || r.includes('nudge') || r.includes('unstick') || r.includes('operator')) return 'operator';
  return r.replace(/[^a-z0-9:_-]/g, '').slice(0, 40) || 'event';
}

/**
 * Header-safe attribute. HTTP header values are ByteStrings: a single
 * non-ASCII code point (an emoji in a channel name, say) makes Fetch throw
 * and would turn telemetry into a failed model request. So the rule is
 * fail-closed on the WHOLE value — visible ASCII (0x20..0x7e) only, clipped
 * to 120 — never character-stripping, which would mint a different id and
 * collide provenance. An unsendable id is simply not sent (null → dropped).
 */
function attr(v: string | undefined): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  for (let i = 0; i < t.length; i++) {
    const code = t.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return null;
  }
  return t.slice(0, 120);
}

/**
 * Which agent's turn may be stamped onto a request, given that ONE provider
 * adapter — and therefore one header hook — serves every agent in the
 * process (primary, subconscious, forks, ephemerals) and the hook cannot
 * tell whose request it is decorating. Rule: stamp the primary's trigger
 * only while the primary is the ONLY agent with a turn in flight; any other
 * agent mid-turn → withhold (null), never guess. Debt is per agent, not per
 * request, so it may always be read from the primary.
 */
export function stampedTrigger(view: {
  agents: string[];
  primary?: string | null;
  triggerOf: (agent: string) => TurnTrigger | null | undefined;
}): TurnTrigger | null {
  const primary = view.primary ?? (view.agents.length === 1 ? view.agents[0] : undefined);
  if (!primary) return null;
  for (const a of view.agents) {
    if (a !== primary && view.triggerOf(a)) return null;
  }
  const t = view.triggerOf(primary);
  return t ?? null;
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
    out['x-gate-channel'] = attr(t.channelId ?? t.wakeChannelId);
    out['x-gate-counterparty'] = attr(t.counterparty);
    return out;
  };
}
