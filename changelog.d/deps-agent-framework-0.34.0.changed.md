- The host takes agent-framework `^0.34.0`, with both lockfiles at 0.34.0.
  When a turn's context cannot fit while compression is pending, the
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
