- `OPENROUTER_BASE_URL` routes an `openrouter` recipe's calls through a
  gateway, as `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` and `BEDROCK_BASE_URL`
  do for their providers. Unset, calls go to `https://openrouter.ai/api/v1` as
  before. The hint after a network failure or timeout names it, and the recipe
  refusal of `agent.baseUrl` beside another provider lists it, along with
  `CODEX_BASE_URL`, which that refusal had left out.
