- `connectome sweep` rewrites rows the running host has already stored, by a
  named sweep. With no name, it lists the sweeps the release knows. With a
  name, the host shows each row that sweep would rewrite: its kind, its time,
  the agents whose window holds it, its length before and after, and its new
  text, never its old text. It writes nothing, and says which agents' prompt
  caches a write would rewrite, each from its earliest such row. With
  `--write`, the host rewrites the rows on the current branch, leaves a row as
  it was while a turn of an agent whose window holds it is alive, names a row
  whose edit fails, and records each write in the operator log with its
  counts. The host's own `/sweep` takes the same words. This release ships
  with no sweep.
