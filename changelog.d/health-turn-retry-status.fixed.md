- **The Health panel no longer reads `idle` for an agent whose turn is retrying.** Between a failed call and its
  retry, agent-framework's agent state reads `idle`, and the panel showed that word, in green, for as long as the
  retries took: a resident whose provider answered `overloaded_error` for eight minutes read `idle` throughout, while
  a newer message waited in the gate's buffer. With an agent-framework that reports `retrying` and `turnAlive` in
  `healthSnapshot()` (agent-framework#992), the panel reads `retrying`, with what the error policy retries the
  failure as, which try is next of how many, and when (`overloaded · try 7 of 13 · in 2m`); an idle state with a
  turn alive reads `idle+turn-alive`. The agent's state is the word's tooltip. Health clients get the retry's class
  name (`HEALTH_STRINGS`), never the failure's text. With an earlier agent-framework the row reads `status` as before.
