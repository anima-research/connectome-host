- Add autobiographical-only `compressionInstructions.templates` with shared
  Context Manager validation; templates need no preset and omitted slots
  preserve built-ins. Frontdesk and passthrough reject this option. Unrelated
  strategy keys retain existing admission and retired-field warnings.
  When this option is present, construction rejects separate host/framework
  Context Manager classes with a deduplication error rather than silently
  dropping templates. Custom extension factories keep their own contract.
  See `docs/compression-instructions.md` for slot usage, scope and dependency
  compatibility.
