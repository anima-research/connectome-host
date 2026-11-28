- A session's store directory that holds a `MANIFEST` and not every file a
  store has beside it (`records.log`, `state.bin`, `state-indexes.bin`,
  `branches.bin`) is refused at a start, a `/session switch`, the store
  audit and warmup, as a directory with no store is since 0.27.0: it is a
  copy or a move of a store that didn't finish (an `rsync` cut while copying
  `records.log` leaves exactly that), and Chronicle opened it as a store
  with no past, so the resident began the session with no past and the
  start said nothing. The refusal names the missing file, and nothing is
  written there (#738).
