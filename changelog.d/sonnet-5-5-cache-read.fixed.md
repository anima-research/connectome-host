- Claude Sonnet 5.5 cache reads are priced at 0.05x ($0.10 per million tokens), in the call
  ledger and in the standard kv-unified block's `cacheReadPrice`. It had matched the
  Claude Sonnet 5 entry and read at 0.1x. The kv-unified solver weighs a change of layout by
  the cache write price less the read price, so for a Sonnet 5.5 agent on the standard block
  a layout that rewrites more of its prompt cache now scores slightly worse. The solver keeps
  the layout it has unless another scores better by more than its adoption margin, so an
  agent changes layout at its first compile after the upgrade only from a near tie, and then
  writes its prompt cache once. A `kvUnified` block written out in the recipe keeps its own
  prices. The pricing version is now `anthropic-public-2026-10-20`.
