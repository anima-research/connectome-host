- Recipes can set **`agent.strategy.carrierPolicy: "live-strip"`** (context-manager
  #81, shipped since context-manager 0.8.0, but never reachable from a recipe
  until now). `'live-strip'` omits a summary's signed reasoning carriers
  (`responseContent` thinking blocks) from the agent's own live-compiled
  window only — compression/merge requests still carry them unconditionally,
  where they're measured load-bearing for some providers. Useful when a
  provider's classifier treats a compressor-signed reasoning block replayed
  inside the live window (rather than the request that minted it) as
  reasoning extraction. Default `'full'` is unchanged/behavior-preserving.
