- Add admin-only `/release-wait [script_id]` alongside `/undo`. Local operator
  CLI/TUI and full-authority web clients can end active Python observations while
  execution continues and completion wakes stay armed. Read-only observers and
  generic headless/fleet commands have no authority to invoke it. Requires the
  companion agent-framework execution-observation primitive; older versions
  report an explicit unsupported error without cancelling or resetting the agent.
