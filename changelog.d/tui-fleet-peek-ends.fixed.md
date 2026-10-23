- A fleet child's peek in the TUI shows a turn that a tool ended, that was
  stopped or that failed as a subagent's peek does, where it showed a dim
  `· <event>` line. A turn agent-framework ended as a failure reads
  `✗ turn ended: <error>`, with its error, where it read
  `· inference:exhausted`; a stopped turn reads `✗ turn aborted: <reason>`,
  and one a tool ended reads `── turn ended by a tool ──`. A completed turn
  keeps its `─ inference completed ─` line.
