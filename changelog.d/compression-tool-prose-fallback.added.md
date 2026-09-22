- Recipe `agent.strategy.compressionToolProseFallback: { intoTool, fromTools,
  field?, result?, minChars? }` — validated loudly (a malformed value is an
  error, never a silently disabled rung) and passed through to Context
  Manager's tool-prose hoist fallback, which retries a refused L1 compression
  with long `fromTools` arguments (e.g. a diary kept in `skip_reply.reason`)
  moved into calls to a note-taking tool the agent really has
  (agent-framework's `journal`). Requires the context-manager and
  agent-framework versions that carry the rung and the tool.
