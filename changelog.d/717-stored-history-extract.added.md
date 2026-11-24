- Anthropic recipes can opt in to `agent.filterStoredHistoryExtractThinking`
  to omit copied private thinking from paired raw `history--extract` results
  on native requests (#717), without rewriting saved history. This includes
  local `toolsets--act` calls and named nested extracts whose calls are off-page.
  Truncation recovery is best-effort. The host warns that the flag has no
  effect with other providers and that `anthropic-xml` main turns are not
  covered; native background requests such as compression still are.
