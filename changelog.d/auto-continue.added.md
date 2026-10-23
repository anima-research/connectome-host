- **Operators:** recipes take `agent.autoContinue` (`true`, or
  `{ "maxConsecutive": 1–20 }`, default 3; off when omitted), passed through
  to agent-framework's `AgentConfig.autoContinue`: a turn the model ends
  itself is followed by another until the agent calls `skip_reply`, ends on
  a `>>skip_reply` / `>>>skip_reply` envelope, or reaches the cap, and each
  next turn reads a short `[continue]` row. It takes effect with the
  agent-framework release that adds it; an earlier one ignores it. A value
  that isn't true, false or such an object is refused when the recipe loads.
- **Operators:** a fork's or spawn's orientation lists `auto-continue` among the
  agent settings a subagent stream doesn't take from its launch (`off` for
  the stream, beside the parent's), since subagents don't inherit it.
