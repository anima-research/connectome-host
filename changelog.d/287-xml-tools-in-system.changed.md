- An `anthropic-xml` recipe's agent with a system prompt and prompt caching
  now gets its tool definitions in its system block. Membrane's default
  spliced them into the transcript ten messages before its end, a point
  that moves with every message, so the tool block was written to the prompt
  cache again on every turn instead of being read from it (#287). The agent
  now meets its tools at the start of its context, where before it met them
  near the end. Each change of its tool list, as when an MCPL server
  connects or reconnects, writes its whole prompt to the cache once, and so
  does its first request after the upgrade. A recipe whose agent has no
  system prompt, or prompt caching off, keeps its tools where they were. The
  host's subagents take the placement their recipe's agent gets, whatever
  their own prompt or model, and the context panel's exact count builds the
  request the same way.
