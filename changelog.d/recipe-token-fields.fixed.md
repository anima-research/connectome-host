- `agent.maxTokens`, `agent.contextBudgetTokens` and
  `modules.subagents.defaultMaxTokens` must be finite numbers, refused at load
  naming the field and the value, as 0.25.0 refuses `agent.maxStreamTokens`:
  JSON `1e309` parses to `Infinity`, which the saved recipe wrote back as
  `null`, so the next start ran on the default where the operator wrote a
  number (every subagent on the framework's 4,096). A `0`, a negative number,
  a fraction or a string in the two agent fields loads as before; what the
  start's `[fit]` line says about them is unchanged where the host knows the
  model's window, and on a provider or model it knows no window for the line
  now names an `agent.maxTokens` that isn't a positive number, an
  `agent.contextBudgetTokens` that isn't a number, and a budget no greater
  than `agent.maxTokens`, where it named only the provider.
