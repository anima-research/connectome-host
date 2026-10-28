- **Operators who read a data directory as another user that isn't
  root,** such as a backup run as its own user: a data directory that a
  host, a fleet launch, an import script or the evacuator creates from
  this version on is readable by its owner alone (`0700`), and so is the
  `sessions` directory made in one, so that reader can't open them. That
  includes the data directory of a fleet child whose directory doesn't
  exist yet when it's launched, on an install that was already running.
  The evacuator's recipe and saved state are `0600` after every write,
  even in a directory that was already there. To keep such a reader
  working, run it as the agent's user or as root, or give its group
  access to the directories yourself once they're made (`chgrp` and
  `chmod g+rX`): a directory's mode, once it's there, stays as it is.
  A Go back that restores the copy (`/update back restore`, or
  `start.js --go-back` without `--keep-data`), or the next start after
  an updated release ends before its commit, puts what's inside each
  directory an update copies (`docs/DEPLOYMENTS.md` lists them) back as
  new copies, each with its mode but in the group a new file or
  directory there gets, so run the `chgrp` again after one. Group
  access doesn't reach the files kept for their owner alone, the
  evacuator's recipe and state and the host's saved recipe, which each
  write leaves `0600`: a reader that needs them runs as the agent's user
  or as root. Unchanged: every data directory made before this version,
  and what a reader running as the agent's user or as root can read.
