- Piped mode (`--no-tui`, or a batch run whose stdin isn't a TTY) now ends
  the agent's line on stdout before an `Error:` line, where what came next,
  such as a batch's echo of its next line or `Done.`, used to follow on the
  same line. The `Error:` line no longer begins with a line break, nor does
  `(turn ended: …)` on stderr, so in a terminal showing both the line breaks
  fall as before. Where stdout's line had already ended, as after a tool's
  line, stdout now gets an empty line there, and a retried attempt's answer
  can start after a blank line.
