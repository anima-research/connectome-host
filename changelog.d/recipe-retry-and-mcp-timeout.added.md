- Recipes can set **`agent.retry`** (Membrane's retry policy, passed through
  verbatim) and **`mcpServers.<id>.requestTimeoutMs`** (the framework's
  per-server JSON-RPC timeout). Both knobs existed underneath — Membrane's
  `MembraneConfig.retry` and `McplServerConfig.requestTimeoutMs` — but the host
  never surfaced them, so a gateway 502 killed a turn on first failure
  (Membrane retries generic retryable errors zero times by default; only
  `529`/`overloaded_error` has a dedicated schedule) and a tool slower than the
  60s default (image generation) could only ever time out. Both validate at
  recipe-load time.
