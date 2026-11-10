- `agent.cacheKeepalive.persist` (default `false`): saves the cache keepalive's state to
  `<dataDir>/cache-keepalive.json`, so after a restart that keeps the model, system prompt and tools
  the keepalive goes on refreshing the prompt cache when it's due, instead of nothing touching it until the
  next turn. Anthropic and the 1-hour cache only. Needs a membrane with `cacheKeepalive.statePath`. The host
  warns at startup (in the TUI and headless log too) when the option can't work: a 5-minute cache, no
  keepalive for the provider, a membrane without it, or a keepalive that stopped saving; `/healthz` reports
  `cacheKeepalivePersist.saving`. With `persist` off the host deletes the file at startup.
