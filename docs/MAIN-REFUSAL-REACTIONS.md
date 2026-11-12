# Local main-final-refusal reactions (unreleased prototype)

This companion requires the optional AF version-1 main-refusal facet in the local
source candidate. **Stock host lock AF 0.33.0 does not support it.** With the option
omitted, stock recipes load and legacy Discord behavior is unchanged. With the
option selected on old AF, startup refuses before connecting servers. No released
AF dependency, package version or lockfile has been changed.

## Explicit ownership

`mainRefusalReactions` is an optional root recipe field:

```json
{
  "mainRefusalReactions": {
    "ownership": "whole-framework",
    "servers": [{
      "serverId": "zulip",
      "kind": "zulip",
      "sourceRevision": "61298a12396c27e7cebc004f31cf67c958e35930",
      "realmTag": "myrealm",
      "idMode": "strict",
      "emojis": { "bio": "biohazard", "unknown": "stop_sign" },
      "availableEmojiNames": ["biohazard", "stop_sign"]
    }]
  }
}
```

This is **whole-framework** replacement of all built-in refusal reactions, not a
partial server selection. Every Discord server that should still receive refusal
markers must be explicitly included with a supported/preflighted driver.
Unselected servers get a local unsupported-driver diagnostic, **not** legacy
fallback. A Zulip server elsewhere in a recipe does not disable anything. An
unknown-origin first refusal is **log only**, not an invented home fallback; the
existing streak-two home/ops policy and CM summary-purpose classification stay
unchanged. No change to the separate home-notice work is included.

## Known stdio contracts and operator preflight

Only one explicit stdio config per server id is supported; `inheritEnv: true` and
network transports are unsupported. `sourceRevision` is the operator's explicit
choice of a reviewed public connector contract, **not runtime attestation** that a
configured executable actually contains that revision. Before later live use an
operator must verify the installed artifact, environment, realm, emoji
availability and connector contract. Nothing here was live-verified. The public
Discord source is not a claim about the deployed Discord pin.

- **Zulip:** reviewed public fork `theaspirational/zulip_mcp` at the revision above.
  Explicit child `ZULIP_ID_MODE` and `ZULIP_REALM_TAG` must match. Strict/compat
  driver calls preserve the original scoped token, including leading zeroes.
  Compat also accepts a positive safe bare decimal *string* if advertised.
  Wrong-realm tags, whitespace, invalid/unsafe IDs are refused. Numeric-only
  **legacy mode is honestly unsupported**: no `Number(id)`, namespace stripping,
  or schema guessing. An operator must preflight every configured emoji NAME for
  the realm. The in-memory child config unions those names into
  `ZULIP_SUPPRESSED_REACTIONS_BASELINE`, preserving existing baseline entries.
  The reviewed fork unions that baseline with operator lists on every start.
- **Discord:** reviewed public `anima-research/discord-mcpl` at
  `dc80b2fba48308fdfe13a9920ff744ead0118c01`. Configure that `sourceRevision`,
  `kind: "discord"`, and `serverId`. The **explicit child environment** must
  already supply a `DISCORD_SUPPRESSED_REACTIONS_BASELINE` containing all six
  emitted Unicode markers: `☣️,🧪,☢️,💻,🧠,🛑`. Preserve the deployment's awareness
  markers and any additional baseline entries too (AF's
  `getPlacedReactionBaseline()` is the complete deployment baseline). This
  prototype does not replace that complete default with a refusal-only seed.
  The driver uses the documented canonical
  `discord:<guild-snowflake|dm>:<channel-snowflake>` and numeric message-reference
  strings; it passes the canonical channel intact, never blind-splits it.
  Before ADD, public `filters_get` must report effective suppression source
  `baseline-default`, status active and protection active. An opaque file or
  legacy-env override is unsupported even if counts/digests look convincing.
  It is never read or changed to make the driver pass.

The host validates the actual effective advertised ADD schema and server/prefix
binding; it fails closed for unknown schema constraints/required fields or absent
capabilities. Calls use existing `executeToolCall` with the captured agent, so
ordinary tool authorization still applies. There is no second manager, private
field access, general executor, grant change, filter-list change, autojoin,
subscription, DM policy, or permission change. Selected in-memory child configs
are frozen. Replacing the config/connection invalidates the captured process-local
epoch and needs a new install/preflight, never retargeting an old effect.

## Effects and diagnostics

Only MAIN final refusals after provider retries and the rewind decision are
eligible; handled rewinds and ephemeral/subagent runs have no effect. The origin
is request-processing status, **not cause attribution** or proof that somebody
read the marker. Unknown, heartbeat, context-only, ambiguous or unsupported
origins get no effect. Deferred materialization/restored wakes without a trusted
AF snapshot may remain unknown. Category defaults are the legacy Unicode map for
Discord; Zulip uses an explicit name map and required `unknown` fallback.

V1 is ADD only, no removal or clearing another caller's reactions. It remembers
1024 turn/instance keys (oldest evicted) and allows at most 8 effects in flight.
An attempt consumes its key before I/O. Failure/unknown acknowledgement never
automatically retries, requests inference, or starts a new action loop; a fresh
turn is independent. Disposing prevents not-yet-issued calls, but cannot undo an
issued call. No exactly-once, durable restart, or cross-host guarantee is made.
There are no invented message/checkpoint provenance links.

## Offline checks / temporary profile

`bun test test/refusal-reactions.test.ts` uses fake public facets only.
`REFUSAL_CONNECTOR_SOURCE_DIR=<cache-parent> bun test test/refusal-connector-contract.test.ts`
checks exact source revisions in `discord-source/` and `zulip-source/`, imports
only their pure schema/ID/filter modules, and tests fake reaction echoes.
`LOCAL_AF_SOURCE_ROOT=<AF-candidate> bun test test/refusal-framework-integration.test.ts`
requires a **coherent temporary local dependency profile**, described in the
worker evidence report. It uses only a fresh offline stdio fixture, no platform
SDK/API or bot, and tests omission/explicit handover without doubles. Those
optional tests skip without the profile/cache. The normal global
`HOST_LOG_TAGS` catalog regression also covers the new `refusal-reaction` prefix.

The evidence profile is **NOT stock qualification** and not a release recipe.
Separate later PRs, independent review, owner publication approval and live
preflight are still required.
