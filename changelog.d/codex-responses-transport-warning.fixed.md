- A recipe that sets what the other OpenAI provider reads is told at start-up,
  in an `[agent-settings]` line on stderr and in the runtime's log (#644): on
  `openai-codex`, `agent.responses.serviceTier` and `compactThreshold`, which
  the host sends on `openai-responses` only, with `agent.codex.fastMode` (or
  `/fast on`) named for a `priority` tier; on any other provider,
  `agent.codex.fastMode`, which the host reads on `openai-codex` only, with
  `agent.responses.serviceTier: "priority"` named for `fastMode` on
  `openai-responses`. The other provider's setting is named only where the
  recipe doesn't already have it. Before, each was accepted and dropped with
  no sign.
