- A subagent's own requests now carry the recipe's prompt-caching settings
  as the resident's do: an explicit `agent.promptCaching` reaches every spawn
  and fork, a Bedrock subagent on a model the caching gate denies sends no
  `cache_control` on its turns, and `agent.cacheTtl` is forwarded where the
  provider takes it (#339). Before, spawn and fork built their agent config
  without either, so agent-framework's default (caching on) applied to
  subagents under a caching-off recipe. A subagent's compression calls still
  take the host's one membrane default, set from the resident's model.
