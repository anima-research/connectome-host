- `agent.retry` now reaches framework-wide turn retries as well as other
  provider calls (#470). Partial overrides preserve the framework's turn
  defaults: 13 overloaded sends unless `overloaded.maxRetries` is specified,
  stated-wait ceilings of at least 10 minutes, and one fresh call after a
  stream deadline cut. The ceilings apply to subagent runs; residents and
  conversation forks hold the provider's full stated wait before the policy
  runs. Omitted or empty retry settings and non-turn retry behavior are unchanged.
