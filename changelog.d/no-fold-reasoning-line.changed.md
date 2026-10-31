- The host no longer appends a paragraph about folds to the system prompt of
  agents on models it records as binding ("When your context folds, the
  reasoning behind your earlier replies leaves it…", added in 0.16.0). An
  agent isn't told about the mechanics of its own memory or reasoning in
  standing text: it gives no information the agent can act on, and invites the
  agent to keep thinking about it. A prompt that still carries the paragraph,
  such as a fork's copy of its parent's prompt from a host that added it, has
  it taken off. A subagent's launch receipt no longer mentions it. The binding
  settings themselves (`thinkingBinding`, the drop control, the window) are
  unchanged. Where prompt caching is on, an affected agent's first request
  after the update writes its prompt cache in full, once. On a host that sets
  binding (`thinkingBinding.binds`), the shorter system prompt is a change of
  the request's head, so thinking blocks minted under the old head are left
  out once, as at any system-prompt change.
