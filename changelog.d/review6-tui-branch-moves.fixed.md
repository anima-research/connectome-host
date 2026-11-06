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
  answer again below it: the redraw cut the turn's line off, its later
  words were lost, and the status read idle while it ran. No command's
  late answer sets the status idle while a root turn runs.
