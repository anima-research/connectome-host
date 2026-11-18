- **A resident's `reasoning_effort` reaches Claude Haiku 5.5, and reaches a
  model released after this host, a new family name included, without a
  change to it.** The host sent `output_config.effort` only to models on a
  list of its own (Opus 4.5+, the 4.6 pair, Sonnet 5+, Fable, Mythos) and
  dropped it for the rest with a `[reasoning-effort] … does not accept
  effort` line; Haiku 5.5, which takes all five levels, wasn't on it, so a
  resident on Haiku 5.5 ran at the model's default whatever the recipe or
  `/reasoning` set, and the next family name (Fable and Mythos each arrived
  as one) would have too. Now the models known to refuse are the closed set
  that has shipped (nothing before 4.5; not Haiku or Sonnet 4.5; Opus 4.5 at
  low/medium/high; the 4.6 pair without xhigh), read off the id in any of its
  spellings, and every other Claude id gets the effort. Where the model does
  refuse it, with a 400 whose own message names the effort before anything
  streamed, the host sends the request again without it (a caller's own
  effort included), says so once, and drops the level for that model for the
  life of the process, so a new model's first day needs no row here. An id
  that isn't a Claude model's (a third-party model behind
  `ANTHROPIC_BASE_URL`) still gets no effort, as before: its 400 might never
  name the effort.
