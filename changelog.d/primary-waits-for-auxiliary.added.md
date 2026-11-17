- **`agent.primaryWaitsForAuxiliary`** (default false) passes agent-framework's
  setting of the same name: true holds a turn's start until the agent's
  compression call already in flight ends. An agent-framework with the
  setting no longer waits unless it is on, so a recipe for a Claude 3 Opus
  resident, whose provider limits how fast input tokens per minute may grow,
  sets it to true to keep the wait. An agent-framework that predates the
  setting always waits.
