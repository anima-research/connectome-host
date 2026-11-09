- `subagent--peek` and the result of a subagent stopped partway no longer
  carry the subagent's thinking. Both gave every token of the subagent's
  round, so where the provider returns thinking as readable text, as
  `display: 'summarized'` and the `'updates'` notes do, the parent model
  read it as a tool result or in the `[Subagent … returned]` message. They
  now carry the round's text alone, without its thinking or, in XML tool
  mode, the tool-call markup it streams. An operator's TUI or Web UI peek of
  a subagent opens on that text too, and the live tail beside it still shows
  the thinking as it streams. A round that has only thought so far still
  counts as streaming, so it isn't reclaimed as a zombie or listed as idle.
