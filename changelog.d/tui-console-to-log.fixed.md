- **In TUI mode, `console.error` and `console.warn` lines reach
  `data/tui-error.log`** (#670), as readline mode's reach
  `readline-error.log`: the host's recipe and MCPL warnings, agent-framework's
  `[gate]`, `[framework]` and `[inference-failed]` lines among them, which
  `/bug` reads from that file. Before, none did: Bun's console writes to the
  terminal's descriptor itself, past the `process.stderr.write` the TUI
  redirects, and OpenTUI's renderer then keeps console lines in an in-memory
  overlay shown only under `SHOW_CONSOLE`. The overlay still gets its copy.
