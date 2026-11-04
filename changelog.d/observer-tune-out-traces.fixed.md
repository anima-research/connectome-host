- **Web UI observers** with the `ops` scope receive agent-framework's
  `tune-out:announced`, `tune-out:announce-failed` and
  `tune-out:wake-budget-paused` traces, which carry ids, counts and an
  error, never text, and its wake onboarding's `gate:onboarding-offered`
  and `gate:onboarding-decided` (agent-framework #957), which carry the
  server's id, the offer's digest, a count of rules or the names of the
  rules accepted, and the policy or the decision, never text. The host's
  trace table had no entry for them, so they went to full clients only.
  A client with the `messages` scope also receives `message:lost` (the
  presentation release of agent-framework #844: a write a surgery's hold
  kept whose store threw at the release, named by its agent and the
  write's external id, never its text), as it receives `message:removed`.
  An ops observer also receives `gate:suppressed` (a suppress rule's name,
  the event type, server and channel; no content) and
  `gate:suppression-review` (counts and verdicts per rule), from
  agent-framework's event suppression (#975).
