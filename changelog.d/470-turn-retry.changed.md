- **Behavior change for recipes setting `agent.retry`:** non-empty retry
  settings now move framework-wide turn retries onto the recipe-derived policy
  as well as governing other provider calls (#470). Unless explicitly
  overridden, 529 sends drop from the framework default's 13 to Membrane's 7,
  and stated-wait ceilings drop from at least 10 minutes to
  `max(60 s, maxRetryDelayMs)` for each schedule. Even a partial override
  replaces these omitted turn defaults rather than inheriting them.
  To raise an explicit policy's send limit and stated-wait ceilings, set
  `overloaded.maxRetries: 13`, `maxRetryDelayMs: 600000` and
  `overloaded.maxRetryDelayMs: 600000`. This is not an exact restoration of the
  default turn policy: it raises backoff delay caps too, and the same fields
  also reach compression, retrieval, session naming and other non-turn calls,
  enabling their long overloaded schedule. These settings do not configure
  the framework's separate provider-hold/admission rules. Omit `agent.retry`
  or use `{}` to keep the framework default turn policy without enabling that
  non-turn schedule.
  Stream deadline cuts retain the framework's one fresh call after 1 s,
  independently of the recipe's ordinary retry count.
