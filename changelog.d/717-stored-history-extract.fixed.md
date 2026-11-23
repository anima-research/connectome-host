- Anthropic recipes using the native formatter can opt in to `agent.filterStoredHistoryExtractThinking` to
  omit copied private thinking from paired `history--extract` results on send
  (#717), without rewriting saved history. Recovery from truncated pages is
  best-effort for the framework's known tool-result truncation notices,
  including spill success, spill failure, and no writable mount. Other
  truncation shapes may pass through unchanged.
  The host warns at startup if the flag is enabled with a non-native formatter.
