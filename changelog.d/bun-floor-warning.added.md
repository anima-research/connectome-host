- The host warns at start when the Bun running it is below the floor its
  `package.json` declares (`engines.bun`), naming both versions, since below
  that floor it can fail in ways that don't name Bun. It warns and carries
  on, and the TUI shows the same line in its own view.
