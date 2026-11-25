- The Context tab no longer asks for an exact count on a host with no Anthropic
  credential and no gateway at `ANTHROPIC_BASE_URL`. Before, it sent the agent's
  next request to Anthropic's API with an empty key. When the agent's
  model is one that count_tokens can count, `/debug/context/makeup` now reports
  `countSource: "count_tokens_no_credential"` for such a host. A new
  `countHost` field names the host that a count was asked at. The Context
  tab shows it under an exact count, and beside the reason when a count fails.
