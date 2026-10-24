- In readline and batch mode (`--no-tui`, or input that isn't a terminal), a
  slash command's later lines are printed when they come, and in batch mode
  the next line of input, and the batch's stop, wait for them. `/auth`'s
  actions, `/puppet`, `/undo`, `/redo`, `/restore`, `/fleet stop` and
  `/fleet restart` printed only their first lines there before.
