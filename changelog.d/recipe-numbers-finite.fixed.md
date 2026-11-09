- A recipe number that must be positive or non-negative must also be finite:
  `agent.maxStreamTokens`, `agent.thinking.budgetTokens`,
  `agent.responses.compactThreshold`, `agent.cacheKeepalive.maxIdleHours`
  and `modules.fleet`'s four timeouts. JSON `1e309` parses to `Infinity`,
  which passed the sign check; `saveRecipe()` then wrote it back as `null`,
  and the next start, resuming from the saved recipe, refused a field it had
  accepted the day before. The first load refuses it now, naming the field
  and the value. `modules.fleet`'s `readyTimeoutMs`, `gracefulShutdownMs`
  and `sigtermEscalationMs`, which reach `setTimeout`, must also be a whole
  number of milliseconds no longer than the longest delay a timer keeps
  (2147483647 ms), since Bun and Node run a longer one at once. A saved
  recipe holding a longer one, or a fraction, now stops the start that
  resumes it: set the field to a whole number up to 2147483647 in the recipe
  file and start with that file, which replaces the saved recipe.
- `/budget` refuses a token count that overflows to `Infinity`, such as
  `1e309k`, where it set every agent's stream budget to `Infinity`.
