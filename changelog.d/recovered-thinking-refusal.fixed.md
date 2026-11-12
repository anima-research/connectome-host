- **Residents imported from a claude.ai export no longer stop answering on Opus 5, Opus 5.5 and Fable.** Since
  2026-11-09 those models refuse any request carrying the `<recovered_thinking>` text blocks
  `scripts/import-claudeai-export.ts` writes for historical thinking, empty ones included (`stop_reason: "refusal"`,
  category `reasoning_extraction`, 0 output tokens), while Sonnet, Haiku and Opus 4.8 and older take them (#604).
  The host now learns this per model: a request that went out carrying the blocks and was refused that way, before
  any of it streamed, is sent once more without them, with no refusal alert. Only if that resend is not refused the
  same way is the model marked, and the blocks are then left out of its requests for the life of the process
  (`[recovered-thinking]` in the log); a refusal with another cause marks nothing. After a restart, the first such
  request per model is refused once more. Where it engages: the Anthropic adapter always; Bedrock on non-streamed
  calls (compression) only, since its streams don't carry the refusal's category; OpenRouter and OpenAI-compatible
  adapters not at all (their refusals carry no category), so use the strip script there. Warmup
  (`scripts/warmup-session.ts`) runs behind the same guard. Whole blocks are left out, and complete tagged spans
  inside other text (a compression request's transcript, string content, `tool_result` text) are replaced by
  `[earlier thinking left out]`; the Web UI's context-makeup count leaves them out the same way. The store keeps
  them. On models that bind signed thinking to what came before it (Opus 5.5, Fable), leaving the blocks out
  changes that history, so signed thinking minted while the blocks were sent is dropped by the provider from then
  on. The importer no longer writes a tag for empty thinking, `--drop-thinking` leaves thinking out altogether, and
  a turn of thinking alone keeps `[earlier thinking left out]` (or `[empty turn]` when its thinking was empty).
  `scripts/strip-recovered-thinking.ts <store-path>` removes the blocks from a store's current branch, for hosts
  older than this or adapters the guard can't cover (dry run by default, on a throwaway copy; `--apply` to edit;
  `--empty-only` for empty tags only; unknown options are refused, and it exits 2 when it leaves tagged blocks in
  place).
