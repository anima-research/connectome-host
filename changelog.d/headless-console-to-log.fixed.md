- **A headless host's `console.error` and `console.warn` lines reach
  `data/headless.log`**, where `/bug` reads a headless host's error tags and
  shapes from: the `[fit]`, `[mcpl]`, `[gate]`, `[inference-failed]` and
  `[update]` lines among them, which Bun's console writes past the stderr
  redirect, to the supervisor's stderr only. Before, that file held the
  runtime's own lines alone and a `/bug` report from a headless host said
  `tags: none` whatever the host had been through. The lines still print to
  the supervisor, and to a fleet child's `startup.log`, as they did.
