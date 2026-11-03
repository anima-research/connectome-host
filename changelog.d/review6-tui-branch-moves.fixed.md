- The TUI draws the history of the branch the store is on once `/checkout`,
  `/restore` or `/branchto` has moved it, and when a rollback whose switch
  failed left the store on the new branch. It kept showing the earlier
  branch's transcript: agent-framework traces no branch move, and the TUI
  read a branch change only from a command's first answer, which never
  carries one.
