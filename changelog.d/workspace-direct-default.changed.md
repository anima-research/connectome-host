- Workspace mounts accept `backend: "direct" | "chronicle"` in
  `modules.workspace.mounts[]` and pass it to the framework, whose default is
  now `direct`: the workspace tools read and write the mount's directory
  itself, with no Chronicle tree to materialize or sync and no cached copy
  that can go stale behind shell-side edits. The host-managed `_config`
  mount is pinned to `chronicle` (undo/redo rewind it through
  `materializeMount`). The instructions-path check now requires
  `autoMaterialize: true` only on a read-write *chronicle* mount; a direct
  mount writes disk directly. Residents also gain the framework's `watch`
  tool (wake on outside changes to a path) and `write { append: true }`.
