- **A model's window and maximum output are read from Anthropic's Models API
  at start**, once per model the recipe names (the resident's, the subagents'
  default, retrieval's), and kept in `data/model-facts.json` for the next
  start's load, so the `[fit]` check and the agent's `physicalWindowTokens`
  know a model released after this host from its second start, where before
  they knew only the models in the host's own table (`model-limits.ts`, with
  the dates someone read the docs in its comment), and a new model ran with no
  known window until a row landed (#693). The table stands where the API can't
  be read: no key, a gateway that doesn't serve it, a model it doesn't know, or
  no network, each said once. The read also keeps what the API says of the
  model's effort levels, thinking types and lifecycle; a model past `active`
  is said at start with its retirement date. `MODEL_FACTS=off` turns the read
  off; behind a gateway (`ANTHROPIC_BASE_URL`), which may not serve the
  endpoint, it runs only with `MODEL_FACTS=on`.
