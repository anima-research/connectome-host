- **`agent.strategy.compressionFallbackModel`** (unset by default) passes
  context-manager's option of the same name: once `compressionModel` has
  refused a compression or a merge on every rung that keeps it writing the
  memory in full, the canonical request goes once more to the named model,
  before the split rung and before quarantine. The recipe refuses a value
  that isn't a non-empty string. It takes a context-manager later than
  0.27.0; with an earlier one, which is all this host's dependency range
  admits until it is raised, the key loads and does nothing.
