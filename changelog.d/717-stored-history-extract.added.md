- Anthropic recipes can opt in to `agent.filterStoredHistoryExtractThinking`
  to omit copied private thinking from paired raw `history--extract` results
  on native requests (#717), without rewriting saved history. This includes
  local `toolsets--act` calls and named nested extracts whose calls are off-page.
  Known non-binding models are covered, as are drop-capable models (Opus,
  Sonnet, and Haiku 5.5 and Fable 5.1/5.2) on streams and on complete
  requests without native thinking, such as compression. The enabled guard
  warns once per model ID when skipped. Toggling the flag can rewrite the
  prompt-cache prefix and cause a one-time loss of signed thinking minted
  after an affected extract on a drop-capable model. Agent Framework #1041
  will cover new extracts once a release containing it is installed.
  Truncation recovery is best-effort. The host warns that the flag has no
  effect with other providers and that `anthropic-xml` main turns are not
  covered; eligible native background requests can still be filtered.
