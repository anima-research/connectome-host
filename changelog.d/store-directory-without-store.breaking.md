- **Operators:** the host now refuses a session's store directory that holds
  no store. A start, `/session switch` and the store audit each refuse it.
  This covers a mount point whose volume isn't mounted, and a link to a
  directory that isn't there. Each refusal names the directory and why no
  store opened, and the host writes nothing there. A start also refuses an
  empty `<data>/store`, where hosts before sessions kept their one store. If
  such a refusal comes during an update's trial, the update doesn't commit.
  From 0.23.0 until now, a start, a switch and the audit each made an empty
  store in an empty directory. The resident then began that session with no
  past, and the audit printed `opens`. Before 0.23.0, a start and the audit
  failed on an empty directory. A start and the audit now also refuse a
  store that Chronicle left half made, with no `MANIFEST`. They used to
  complete it. `scripts/warmup-session.ts` now makes no store at all. It
  exits 1 when the session's store directory is absent or holds no store.
  **Migration:** mount the volume that holds the store. If the session
  should begin empty, remove the directory instead. **Unchanged:** a first
  start, `/session new` and the importers work as they did. When a session's
  directory is absent, a start or a switch still makes its store.
