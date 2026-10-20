- `llm-calls` rows now flag anomalous provider responses. A response that
  carries a client `tool_use` block under any stop reason other than
  `tool_use` (seen in production as `end_turn` with a complete tool call,
  which the agent loop then drops without running the tool) gets an
  `anomaly` field (`kind`, `stopReason`, `providerStopReason`, `toolNames`),
  keeps its full raw request even without `LLM_CALLS_FULL_PAYLOADS` while its
  line fits the 16 MiB cap, as a refusal's row already did, and prints one
  timestamped `[llm-calls] … ANOMALY …` line to stderr, which ends with what
  became of the row: "full request kept in this call's llm-calls row" for a
  row written whole, the row's own `truncated` text for one whose line had
  to drop parts (to stay within the 16 MiB cap, or because it couldn't be
  serialized), or that the row could not be written. A raw response that
  lists `anomalies` of its own is flagged the same way
  (`kind: "provider_reported"`).
- Response rows also keep the provider's `messageId` and `requestId` at top
  level when the response exposes them (the request id is what a provider
  needs to look a call up). Rows are otherwise unchanged.
