- **Recipe authors:** built-in strategy keys are checked instead of silently
  dropping unknown fields. Remove retired/ignored keys or correct misspellings;
  all declared strategy keys and custom extension factories' verbatim config
  contract remain unchanged. Add autobiographical-only
  `compressionInstructions.templates` with shared Context Manager validation;
  templates need no preset and omitted slots preserve built-ins. Frontdesk and
  passthrough reject this option. Companion draft: requires a feature-containing
  CM release and aligned agent-framework/host dependencies before release (see
  `docs/compression-instructions.md`); current manifests do not provide the API.
