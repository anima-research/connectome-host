- A recipe's new key `ownSettings` lets the resident read some of its own
  settings, and change some of them. It takes `"all"`, `"read"`, or a list
  of names from the table of 21 settings in `src/own-settings-table.ts`. The
  resident writes its settings into `own-settings/own.json` in the data
  directory. If it may change a setting and the workspace is on, it reaches
  the file through the mount `_settings`. The host applies the file at each
  start. It checks each entry alone first, and then checks the recipe with
  the entry in it. An entry that fails is left out, and the others still
  apply. A value in the file gets no `${VAR}` substitution, and the saved
  recipe never holds one. The utility `settings--own` shows the resident its
  settings, and what its file changes at the next start. The host tells the
  resident when its file doesn't take effect as written. The host parks the
  file as `own.not-used.json` when the recipe stops letting the resident
  change settings. A later grant of a change brings the file back, if there
  is no `own.json` and the host can read the parked file as a plain file of
  5 MiB or less. `connectome doctor` prints what the next start would do
  with the file. A recipe without `ownSettings` runs as before, with one
  exception: a start parks an `own.json` that an earlier grant left, and
  tells the resident. Before this change, the host warned that it ignores
  a key named `ownSettings`. A recipe with that key now loads only if its
  value is `"all"`, `"read"` or a list of the table's setting names.
