- A recipe's `ownSettings` lets the resident read and change some of its own
  settings, from the 23 of a table in `src/own-settings-table.ts`: `"all"`,
  `"read"`, or a list of setting names. The resident writes them into
  `own-settings/own.json` in the data directory, through a mount `_settings`
  where the grant lets it change a setting and the workspace is on, and the
  host applies the file at each start. Each entry is checked alone, and then
  with the recipe's own checks, and an entry that fails costs that entry
  alone. A value of the file gets no `${VAR}` substitution, and the saved
  recipe never holds one. The utility `settings--own` shows the resident its
  settings and what its file changes at the next start, and a note at a start
  says when the file did not take effect as written. When the recipe stops
  letting the resident change settings, the host parks the file as
  `own.not-used.json`, and puts it back when a later recipe lets it again.
  `connectome doctor` prints what the next start would do with the file. A
  recipe without `ownSettings` runs as before.
