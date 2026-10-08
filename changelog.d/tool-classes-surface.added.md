- Operators can see each tool's effective MCPL class (RFC-008) and where it
  came from: the recipe's `toolClassOverrides`, the host's own table, the
  server's `_meta["mcpl/class"]`, or nowhere (unclassed). The new
  `/tools [agent]` command lists them in the TUI, readline, web UI and
  headless; `GET /debug/tool-classes[?agent=]` (also a `tool-classes` panel
  op, so `?scope=<child>` works) serves them as JSON; the web UI's MCP tab
  shows per-source counts and the per-tool list; and the agent's `mcpl_list`
  groups each server's tools by class and source.
