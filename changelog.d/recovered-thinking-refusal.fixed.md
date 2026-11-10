- **Residents imported from a claude.ai export stop answering: every turn is refused.** Since 2026-11-09 the
  Anthropic API refuses requests whose assistant turns carry earlier reasoning as text (`stop_reason: "refusal"`,
  category `reasoning_extraction`, 0 output tokens), and `scripts/import-claudeai-export.ts` wrote each historical
  `thinking` block as a `<recovered_thinking>…</recovered_thinking>` text block, empty ones included (#604). The
  importer now drops thinking; `--keep-thinking` keeps the old wrapping for non-empty thinking, and an empty tag
  is never written. For sessions imported before this, `scripts/strip-recovered-thinking.ts <store-path>`
  removes those blocks through `editMessage()` (dry run by default, `--apply` to edit, `--empty-only` to remove
  only empty tags). The transplant addendum and the revival recipe no longer describe the tags.
