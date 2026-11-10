- **A recipe can set what a change of layout costs kv-unified**
  (context-manager 0.25.3): `agent.strategy.kvUnified.policy.rewriteLambda`
  prices the tokens a change rewrites, linearly, in place of the quadratic
  `cacheLambda` term; `agent.strategy.kvUnified.thinkingLambda`, with
  `thinkingHalfLifeTokens` (50,000 unless set), prices the thinking a change
  would make a model that binds thinking drop, so a layout holds while
  recent thinking is live and moves once it is gone anyway. All three are
  optional and off unless set. Each must be a finite number of 0 or more
  (above 0 for the half-life), and a recipe with another value is refused at
  load. Until now the host reported `rewriteLambda` as a key it does not
  read and passed it on unchecked.
