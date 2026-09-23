- Web UI: an always-visible liveness strip under the header shows, per MCPL
  server, connected / retrying (with the last connect error) and when the last
  inbound message arrived, and per agent when its last turn started and
  finished — with warnings when waking messages go unanswered for more than 5
  minutes or the host's liveness broadcasts stop ("host quiet"). Broadcast to
  `health`-scoped clients on change (throttled) and every 30 s.
