- **A headless host's `console.error` and `console.warn` lines reach
  `data/headless.log`**, where `/bug` reads a headless host's error tags and
  shapes from, from the moment the host boots: agent-framework's `Failed to
  connect MCPL server …` and `[mcpl] … tools/list failed`, the host's own
  `[mcpl]`, `[gate]` and `[inference-failed]` lines, and `[update]`'s
  warnings and errors among them, which Bun's console writes past the stderr
  redirect, to the supervisor's stderr only. Lines said before the log is
  open are held (up to 1,000, with a count of any more) and written after
  the run's session marker, so `/bug` counts them as this run's. Before, that
  file held the runtime's own lines alone and a `/bug` report from a headless
  host said `tags: none` whatever the host had been through. The lines still
  print to the supervisor, and to a fleet child's `startup.log`, as they did;
  `console.log`, `info` and `debug` go there alone, as before. Since the file
  now takes every warning and error, it is rolled over to `headless.log.1`
  (one generation kept) past 64 MiB, at a start and live; nothing rotated it
  before.
