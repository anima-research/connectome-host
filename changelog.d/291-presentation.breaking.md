- **Operators: `/undo` and `/redo` act on the agent's window, and `/checkout`,
  `/restore` and `/branchto` go through agent-framework** (agent-framework
  #291, whose release this one needs: see the 291-dependency-ranges entry).
  Every agent's context now follows a
  window of its own over the one store, the rows it was shown in the order its
  requests carried them, so a command that moved the store's branch through
  one agent's context manager would leave the other agents' windows behind.
  - `/undo` is agent-framework's `undoLastTurn`: the agent's last turn leaves
    its window, and its next request is built without it. The record keeps the
    turn and no branch moves, so the workspace and `_config` mounts, MCPL
    checkpoints and the inference log are no longer reverted, and another
    resident's newer row is left alone, where `/undo` used to branch the store
    before the record's newest reply, whoever's it was. `/redo` puts the turn
    back. Both are refused while the agent's turn is alive, and for an agent
    whose window couldn't be written down when it started.
  - The `_config` mount's files are written back after a branch switch or a
    rollback, and not after an undo or a redo, which act on the window only
    and never touch them. 0.15.0's `configMount` note said a file there other
    than the gate's is no longer versioned "or written back after an undo, a
    redo or a branch switch", and that "an undo or a branch switch takes back
    `gate.js`": from this release each reads "a branch switch or a rollback".
  - `/checkout` is agent-framework's `switchBranch`, and `/restore` and
    `/branchto` its `rollbackToMessage`: a new branch whose last row is the
    checkpoint's or the given message, and the store moved to it. Each is
    refused unless every agent sharing the store is idle, where before only
    the command's agent was checked, and each takes every agent's context to
    the new branch. The operator log records `/restore` and `/branchto` as
    `rollback`, `/checkout` and a `/restore` to a branch's head as
    `checkout`, and `/undo` and `/redo` as `undo-turn` and `redo-turn`, each
    with the requester `host-console`. `/branchto` at the branch's last
    message is refused, as there is nothing after it to roll back.
  - A rollback cuts at the write that showed the agent its message, so rows
    after the message can stay, and `/branchto`, `/restore` and the Web UI's
    rollback say so where they used to say everything after it was dropped:
    rows one write showed together with the message stay in the window after
    it, for a suppression or a hide to take out, and rows stored before the
    message was shown and shown after it stay in the record, out of the
    window until the agent's next turn starts. The Web UI's `surgery-result`
    frame carries them as `keptInWindowAfterTarget` and `returnedToArrivals`,
    and the Surgery panel's log summarizes a rollback's and a checkout's.
  - The TUI's and the Web UI's transcripts still show the record, so an undo
    changes what the agent is sent next, not the transcript; both mark the
    rows an undo took out (dimmed, and `(undone)` in the TUI), and the Web
    UI's context panels (makeup and coverage, the compiled context, the
    pins) read the window again at each undo or redo. The pin picker leaves
    undone rows out.
- **Web UI observers:** the trace frames of agent-framework's presentation
  index, `presentation:presented`, `presentation:unreadable-audience`,
  `presentation:failed`, `presentation:hand-off-mismatch`,
  `presentation:retracted` and `tune-out:subconscious-window`, need the `ops`
  scope, and `presentation:repaired` needs `health` and `ops`. They carry
  agent names, counts, ids and slots, never content. `window:undone`, an undo
  or a redo on a window, needs `messages`, and so does the new
  `undone-marks` frame, which names the transcript's rows an undo took out
  of the conversation agent's window, as a welcome's and a history page's
  entries mark them (`undone: true`). `undo:completed` and `redo:completed`
  are gone, with agent-framework's branch-moving undo.
- **Going back to an earlier release** after this one: a row this release
  stored for an agent while its turn was alive is where the record put it, and
  an earlier release compiles the record in that order, so the agent's next
  request misses the prompt cache and, on a model that binds a reply's
  thinking to what came before it, leaves the thinking after that row out.
  Nothing is lost. A queue of held writes that an earlier release left is
  stored once at this release's first start, and an earlier release then
  finds it empty. With a chronicle that has the batched identity append, the
  first window written down with rows moves the store's MANIFEST to version 2,
  which earlier chronicle builds refuse (context-manager's notes): going back
  after that needs the copy the update took. `/update back restore` puts it
  back. `/update back keep` stops at the older release's store audit, and the
  next start puts this release back.

  **Migration:** to revert the record, as `/undo` did, use
  `/branchto <msgId>` with the id of the last row to keep (`/history` and
  `/find` show ids), or the Web UI's rollback. A client that refreshed its view
  on `undo:completed` or `redo:completed` listens for `window:undone`.
  **Unchanged:** `/checkpoint`, `/branches`, `/history` and `/find`; every
  command that moves the head is still refused while the agent's turn is in
  flight.
