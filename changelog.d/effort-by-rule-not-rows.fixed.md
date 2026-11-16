- **A resident's `reasoning_effort` reaches Claude Haiku 5.5, and reaches a
  model released after this host without a change to it.** The host sent
  `output_config.effort` only to models on a list of its own (Opus 4.5+, the
  4.6 pair, Sonnet 5+, Fable, Mythos) and dropped it for the rest with a
  `[reasoning-effort] … does not accept effort` line; Haiku 5.5, which takes
  all five levels, wasn't on it, so a resident on Haiku 5.5 ran at the model's
  default whatever the recipe or `/reasoning` set. Now the host reads the
  generation off the id and refuses by the rule the generations follow
  (nothing before 4.5; not Haiku or Sonnet 4.5; Opus 4.5 at low/medium/high;
  the 4.6 pair without xhigh; everything from 4.7 on takes all five), and a
  model it doesn't know to refuse gets the effort. Where the model does refuse
  it, with a 400 before anything streamed, the host sends the request again
  without it, says so once, and drops the level for that model from then on,
  so a new model's first day needs no row here.
