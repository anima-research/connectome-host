- **Readline mode (`--no-tui` with stdin on a terminal):** from its banner
  until the host has stopped, what the process writes through
  `process.stderr.write`, `console.error` and `console.warn` goes to
  `data/readline-error.log` rather than into the conversation, where a
  library's diagnostic could land in the middle of the agent's reply. The
  log is created readable by its owner alone, and each line is written to it
  as it comes, so a crash loses none of what came before it.
  `[routeSpeech]`, `[routing]` and `[inference-failed]` lines go there too,
  as does the `[diagnostics]` dump a `SIGUSR2` asks for, so an operator who
  watched or redirected readline mode's stderr for them reads the log
  instead. What the person at the terminal needs still prints there, on
  stderr as before, each on a line of its own, with the prompt drawn again
  below it, keeping what was typed, if it was waiting: a turn's failure and
  how it ended, a slash command's failure, an update notice, a
  self-restart's failure to close the Web UI's server, the log's path at
  start when it opened, and the host's own ops alerts, worded as the TUI
  words them, which readline mode didn't show before (a fleet child's alerts
  aren't printed there, as before). A crash still prints on the terminal. In
  readline mode, `/bug` now reads the log's current session, as it reads
  `tui-error.log` in the TUI. If the log can't be opened or written, the
  host says so, and from then on the lines it would have taken print on the
  terminal as before. Batch mode (stdin not a terminal) is unchanged, and a
  library's `console.log` lines still print in the conversation.
