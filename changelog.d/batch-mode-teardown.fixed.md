- Batch mode (stdin not a TTY, no `--headless`) now says what it is doing: a
  `[batch]` line at the start says the run ends when stdin closes and names
  `--headless` as the way to keep serving, and a line before the teardown
  names the MCPL servers it closes. Each server's `mcpl-stderr` log gets a
  `[host] closing: batch run complete` line ahead of its `connection closed`.
  When the web UI is on, a last line says it stays up with the agent stopped.
- Batch runs exit as soon as they finish. The 120 s cap on waiting for each
  reply was never cleared, so the process lingered for two minutes after
  `Done.`.
