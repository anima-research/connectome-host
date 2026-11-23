- Anthropic recipes using the native formatter can opt in to `agent.filterStoredHistoryExtractThinking` to
  omit copied private thinking from paired `history--extract` results on send
  (#717), without rewriting saved history. The guard also withholds malformed
  extracts with recognizable copied thinking, including in truncated nested
  results. Other formatters warn at startup if the flag is enabled.
