- `agent.strategy.compressionProvider` sends a resident's memory writes
  (compression, merges, transition summaries) to another provider or credential
  than its turns: `anthropic`, `openai-responses`, `openai-compatible` or
  `openrouter`, with the credential read from the environment variable
  `apiKeyEnv` names (default: the provider's usual one) and an optional
  `baseUrl` for a gateway. A resident can keep its turns on a subscription token
  while compression goes through an API key (#615). The recipe refuses a
  credential written into it, and, on another provider than `agent.provider`,
  a missing `compressionModel`. The host refuses to start when the installed
  agent-framework or context-manager can't route the calls, rather than
  compress on the agent's own provider.
