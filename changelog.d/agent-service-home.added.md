- Add opt-in `modules.notices.home`: fixed Zulip status/incident topics through
  the existing authenticated MCP connection, without model turns or locus/open
  changes. Includes explicit operator-attested/unverified realm and self-echo
  preflight declarations, bounded private delivery state and per-record no-retry
  uncertainty. Independent observations queue during delivery; overload drops
  only newly arriving work while at capacity. Status reports tracked incidents,
  not routine turns. Shutdown drains accepted work within a shared send budget
  and journals unsent work locally when it expires. Incident tracking and delivery evidence
  use finite retention windows rather than lifetime failure latches. Host
  startup and session switch rename existing journal and staging entries aside
  without following symlinks or reading journal contents. Incident IDs start fresh:
  an incident may be reported again, and its later clear may not match.
  The journal, Zulip display and attachment use only fixed labels, dates, IDs
  and counts, never diagnostic free text. Fork nullable schemas and branded
  receipts are supported. Legacy notices are unchanged when home is omitted;
  live connector/realm/echo qualification and activation remain operator work.
- Recognize home-notice log prefixes in bug reports.
