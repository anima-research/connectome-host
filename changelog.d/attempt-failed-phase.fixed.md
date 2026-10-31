- An agent whose model call failed and is being tried again, or is held
  until a provider's limit lifts, no longer shows as failed in the Web UI
  and the TUI. Its node in the agent trees, a subagent's row, and the TUI's
  status line for the host's own agent show `attempt-failed` until its next
  attempt starts or its turn ends, the tree's in a colour of its own. The
  Web UI shows the failure's error when you hover over the phase, and the
  TUI on a fleet child's agent detail. A turn the TUI had moved to the
  background stays there through a failed attempt, and when it returns it
  shows what its earlier rounds wrote and the retry's answer, without the
  failed attempt's words. A turn that ends failed shows `failed` with its
  last error, or an error in the TUI's status line; one a stop ends shows
  `cancelled`, or idle. A fleet parent on an earlier release can show a
  child's `attempt-failed` agent in a plain colour and leave it out of its
  count of running agents. On a fleet child running agent-framework older
  than 0.27.0, a held turn whose retry is dropped ends with no event, so it
  shows `attempt-failed`, and counts as running, until that agent's next
  attempt starts.
