- `folds.jsonl`, the resident's fold record (CONN-20; shelf-381). It is on by
  default at `<dataDir>/memory/folds.jsonl`; `modules.foldsExport: false` turns
  it off, and `{ path }` moves it.
  - It's a labelled as-of projection of the selected branch's newest 100 fold
    receipts: a header line naming the branch, store, newest receipt, the
    window's first receipt, write time and whether older receipts were left
    out (`more`), then one receipt per line, oldest first. Older receipts stay
    in the context manager's journal; `history--folds` with `afterId: "0"`
    pages through every receipt from the start. A projection reads and writes
    only the window, so its cost doesn't grow with the resident's history.
  - It's rewritten shortly after each new receipt (the next turn of the event
    loop, off the round that accepted it), at startup and at shutdown, and the
    branch is checked at roughly one-second intervals. `history--folds` is the
    exact query. A write that fails is logged on stderr and shown in `/folds`,
    and the next receipt or startup tries again.
  - The host overwrites only the projection it last wrote. A host-level
    ownership ledger (`<dataDir>/folds-export-ownership.json`, shared across
    sessions) records the hash it committed, and a pending hash before each
    replace.
  - Any other file at the target, an earlier projection put back included, is
    an export conflict. The file is preserved, export to it stops, and the
    conflict shows in `/folds` and `history--folds`, which also tells the
    resident how to resolve it. `/folds takeover`, or the resident's
    `take_over_export` utility, keeps the existing file beside the target and
    resumes.
  - The resident's fold receipts name `connectome-host`, the data directory and
    the agent.
  - The takeover utility rides the `utils` meta-tool. A recipe with no other
    utility, as every recipe in `recipes/` is, now sends that tool with each
    request, so the first request after upgrading misses the prompt cache.
    With `modules.foldsExport: false`, the request's tools are as before.
