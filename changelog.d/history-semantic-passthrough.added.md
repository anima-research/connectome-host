- `modules.history` accepts an object form, `{ semantic: { url, token?, namespace?,
  syncIntervalMs?, maxSyncPerTick?, maxSyncBeforeSearch?, includePrivateTools?,
  allowInsecureHttp? } }`, which adds `history--semantic_search`: meaning-based
  search over the agent's raw messages and compression summaries via a shared
  remote embed-service (agent-framework#173). **Requires
  `@animalabs/agent-framework` >= 0.20.0**; startup throws if the installed
  HistoryModule offers no `semantic_search`. `token` goes through the recipe's
  `${ENV}` substitution. The index namespace is always `<prefix>/<session id>`;
  `namespace` sets the prefix (default: the agent name). Validation is loud at
  load: unknown keys at either level, a URL without a host or with
  credentials/query/fragment, plaintext http outside loopback/tailnet without
  `allowInsecureHttp: true`, budgets below 1, and `syncIntervalMs` other than 0
  or >= 5000 all fail the recipe.
