- Add opt-in `modules.notices.home`: fixed Zulip status/incident topics through
  the existing authenticated MCP connection, without model turns or locus/open
  changes. Includes explicit operator-attested/unverified realm and self-echo
  preflight declarations, bounded private delivery state and per-record no-retry
  uncertainty. New observations queue during delivery, including possible
  connector echoes; overload drops only newly arriving work while at capacity.
  Inference completion can close a matching hard-down, off-path refusal or
  context-maintenance failure. An ended agent's tracked incidents close with
  a `subject-ended` record each, not a recovery. Alerts arriving after the
  agent ends can stay tracked, and an ending child can close a same-named
  unknown-kind server incident; `mcpl-down` incidents stay open.
  Framework-wide incidents are keyed apart from every agent and
  survive agent turns and ends, even for an agent named `framework`.
  Status reports tracked incidents, including after delayed incident delivery
  or an uncertain status, not routine turns.
  The host gives accepted work a bounded drain before framework teardown, while
  the connector is still open. Sends share five seconds; if the drain is still
  pending after about six seconds, framework teardown starts and closes MCP
  connections in parallel with module stops. The timeout does not cancel
  a pending write or send. `framework.stop()` waits for pending journal I/O in
  the framework being stopped. If an extension's `setFramework` throws after
  the new home is bound, that framework is never returned or stopped, so its
  save can race a later home's journal move-aside
  ([#714](https://github.com/anima-research/connectome-host/issues/714);
  separate fix in [#715](https://github.com/anima-research/connectome-host/pull/715)).
  Incident tracking and delivery evidence use finite retention windows;
  long subject labels repeated in status snapshots can
  push a save over the 2 MiB cap and disable home delivery for the run. Host
  startup and session switch rename existing journal and staging entries aside
  without following symlinks or reading journal contents. Incident IDs start fresh:
  an incident may be reported again, and its later clear may not match.
  The journal, Zulip display and attachment use only fixed labels, dates, IDs
  and counts, never diagnostic free text, plus subject labels. The configured
  host agent name and known MCP server IDs can appear verbatim, including
  agent-deployed server IDs loaded from the runtime MCP overlay after a
  restart. Framework-wide incidents and a child named `framework` both
  show as `subject=framework`
  but have distinct incident keys. Missing subjects show as `none`; other
  names show as `unlisted-` and a 12-hex-digit incident-key prefix. Status
  lists each tracked incident's kind and subject. A receipt whose attachment
  URLs are not on `declaredRealm` is recorded uncertain. Supported connectors:
  upstream `anima-research/zulip_mcp` `main` at `bd500ba8`, and the
  `theaspirational/zulip_mcp` fork at `61298a12` (nullable schemas and tagged
  receipt IDs). Legacy notices are unchanged when home is omitted;
  live connector/realm/echo qualification and activation remain operator work.
  Known limits: on macOS 26, the drain's five-second send budget can exhaust
  launchd's five-second service exit window, so SIGKILL can land before
  framework teardown begins. A connector that reconnects while handling every
  home send, with every send uncertain, repeats status sends with no retry limit (the
  status topic can show repeated posts and stderr logs each uncertain send) until a
  status is acknowledged, the reconnects stop or the host stops. A `refusal` or
  `context-refusal` incident is not closed by `inference:completed` alone, as
  it is in legacy notices; it stays in the tracked incident IDs of later status
  posts until a matching turn end or clear, eviction, restart or session switch.
- Recognize home-notice log prefixes in bug reports.
