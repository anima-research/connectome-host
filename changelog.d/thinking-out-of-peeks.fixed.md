- `subagent--peek` and the result of a subagent stopped partway no longer
  carry the subagent's thinking. Both gave every token of the subagent's
  round, so where the provider returns thinking as readable text, as
  `display: 'summarized'` and the `'updates'` notes do, the parent model
  read it as a tool result or in the `[Subagent … returned]` message. They
  now carry the round's text alone, without its thinking or, in XML tool
  mode, the tool-call markup it streams. A Web UI peek of a subagent opened
  partway through a round opens on that text, as a TUI peek does while its
  log of that subagent is still empty, and the live tail still shows the
  thinking as it streams. A round that has only thought so far still counts
  as streaming, so it isn't reclaimed as a zombie or listed as idle.
- `fleet--peek` leaves out a child's thinking tokens (`inference:tokens`
  with `blockType: 'thinking'`), and its `lines` counts the events it
  gives. Only the tool changes: the child's buffer still holds them, and
  the TUI and Web UI still get every event. A child adopted from a release
  before 0.24.0 still sends `inference:speech` with its thinking in it,
  which `fleet--peek` gives as it came, until that child restarts.
