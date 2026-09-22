- Recipe `agent.strategy.kvUnified` now accepts `hysteresisCertificate`
  (optional boolean, passed through to Context Manager's certified hysteresis
  exit) and requires `preserveGapBearingSummaries` as an explicit boolean —
  Context Manager already required it, but the host type did not know the
  key and let it through unvalidated. `treeifyNonContiguousSummaries` and
  `preserveGapBearingSummaries` may not both be true.
