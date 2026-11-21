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

AF event regressions encode orderings read from stock `@animalabs/agent-framework`
0.35.1, the version this branch installs. Line numbers are that build's
`src/framework.ts`: completeTurn (`inference:completed`, no stop reason) before
noteRefusal (30534-30552), refusal `ops:alert` only at streak >= 2
(36225-36240), successful endTurn-only `inference:turn_ended` (19984), the
framework-scoped maintenance pass failure under subject `framework` with
`scope: 'pass'` (8451-8456) and the per-agent one with `scope: 'agent'`
(8668-8680), `dendrite:agent-ended` on agent release (13499-13510), and
store-held-lost alerts (17321, 17367, 17431). `listMcplServers()` exposes no
realm (39154-39216). These are synthetic module events, not provider turns or
claims of live connector/realm/self-echo qualification.
