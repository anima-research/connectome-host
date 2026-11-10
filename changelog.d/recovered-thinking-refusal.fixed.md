- **Residents imported from a claude.ai export no longer stop answering on Opus 5, Opus 5.5 and Fable.** Since
  2026-11-09 those models refuse any request carrying the `<recovered_thinking>` text blocks
  `scripts/import-claudeai-export.ts` writes for historical thinking, empty ones included (`stop_reason: "refusal"`,
  category `reasoning_extraction`, 0 output tokens), while Sonnet, Haiku and Opus 4.8 and older take them (#604).
  The Anthropic, Bedrock and provider-agnostic adapters now learn this per model: a request that went out carrying
  the blocks and was refused for them, before any of it streamed, is sent again without them, with no refusal alert,
  and they are left out of that model's requests from then on (`[recovered-thinking]` in the log). Whole blocks are
  left out, and complete tagged spans inside other text (a compression request's transcript, string content) are
  replaced by `[earlier thinking left out]`; the Web UI's context-makeup count leaves them out the same way. The
  store keeps them. The importer no longer writes a tag for empty thinking, `--drop-thinking` leaves thinking out
  altogether, and a turn of thinking alone keeps `[earlier thinking left out]` in its place.
  `scripts/strip-recovered-thinking.ts <store-path>` removes the blocks from a store, for hosts older than this (dry
  run by default, `--apply` to edit, `--empty-only` for empty tags only; unknown options are refused, and it exits 2
  when it leaves tagged blocks in place).
