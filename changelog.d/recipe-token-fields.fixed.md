- `agent.maxTokens` and `agent.contextBudgetTokens` must be finite numbers,
  refused at load naming the field and the value, as 0.25.0 refuses the other
  token numbers: JSON `1e309` parses to `Infinity`, which the saved recipe
  wrote back as `null`, so the next start ran on the default where the
  operator wrote a number. What the start's fit check says about a `0`, a
  fraction or a string in either field is unchanged, and it now says it on a
  provider the host knows no window for too, where the `[fit] Not checked`
  line named only the provider.
