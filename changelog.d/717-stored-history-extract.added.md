- Anthropic recipes can opt in to `agent.filterStoredHistoryExtractThinking`
  to omit copied private thinking from paired raw `history--extract` results
  on native requests (#717), without rewriting saved history. This includes
  local `toolsets--act` calls and named nested extracts whose calls are off-page.
  The guard runs only for known non-binding models. For binding models and
  unknown model IDs, the flag does not change requests; the Agent Framework
  fix (#1041) covers new extracts instead. On known non-binding models,
  toggling the flag changes eligible earlier extracts and can rewrite the
  prompt-cache prefix.
  Truncation recovery is best-effort. The host warns that the flag has no
  effect with other providers and that `anthropic-xml` main turns are not
  covered; native background requests such as compression can still be
  filtered on non-binding models.
