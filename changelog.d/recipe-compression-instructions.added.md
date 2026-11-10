- Add autobiographical-only `compressionInstructions.templates` with shared
  Context Manager validation; templates need no preset and omitted slots
  preserve built-ins. Frontdesk and passthrough reject this option. Unrelated
  strategy keys retain existing admission and retired-field warnings.
  Companion draft: requires a feature-containing CM release and aligned
  agent-framework/host dependencies before release (see
  `docs/compression-instructions.md`); current manifests do not provide the API.
