- **Scripts driving piped mode:** in piped mode (`--no-tui`, or a batch run
  whose stdin isn't a TTY), `(turn ended: <error>)`, the line for a primary
  agent's turn that agent-framework ended as a failure, now prints on
  stderr, beside the `Error:` lines. It printed on stdout before, among the
  agent's answer. A script that looked for it on stdout reads stderr for it
  now, or it takes a failed turn's partial answer as the turn's. Another
  agent's turn that agent-framework ended this way now prints an `Error:`
  line on stderr, as that agent's failed attempts already did, where it
  printed nothing before; an `Error:` line doesn't name its agent.
  Unchanged: `(turn ended: …)` is the primary agent's alone, the agent's
  prose and a stop's `(turn aborted: <reason>)` stay on stdout, `Error:`
  lines stay on stderr, and a script reading stdout and stderr together
  (`2>&1`) sees the primary agent's lines where it did before.
