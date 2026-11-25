- The Context tab no longer asks for an exact count on a host with no Anthropic
  credential and no gateway at `ANTHROPIC_BASE_URL`. Before, it sent the agent's
  next request to Anthropic's API with an empty key. `/debug/context/makeup` now
  gives `countSource: "count_tokens_no_credential"` on such a host. A new
  `countHost` field names the host that a count was asked at. The Context
  tab shows the same host under the count.
