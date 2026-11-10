- **Residents imported from a claude.ai export no longer stop answering on Opus 5, Opus 5.5 and Fable.** Since
  2026-11-09 those models refuse any request carrying the `<recovered_thinking>` text blocks
  `scripts/import-claudeai-export.ts` writes for historical thinking, empty ones included (`stop_reason: "refusal"`,
  category `reasoning_extraction`, 0 output tokens), while Sonnet, Haiku and Opus 4.8 and older take them (#604).
  The Anthropic adapter now learns this per model: the first such refusal of a request carrying the blocks is sent
  again without them, and they are left out of that model's requests from then on (`[recovered-thinking]` in the
  log). The store keeps them. The importer no longer writes a tag for empty thinking, and `--drop-thinking` leaves
  thinking out altogether. `scripts/strip-recovered-thinking.ts <store-path>` removes the blocks from a store, for
  hosts older than this (dry run by default, `--apply` to edit, `--empty-only` for empty tags only).
