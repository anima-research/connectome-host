- `folds.jsonl`, the resident's fold record (CONN-20; shelf-381). It is on by
  default at `<dataDir>/memory/folds.jsonl`; `modules.foldsExport: false` turns
  it off, and `{ path }` moves it.
  - It's a labelled as-of projection of the selected branch's fold receipts:
    a header line naming the branch, store, newest receipt and write time,
    then one receipt per line.
  - It's rewritten after each new receipt, at startup and at shutdown, and the
    branch is checked at roughly one-second intervals. `history--folds` is the
    exact query.
  - The host overwrites only a file it wrote itself. A host-level ownership
    ledger (`<dataDir>/folds-export-ownership.json`, shared across sessions)
    records the hash it committed, and a pending hash before each replace.
  - A foreign or edited file is an export conflict. The file is preserved,
    export to it stops, and the conflict shows in `/folds` and
    `history--folds`. `/folds takeover`, or the resident's `take_over_export`
    utility, keeps the existing file beside the target and resumes.
  - Receipts name `connectome-host`, the data directory and the agent.
