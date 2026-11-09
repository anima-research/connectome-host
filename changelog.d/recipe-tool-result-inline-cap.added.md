- Recipes accept `toolResultInlineMaxChars` at the top level: the
  residence's inline cap for tool results, in characters, passed to
  agent-framework's `FrameworkConfig.toolResultInlineMaxChars`. Left out,
  agent-framework's default stands, and a resident's own `agent_settings`
  value `tool_result_inline_max_chars` wins over it for that agent. A value
  that isn't a finite number of at least 1000, agent-framework's own
  minimum, stops the load, naming it. The default, what becomes of a result
  over the cap and how the cap in effect is reached are in that option's doc
  in agent-framework's types.
