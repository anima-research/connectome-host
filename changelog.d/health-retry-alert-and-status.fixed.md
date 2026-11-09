- **While an agent's turn waits to retry, the Web UI's alert for three or more consecutive inference failures says
  its current turn is retrying, not that the agent is down,** and keeps the count. `/status` words each agent as
  its Health row does (`retrying · overloaded · try 7 of 13 · in 2m`), where it printed `idle` through the wait.
  Both need an agent-framework that reports `retrying` (agent-framework#992); with an earlier one, nothing changes.
