- With reasoning enabled, requests to models that do not support adaptive
  thinking (Haiku 4.5, Sonnet 4.5, Opus 4.5 and older) no longer carry
  `thinking: { type: 'adaptive' }` and 400. The setting is host-wide, so
  RetrievalModule's default Haiku calls were failing on every compile.
  Those models are logged once and sent without `thinking`.
