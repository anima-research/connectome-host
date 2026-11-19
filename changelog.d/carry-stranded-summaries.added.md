- **`agent.strategy.carryStrandedSummaries`** (off by default) passes
  context-manager's option of the same name: a summary no merge can take,
  alone between summaries of other levels or too wide for its level, is
  carried up a level unchanged and with no model call until it stands beside
  summaries of its level, where the ordinary merge takes it. A carried entry
  is never rendered, so a compile does not change at a carry. The recipe
  refuses a value that isn't a boolean. It takes context-manager 0.28.0, which
  this release's dependency range starts at.
