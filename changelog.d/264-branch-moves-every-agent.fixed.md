- `/restore`, `/checkout` and `/branchto` move the branch through the
  framework, so every agent sharing the store is re-initialized for the new
  branch, not only the first agent. Before, another agent on an
  `AutobiographicalStrategy` (a conversation fork, for one) failed every
  compile with "requires reinitialization for the current branch generation"
  until a restart (#264). `/undo` and `/redo` move no branch now (see the
  291-presentation entry).
- The three are refused while any agent sharing the store is mid-turn, naming
  it, the subconscious included. A move the framework refuses leaves the
  branch, the branches and the session's checkpoints as they were (it makes no
  branch), says this command moved nothing, and, when the store is busy, to
  try again once what it names has finished. A switch whose `_config` refresh
  failed after the store moved says it switched, that the gate's files may
  still be the previous branch's, and that `/checkout <branch>` runs the
  refresh again. A `/restore` leaves its checkpoint as it is if it was saved
  again, or cleared, while the restore waited.
- The README now says `/undo`, `/redo` and `/newtopic` are refused only while
  the agent the command acts for is mid-turn. It said the commands that move
  the head "are refused while a turn is in flight", which read as any agent's
  turn. That refusal now ends "Wait for the turn to end, or stop it, then
  retry." where it ended "Stop the generation first, then retry."
