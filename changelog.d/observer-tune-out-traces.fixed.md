- **Web UI observers** with the `ops` scope receive agent-framework's
  `tune-out:announced`, `tune-out:announce-failed` and
  `tune-out:wake-budget-paused` traces, which carry ids, counts and an
  error, never text, and its wake onboarding's `gate:onboarding-offered`
  and `gate:onboarding-decided` (agent-framework #957), which carry the
  server's id, the offer's digest, a count of rules or the names of the
  rules accepted, and the policy or the decision, never text. The host's
  trace table had no entry for them, so they went to full clients only.
