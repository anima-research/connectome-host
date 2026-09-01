- **`agent.provider: 'openai-compatible'`** — run an agent against any
  OpenAI chat-completions endpoint (Ollama, vLLM, Together, Groq, NanoGPT,
  ...) via membrane's existing `OpenAICompatibleAdapter`, which no host ever
  wired. The recipe names the endpoint (`agent.baseUrl`, validated as an
  absolute http(s) URL at load) and the model (required — no default for an
  arbitrary endpoint); the key comes from `OPENAI_COMPATIBLE_API_KEY`
  only (no `OPENAI_API_KEY` fallback — `baseUrl` is recipe-controlled, so a
  fallback would silently send a real OpenAI credential to an arbitrary
  endpoint) and may be absent for local servers.
  `agent.baseUrl` with any other provider is rejected at load time.
