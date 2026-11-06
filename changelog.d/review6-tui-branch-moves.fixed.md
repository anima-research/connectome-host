- The TUI draws the history of the branch the store is on once `/checkout`,
  `/restore` or `/branchto` has moved it, and when a rollback whose switch
  failed left the store on the new branch. It kept showing the earlier
  branch's transcript: agent-framework traces no branch move, and the TUI
  read a branch change only from a command's first answer, which never
  carries one. It doesn't write the `_config` mount again then:
  agent-framework writes it for the move, for `/checkout` while it holds
  the store (the answer says if that failed), and for `/restore` and
  `/branchto` as it lets the store go (a failure is only in its log). A
  rollback that failed and couldn't put the store back writes it for
  neither, and its answer now says the gate's files may still be the
  previous branch's and that `/checkout <branch>` writes them. A turn
  of the root agent's that started on the new branch before the move's
  answer came streams on, and the branch is drawn once the turn ends, the
  answer again below it with every command's answer drawn since: the
  redraw cut the turn's line off, its later words were lost, and the
  status read idle while it ran. A `/clear` while that redraw waits
  leaves the scrollback clear: the turn's end takes up the branch and
  draws nothing, where it drew the branch's history again. Another
  client's move (a Web UI `/checkout`, `/restore` or `/branchto`), of
  which the TUI hears nothing either, is drawn before the TUI next links
  or marks its lines, at a turn's end or an undo, redo or shed, or once a
  root turn running on the new branch ends, with a line naming the
  branch: the TUI kept showing the earlier branch until a command of its
  own drew one, and rows stored on a shorter branch were never linked to
  their lines, so an undo of them marked nothing. An async command started or answered
  while a root turn runs, backgrounded or held after a failed attempt
  too, leaves the turn's status as it is, where its start set it to
  thinking and its answer to idle.
