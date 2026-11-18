- Add opt-in `modules.notices.home`: fixed Zulip status/incident topics through
  the existing authenticated MCP connection, without model turns or locus/open
  changes. Includes explicit operator-attested/unverified realm and self-echo
  preflight declarations, bounded private delivery state and per-record no-retry
  uncertainty. Independent observations queue during delivery; overload drops
  only new work until the queue drains. Incident tracking and delivery evidence
  use finite retention windows rather than lifetime failure latches. Fork
  nullable schemas, branded receipts, literal message links and safe structured
  diagnostics are supported. Legacy notices are unchanged when omitted; live
  connector/realm/echo qualification and activation remain operator work.
- Recognize home-notice log prefixes in bug reports; diagnostic redaction uses
  `(redacted)` rather than a bracketed log-tag shape.
