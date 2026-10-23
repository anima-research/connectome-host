- A JSON file a person writes or edits by hand now loads when their editor
  saved it with a leading UTF-8 byte order mark. That covers the recipe, the
  MCPL servers file and the agent overlay, the Anthropic credentials file
  (`ANTHROPIC_OAUTH_CREDENTIALS_FILE`) and the observer grants
  (`observers.json`). The recipe and the credentials file failed to load
  with a parse error at a character the editor doesn't show, and the
  servers file and the overlay with "isn't valid JSON". A Web UI started on
  such a grants file admitted no observer. Now the observers it lists get
  the access it grants them, as with the same file without the mark. A
  grants file re-saved with a mark while the host ran kept its earlier
  grants, so a revocation or a shortened expiry saved that way didn't take
  effect; it now does at the next check. A save into such a servers file
  or overlay, which was refused, now keeps the file's other keys. A
  credentials file that an editor re-saved with a mark while the host ran
  kept only the token triple at the next rotation or pasted token, dropping
  its other keys, such as Claude Code's `scopes`. It now keeps them. A file
  the host writes back, a grant or revoke's included, is written without
  the mark. The module opt-in audit (`scripts/audit-module-optins.ts`) and
  the evacuator's check of the recipe it replaces read such a recipe too.
- A recipe or an Anthropic credentials file that isn't valid JSON is now
  refused without repeating the JSON parser's message, which can quote the
  file's text; the refusal names the file, or a fetched recipe's URL.
- Codex's `auth.json`, when it isn't valid JSON, is now refused without
  the parser's error as its cause; a read error keeps its code.
