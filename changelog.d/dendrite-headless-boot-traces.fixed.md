- Headless runs feed the agent tree and the socket from the boot on. The
  traces `create()` replays (registry restore, work a stop cut off, resumed
  tune-out epochs) are held across `framework.start()` for the headless sink
  instead of being dropped by it, and the first client to connect hears the
  events from before it connected, oldest first and each marked
  `replay: true`; when the boot outran the 1,000 kept, the replay ends with
  `lifecycle` `replay-truncated` saying how many were cut. Agents the
  framework derives (`dendrite:agent-created`) hang under the agent they were
  made from in the tree, as framework nodes with their own trace stream,
  without a tool call to infer the edge from; an orphaned agent is parentless
  until `dendrite:agent-reparented` moves it.
