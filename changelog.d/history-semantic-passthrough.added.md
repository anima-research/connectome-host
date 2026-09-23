- `modules.history` accepts an object form, `{ semantic: { url, token, namespace?,
  syncIntervalMs?, maxSyncPerTick?, maxSyncBeforeSearch?, includePrivateTools? } }`,
  which adds `history--semantic_search`: meaning-based search over the agent's raw
  messages and compression summaries via a shared remote embed-service
  (agent-framework#173). `token` goes through the recipe's `${ENV}` substitution;
  `namespace` defaults to `<agent name>/<session id>`, unique per store across the
  fleet. Validation is loud at load time (bad URL, non-numeric cadences, wrong types).
