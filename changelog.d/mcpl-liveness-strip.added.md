- Web UI: an always-visible liveness strip under the header shows, per MCPL
  server, connected / retrying (with the last connect error, including
  failures at boot) and when the last inbound message arrived, and per agent
  whether a turn is in flight and how the last one ended (completed, ended
  quietly via `skip_reply`/`sleep`, stopped, or failed). It warns when a
  waking message addressed to an agent has gone unanswered for more than 5
  minutes (the oldest pending wake, per agent; ephemeral subagents, the
  tune-out subconscious and a conversation router's trunk are exempt), and
  when the host's liveness broadcasts stop ("host quiet"). Broadcast to
  `health`-scoped clients on change (throttled) and every 30 s.
  - Fleet recipes: the strip shows the process it runs in. A conductor with no
    MCPL servers of its own shows only itself; child liveness isn't aggregated.
  - Complements the existing `mcpl-down` ops alert (raised after 5 failed
    reconnects): the strip shows connection state and boot failures
    continuously, the alert is the escalation.
