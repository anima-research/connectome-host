- Per-agent token counts now count each provider call once. agent-framework's
  `inference:usage` sample is the stream's running total (membrane sums every
  call so far), and `inference:completed` carries the total again, but the
  agent tree added every sample and the completion. So a multi-call stream's
  earlier calls were counted again with each later sample and once more at
  completion. This affected the Web UI sidebar's `out` badges and the Usage
  panel's per-agent and breakdown rows. The session totals and the call ledger
  don't come from these samples, so they don't change.
- Context-size readouts show the latest call's prompt: its fresh input plus
  its cache reads and writes. They had shown the stream's summed fresh input,
  which is neither one call's prompt nor the context size. This covers the TUI's
  `ctx:N/budget` gauge and per-agent `…ctx`, the Web UI sidebar's `…cx`, a
  finished subagent's context size, and an agent's `input` in the Usage panel,
  which reads the same value.
