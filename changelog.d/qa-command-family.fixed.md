- Name-taking commands (`/checkpoint`, `/restore`, `/checkout`,
  `/session switch`, `/session delete`) parse the rest of the line instead of
  only the first token, so multi-word names round-trip with
  `/session rename` instead of silently truncating (`/checkpoint my test
  point` used to save a checkpoint named `my`).
- `/session delete` requires `--confirm`: the bare command echoes exactly
  which session matched (name, id, message count) before anything
  irreversible happens. `/help` documents that switch/delete accept ids.
- Head-moving commands (`/undo`, `/redo`, `/checkout`, `/restore`,
  `/branchto`, `/newtopic`) are refused while a turn is in flight — moving
  the head mid-stream committed the streaming reply onto the wrong branch,
  detached from its request (orphaned Chronicle nodes), including when the
  move came from a second client on the same session.
- `/mcp add` on an existing server preserves its env vars and `toolPrefix`
  (and reports the kept env keys); previously a command update silently
  wiped the server's env, which only surfaced when the server next started
  without its tokens.
- Checkpoints are visible: `/branches` lists them alongside branches, and
  bare `/checkpoint` lists existing checkpoints (matching bare `/restore`).
- `/budget` displays small values exactly instead of flooring to `0k`
  (`/budget 50` used to report "set to 0k" while rejecting `/budget 0`).
- `/clear` clears the WebUI transcript view (client-side, like the TUI's
  scrollback wipe) instead of appending a "(cleared)" line while clearing
  nothing; `/help` and the headless reply now say what `/clear` actually
  does — display only, history and context kept.
