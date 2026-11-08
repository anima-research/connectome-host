- A subagent's config now carries the recipe's prompt-caching settings as the
  resident's does: an explicit `agent.promptCaching` reaches every spawn and
  fork, a Bedrock subagent on a model the caching gate denies sends no
  `cache_control`, and `agent.cacheTtl` is forwarded where the provider takes
  it (#339). Before, spawn and fork built their agent config without either,
  so agent-framework's default (caching on) applied to subagents under a
  caching-off recipe, and a Bedrock child on such a model was refused.
