- The host takes agent-framework `^0.35.0` (was `^0.33.3`), context-manager
  `^0.28.0` (was `^0.25.3`), membrane `^0.10.4` (was `^0.8.1`) and chronicle
  `^0.7.0` (was `^0.6.0`), with both lockfiles at those releases and one
  copy of each. Each package's changelog lists its changes: agent-framework's
  for 0.34.0 and 0.35.0, context-manager's for 0.26.0 to 0.28.0 (what its
  0.25.2 and 0.25.3 added is in 0.28.0 too), membrane's for 0.9.0 to 0.10.4,
  and chronicle's for 0.7.0. chronicle 0.7.0 opens and reads a store 0.6.0
  wrote, and nothing in the stack stores a chunked blob, so a store this
  release writes still opens on the release before it.
- When a turn's context cannot fit while compression is pending, the
  framework can hold the turn until it can try the compile again. The Web
  UI's Health panel and `/status` say that the agent is waiting for
  compression, health observers receive the hold's start and end without
  the refusal text unless they also hold `ops`, and the TUI names the wait
  and how it ended. If the hold takes unsent injections out of the agent's
  window, the Web UI and TUI update their window marks. Before, the host
  installed the 0.33 line, where a refused compile went to the error
  policy without this wait.
- When a subagent's model call fails, its caller reads the framework's
  reason in the result or failure mail. Before, the caller could read the
  provider's error message there. The host still reads the original error
  for retry and rate-limit decisions, and a stated wait that the framework
  declines to sleep still ends the run without a restart or a throttle.
