- **`agent.mock` gains typed timing knobs**: `completeDelayMs`,
  `streamChunkDelayMs` and `streamChunkSize` pass through to membrane's
  MockAdapter, validated (non-negative finite numbers; chunk size a
  positive integer). Previously these keys were silently ignored;
  validation keeps a quoted value from working by coercion now that
  they pass through. The host
  drives the streaming path, so `streamChunkDelayMs` × chunk count is
  what holds a mock turn open for a predictable time; tests that need
  content to land mid-turn (e.g. RFC-006's unread coalescing branches,
  which only fire for deferred-while-busy messages) were previously
  impossible against an instant mock.
