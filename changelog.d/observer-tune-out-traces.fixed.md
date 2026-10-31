- **Web UI observers** with the `ops` scope receive agent-framework's
  `tune-out:announced`, `tune-out:announce-failed` and
  `tune-out:wake-budget-paused` traces, which carry ids, counts and an
  error, never text. The host's trace table had no entry for them, so they
  went to full clients only.
