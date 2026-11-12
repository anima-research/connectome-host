# Service-home fork contract fixture

Source-only inspection, no connector execution or network calls:
`https://github.com/theaspirational/zulip_mcp` commit
`61298a12396c27e7cebc004f31cf67c958e35930`.

- `src/tools.ts:155-205`: send_message schema transcribed as data, descriptions
  omitted; actual nullable type/to/topic preserved. All modes share these fields.
- `src/message-ids.ts:3,20-52`: tags `[a-z0-9][a-z0-9_-]{0,63}`, positive safe
  numeric suffix, compat/strict project send receipts' id/ids without losing tag.
  Tests use fabricated realm:42 and other-realm_2:42, not real message identities.
- `src/tool-runtime.ts:430-438,815-850`: receipt projection and optional explicit
  routing fields. The fixture does not invoke these handlers or import connector
  code; no private files, sessions, grants, APIs or source worktree dependency.
- `src/message-links.ts:17-31,78-109`: scan anywhere, immediate backslash escape
  removed for literal display; unreadable or >20 unescaped macros fail before
  posting. The independent model forbids lookups; successful host output must
  take only the escaped-literal path in legacy, compat and strict modes.

AF event regressions use installed stock `@animalabs/agent-framework` 0.33.0:
`src/framework.ts` completeTurn before noteRefusal (29347-29365), successful
endTurn-only `inference:turn_ended` (19082-19100), background maintenance failure
(7920-7947), boundFailureFields (3818-3833), opsAlert projection (34883-34900),
heldWritesTold and store-held-lost data (1956-1969,16447-16449), plus stock CM's
AutobiographicalProgressSnapshot counters. These are synthetic module events,
not provider turns or claims of live connector/realm/self-echo qualification.
