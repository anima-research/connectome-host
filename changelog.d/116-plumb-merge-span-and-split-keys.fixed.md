- Recipes' `agent.strategy.mergeMaxSourceSpanMessages` now reaches the Context
  Manager (it was accepted but never passed through, so the CM default applied
  regardless of the recipe). Also plumbs and validates the Context Manager's
  `compressionSplitFallback`, `compressionSplitPlaceholder`,
  `compressionSplitMaxCallsPerChunk` and `compressionSplitMaxCallsPer10Min`
  keys (all default off / CM defaults).
