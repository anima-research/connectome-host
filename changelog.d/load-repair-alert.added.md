- When loading an agent's store makes context-manager's load repair drop
  summaries that held text, the host tells the agent's keeper
  (context-manager#175). It sends a `memory-load-repair` ops alert, to
  `failures.log`, the ops trace and `CONNECTOME_OPS_WEBHOOK`, that says
  which spans of time changed and at what level, how much summary text left
  what the agent is shown, that the repair removed summaries and not
  messages, which show raw or under the summaries that remain until
  compression covers them again, that a repair can't be told apart from
  damage, how to read the old summaries back from a copy of the store, and
  words the keeper could pass on to the agent. `/healthz` and the Web UI's
  Health tab show each agent's latest such repair for the session; an
  observer without the `ops` scope gets it without its branch name. The
  store audit an update runs says each load repair it causes in the same
  words, since the start that opens the store next finds nothing left to
  repair, and a host on trial also sends each through the ops path, whether
  or not its commit then holds. This needs an agent-framework whose
  context-manager reports load repairs, installed as one copy; until then no
  alert is sent and `/healthz`'s `loadRepair` section stays empty. A
  conversation fork's load sends no alert, as it sends no
  compression-quarantine alarm, though the Health tab shows a fork's repair
  too.
