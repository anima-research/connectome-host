- `connectome sweep` rewrites rows the running host has already stored, by a
  named sweep. A sweep is given only rows whose content is text alone. With no
  name, it lists the sweeps the release knows. With a name, the host shows
  each row that sweep would rewrite: its kind, its id, its time, the agents
  whose window holds it, its length before and after, and its new text, never
  its old text. It writes nothing, and says which agents' prompt caches a
  write would rewrite, each from its earliest such row. With `--write`, the
  host rewrites the rows on the current branch, leaves a row as it was while a
  turn of an agent whose window holds it is alive, names a row whose edit
  fails, and records the run in the operator log: the rows it rewrote, left,
  failed or found in shards, each with its agent and up to 50 of each kind,
  and the branch and the store's sequence before its first edit. A row stored
  in shards isn't rewritten: the answer names it with its count of shards, and
  a `--write` that meets one ends refused. A later rollback to a row stored
  before the sweep brings that row's old text back, and a `--write` that
  rewrote a row says so. A summary already built from a rewritten row keeps
  its old words, and the answer says so where the strategy of an agent whose
  context holds the row renders summaries. On a host with fleet children, the
  answer says that the sweep reached this host's own agents alone, and how an
  agent sweeps a child. While a command that changes the session, such as a
  bare `/newtopic`, is still running, `--write` writes nothing. It rewrites
  the open session's rows; on a host with more sessions, its answer says so,
  and each other session takes its own run after a switch. The host's own
  `/sweep` takes the same words. The host's ready event names the sweeps it
  knows, in `sweeps`, and `connectome sweep NAME` asks nothing of a running
  host from an earlier release that doesn't know `/sweep` or that sweep.
