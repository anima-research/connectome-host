- A recipe on `provider: "openai-codex"` that sets `agent.responses.serviceTier`
  or `agent.responses.compactThreshold` is told at start-up, in an
  `[agent-settings]` line, that the host sends those on `openai-responses`
  only, and that fast processing on Codex is `agent.codex.fastMode` (#644).
  Before, both were accepted and dropped with no sign.
