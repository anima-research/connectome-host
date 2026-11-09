- **While an agent has a turn under way, the Web UI's alert for three or more consecutive inference failures says a
  turn is under way, not that the agent is down,** and keeps the count. `/status` words each agent as its Health row
  does (`retrying · overloaded · try 7 of 13 · in 2m`), where it printed `idle` through the wait. Both need an
  agent-framework that reports `turnAlive` and `retrying` (agent-framework#992); with an earlier one, nothing changes.
