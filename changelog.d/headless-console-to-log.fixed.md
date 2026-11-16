- **A headless host's `console.error` and `console.warn` lines reach
  `data/headless.log`**, where `/bug` reads a headless host's error tags and
  shapes from, from the moment the host boots: agent-framework's `Failed to
  connect MCPL server …`, `[mcpl] … tools/list failed`, `[gate]` and
  `[inference-failed]` lines, the host's own `[mcpl]` warnings, and
  `[update]`'s warnings and errors among them, which Bun's console writes past
  the stderr redirect, to the supervisor's stderr only. Lines said before the
  log is open are held (up to 1,000 console calls, with a count of any more)
  and written after the run's session marker, so `/bug` counts them as this
  run's; a host that fails before its headless runtime is up leaves its lines
  on stderr, as before. Before, that file held the runtime's own lines alone
  and a `/bug` report from a headless host said `tags: none` whatever the host
  had been through. The lines still print to the supervisor, and to a fleet
  child's `startup.log`, as they did; `console.log`, `info` and `debug` go
  there alone, as before. Since the file now takes every warning and error,
  it is rolled over to `headless.log.1` (one generation kept) past 64 MiB, at
  a start and live; an exit right after a live rollover still waits for the
  retired file's last lines, a deleted log is opened anew, and `/bug` reads
  `headless.log.1` back to its marker after a live rollover. Nothing rotated
  the file before.
