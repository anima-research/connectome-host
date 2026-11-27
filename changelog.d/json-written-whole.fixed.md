- Every JSON file the host rewrites is written whole — to a file beside it,
  then renamed over it — so a host or a machine that stops mid-write leaves
  the file as it was: the sessions index (`sessions.json`, rewritten at every
  start and switch), the saved recipe (`.recipe.json`, at every start) and
  the MCPL config, which were written in place, now go the way the
  self-restart, observers and identity files already went; a test holds the
  rule over `src/`. A file with a mode (`.recipe.json`, the MCPL config)
  gets it on overwrite too. A sessions index that isn't JSON (empty, or cut
  short by such a stop before this) is refused at the start by name, with
  the parse error, where the sessions' stores are, and the ways out, where
  the start ended with a bare `SyntaxError` and a stack naming no file
  (#740).
