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
    checkpoints and the inference log are no longer reverted, history search
    (`modules.history`, its semantic search too) still finds the turn,
    marked `window: "undone"`, where it left out a turn the undo had moved
    off the current branch, and another
    resident's newer row is left alone, where `/undo` used to branch the store
    before the record's newest reply, whoever's it was. `/redo` puts the turn
    back. Both are refused while the agent's own turn is alive, and for an
    agent whose window couldn't be written down when it started. Another
    agent's turn no longer refuses them: the 0.16.0 entry for #264 had them
    refused, as a branch move is, while any agent sharing the store was
    mid-turn.
  - The `_config` mount's files are written back after a branch switch or a
    rollback, and not after an undo or a redo, which act on the window only
    and never touch them. 0.15.0's `configMount` note said a file there other
    than the gate's is no longer versioned "or written back after an undo, a
    redo or a branch switch", and that "an undo or a branch switch takes back
    `gate.js`": from this release each reads "a branch switch or a rollback".
  - `/checkout` is agent-framework's `switchBranch`, and `/restore` and
    `/branchto` its `rollbackToMessage`: a new branch cut at the write that
    showed the agent the checkpoint's or the given message (see below), and
    the store moved to it. A `/restore` whose checkpoint has no message (one
    taken on an empty branch), or whose message isn't on the current
    branch, is a `switchBranch` to the checkpoint's branch head instead, and
    one at its checkpoint already moves nothing. Each is refused unless every agent
    sharing the store is idle, as before, and each takes every agent's
    context to the branch it moves to. While the command agent's own turn
    is alive the host refuses it at once, as before (`/checkout refused: a
    turn is in flight (…)`). While another agent's turn is, the host
    refused it at once too; now the command answers with its progress line
    (`Switching → branch …`, `Restoring to checkpoint …`, `Branching at
    …`), then with agent-framework's refusal after `Checkout failed:`,
    `Restore failed:` or `branchto failed:` (`Cannot … while … — every
    agent sharing the store must be idle (quiesce the host first)`) and
    `This command moved nothing. Try again once what it names has
    finished.` The operator log
    records `/restore` and `/branchto` as `rollback`, `/checkout` and a
    `/restore` to a branch's head as `checkout`, and `/undo` and `/redo` as
    `undo-turn` and `redo-turn`, each with the requester `host-console`.
    `/branchto` at the branch's last message is refused, as there is nothing
    after it to roll back.
  - A rollback cuts at the write that showed the agent its message, so rows
    after the message can stay, and `/branchto`, `/restore` and the Web UI's
    rollback say so where they used to say everything after it was dropped:
    rows one write showed together with the message stay in the window after
    it, for a suppression or a hide to take out, and rows stored before the
    message was shown and shown after it stay in the record, out of the
    window until the agent's next turn starts, or the host restarts before
    then. The Web UI's `surgery-result`
    frame carries them as `keptInWindowAfterTarget` and `returnedToArrivals`,
    and the Surgery panel's log summarizes a rollback's and a checkout's.
    `/branchto` says everything after the message was dropped only when the
    cut took every row stored after it, and otherwise how many it took: a
    co-resident's row stored before the message was shown stays too.
  - The TUI's and the Web UI's transcripts still show the record, so an undo
    changes what the agent is sent next, not the transcript; both mark the
    rows an undo or a shed took out (dimmed, and `(undone)` in the TUI,
    which marks its lines in place, a reply it streamed and a message sent
    from it included, never taking another resident's row for one of them,
    and draws below them an undone row stored since it loaded the history
    that it has no line for, until a redo puts it back, but not one whose
    lines `/clear` or the scrollback cap took down), and the Web
    UI's context panels (makeup and coverage, the compiled context, the
    pins) read the window again, once, at each undo, redo or shed. A figure
    that comes back after a newer read of it started is dropped, and the
    coverage panel's five-second poll starts no read while one is pending,
    where a read slower than the poll had another started at each tick; a
    coverage read that has gone 30 seconds unanswered fails, and the next
    tick starts one. The local pin picker lists the host's candidates, the
    record's last 200 rows, as a fleet child's does, where it listed the
    rows the transcript had loaded; it leaves out undone rows and rows
    stamped for other residents only. A message stored in parts is one
    candidate, by its first part with the parts' text joined, as it is one
    row in the transcript, where a fleet child's picker listed each part,
    and the 200 rows reach back to its first part when they start inside
    it. A picker whose candidates couldn't be read says so and why, where it
    said the record's last 200 rows held no pinnable message. The Web UI's
    transcript shows one text ingested twice, each time stored in parts, as
    two rows, each marked by its own first part, where it joined both into
    one row, marked as the first ingestion was.
- **Web UI observers:** the trace frames of agent-framework's presentation
  index, `presentation:presented`, `presentation:unreadable-audience`,
  `presentation:failed`, `presentation:hand-off-mismatch`,
  `presentation:retracted` and `tune-out:subconscious-window`, need the `ops`
  scope, and `presentation:repaired` needs `health` and `ops`. They carry
  agent names, counts, ids and slots, never content. `window:undone`, an undo
  or a redo on a window, needs `messages`, and so does the new
  `undone-marks` frame, sent at each undo, redo or shed on the conversation
  agent's window, which names each row of the transcript's record that an
  undo or a shed took out of that window (status `undone`), from `fromIndex`
  0, as a welcome's and a history page's entries mark them (`undone: true`).
  The host asks the status only of the rows out of that window, so building
  it takes about a tenth of the time a status read of every row took (some
  80 ms on the host's event loop at 50,000 rows). `undo:completed` and
  `redo:completed` are gone, with agent-framework's branch-moving undo.
- **Going back to an earlier release** after this one: a row this release
  stored for an agent while its turn was alive is where the record put it, and
  an earlier release compiles the record in that order, so the agent's next
  request misses the prompt cache and, on a model that binds a reply's
  thinking to what came before it, leaves the thinking after that row out.
  Nothing is lost. A queue of held writes that an earlier release left is
  stored once at this release's first start, and an earlier release then
  finds it empty. The first window written down with rows, or a presentation
  of more than one row, moves the store's MANIFEST to version 2, which
  chronicle 0.5.0 and earlier refuse, and so every earlier release of this
  host (context-manager's notes): going back after that needs the copy the
  update took. `/update back restore` puts it
  back. `/update back keep` stops at the older release's store audit, and the
  next start puts this release back.

  **Migration:** to revert the record, as `/undo` did, use
  `/branchto <msgId>` with the id of the last row to keep (`/history` and
  `/find` show ids), or the Web UI's rollback. A client that refreshed its view
  on `undo:completed` or `redo:completed` listens for `window:undone`.
  `/history`, `/find` and `/branches` read the context of the agent the
  commands act for, as `/branchto` does, where they read the first
  registered agent's. A checkpoint saves the record's position, its last
  row, an undone one included, as it did. `/undo` leaves that row the
  record's last, so after `/undo` a `/restore` to a checkpoint at the undone
  turn's last row, with no row stored since, says it is already there and
  moves nothing (and, where a redo exists, says `/redo` puts back what the
  agent's latest undo took out, that row if the undo took it: a shed marks
  rows undone and keeps none); once a row is stored after the
  checkpoint, a `/restore` to it rolls back with that turn in the window, a
  checkpoint taken after `/undo` included. **Unchanged:**
  `/checkout`, `/restore` and `/branchto` are still refused while any agent
  sharing the store is mid-turn, the subconscious included, as the 0.16.0
  entry for #264 has it, and `/newtopic` while the agent the command acts
  for is. A caller that reads or matches a branch command's answer gets,
  for another agent's turn, the progress line and then agent-framework's
  refusal (above), and the host's immediate `refused: a turn is in flight`
  only for the command agent's own turn.
