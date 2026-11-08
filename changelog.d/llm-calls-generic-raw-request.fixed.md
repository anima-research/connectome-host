- The generic provider wrapper's llm-calls records (OpenAI, Codex, OpenRouter,
  the compatible lane, mock) keep the raw request on a failure, and on a
  success only with `LLM_CALLS_FULL_PAYLOADS=1`, as the Anthropic writer's do
  (#341). Before, every successful call kept it: on the OpenAI Responses path
  the request carries the whole compiled context, so a quiet Codex host wrote
  about 3 MB per call, and a few calls could push earlier records out of the
  tails the call ledger (16 MiB) and `/bug` (4 MiB) read.
