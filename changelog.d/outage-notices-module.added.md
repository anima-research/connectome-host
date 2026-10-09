- **Outage notices: the host speaks in the agent's channels when the agent
  cannot.** New opt-in `modules.notices`, a sink of the framework's
  `ops:alert` stream. Each alert kind resolves to a tier — `reply` (hard-down,
  spent quota, expired/rejected credential, pending login, provider hold),
  `status` (context refusal, MCPL server down, unreadable quota, expiring
  credential, …) or `silent` (refusals, unknown kinds) — overridable per kind
  with `*` globs (`"auth-*": "reply"`). For `reply` kinds, a person who writes
  to the agent during the outage gets one canned host-attributed "cannot
  respond right now" line per episode in channels matching `reply.in` minus
  `reply.not` (channel-id patterns: `zulip:*`, exact ids — "notify on Zulip,
  never on Discord" is one line), the channel whose message triggered the
  failing turn is told the same, and every channel told gets one "can respond
  again" line on recovery. `statusChannels` get the operator-grade message
  (kind + error text) for `status` and `reply` kinds after `quietMs` (default
  60 s) without a clear. Episodes close on the kind's `-clear`, on the agent's
  next completed inference for framework kinds that have none, or on
  reconnect for `mcpl-down`. A notice whose chat server is itself absent is
  parked and delivered if the server comes back while the outage is on. One
  chronicle marker per episode tells the agent the host spoke for it. The
  recipe validates channel lists, tiers and timings at load.
