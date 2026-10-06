- Operator ledger: price `claude-opus-5`, which matched no prefix in the rate
  table and so showed no cost at all — every call on it, including subagents
  spawned at the Opus-tier default, priced as nothing.
- Operator ledger: charge Claude Fable 5.1 and Claude Mythos 5.1 cache reads
  at 0.025x base input ($0.25/MTok) instead of the 0.1x every other model uses. A long-lived agent
  that re-reads a large cached prefix on every call spends most of its bill on
  cache reads, so the flat multiplier overstated its total several-fold. Cache
  reads on all other models, and input, output, and cache writes on the 5.1
  pair, are unchanged.
- Operator ledger: price Claude Sonnet 5 at $2/$10 for every call. The table
  still switched it to $3/$15 on 2026-09-01, but that scheduled increase was
  withdrawn and the introductory rate became the standard one, so every
  Sonnet 5 call since September 1 was overstated by half.
- `ANTHROPIC_PRICING_VERSION` moves to `anthropic-public-2026-09-21`, so
  replayed JSONL is re-priced under a version string that says which table
  produced it.
