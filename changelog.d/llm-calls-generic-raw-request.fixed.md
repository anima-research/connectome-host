- The generic provider wrapper's llm-calls records (OpenAI, Codex, OpenRouter,
  the compatible lane, mock) keep the raw request as the Anthropic writer's
  do: on a failure (not on a cancelled call), on a refusal or an anomalous
  response (its row carries `anomaly`), and on every call only with
  `LLM_CALLS_FULL_PAYLOADS=1` (#341). Before, every call kept it: on the
  OpenAI Responses path the request carries the whole compiled context, so a
  quiet Codex host wrote about 3 MB per call, and some twenty calls could push
  earlier records out of the ~64 MiB the call ledger and `/bug` read from the
  file's end. The summary now carries the request's cache breakpoints and
  TTLs and its message count under the names the ledger reads, so a restored
  row says `uncached` rather than `unknown` without the raw request.
