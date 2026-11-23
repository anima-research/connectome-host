# Main-final-refusal reactions (experimental)

`mainRefusalReactions` replaces the framework's built-in refusal reactions with
host-selected connector drivers. **It requires the version-1 main-refusal bridge
from agent-framework#1018, which is not yet released.** The locked AF dependency
does not support this option. Omit it to retain the framework's normal behavior:
the built-in Discord reaction marks the message the turn answers, if any.
There is no supported released installation recipe for enabling it yet.

## Configuration and ownership

The optional root recipe field has this shape:

```json
{
  "mainRefusalReactions": {
    "ownership": "whole-framework",
    "servers": [{
      "serverId": "discord",
      "kind": "discord",
      "sourceRevision": "dc80b2fba48308fdfe13a9920ff744ead0118c01"
    }]
  }
}
```

Ownership replaces **all** built-in refusal reactions, including those on
unselected Discord servers. Include every server that needs markers. Unselected
servers produce diagnostics, not legacy fallback. Unknown origins are log-only;
the host does not invent a home destination. The separate streak-two home/ops
policy remains unchanged.

Each selected server must be a unique configured stdio child with an explicit
child environment (`inheritEnv: true` and network transports are unsupported).
It must be connected, non-refused, and have a defined bridge binding and epoch
at install. Closed-tab selection and failed first connects fail startup rather
than silently taking ownership without a working server. This includes tabs
restored closed from saved state. Recipe shapes are validated at load, then
connector/environment checks run again during preparation and installation.

Bridge availability and child configuration are checked **before**
`AgentFramework.create`. Installation runs **after** create has connected startup
servers. An installation failure stops that framework and its children; it is
not a pre-handshake check. Each framework instance (including a new session)
acquires its own owner; teardown calls the disposer from that acquisition.

## Discord

The supported source contract is `anima-research/discord-mcpl` at the revision in
the example. `sourceRevision` is an operator assertion, not runtime proof of the
installed executable. Verify the connector artifact before use.

Prefer omitting `DISCORD_SUPPRESSED_REACTIONS_BASELINE` from the child environment.
AF then supplies its per-spawn protective default, including refusal markers,
configured awareness markers and retained outbox markers. An explicitly declared
value replaces that complete dynamic default: the host checks that it contains
all AF refusal markers, but cannot guarantee coverage of future awareness
markers. Do not add a static refusal-only override to enable this feature.

The driver preserves canonical `discord:<guild-snowflake|dm>:<channel-snowflake>`
channel IDs and numeric message-reference strings. Before each ADD,
`filters_get` must report suppression source `baseline-default`, status `active`,
and `protectionActive: true`. Operator file/legacy-env overrides are unsupported
and are never read or modified to make a check pass. Refusal emoji values come
from AF's exported category map and fallback.

## Zulip: pending connector contract decision

The retained experimental driver targets `theaspirational/zulip_mcp` at
`61298a12396c27e7cebc004f31cf67c958e35930`, **not upstream Zulip MCP**. Its ID
contract is fork-only and has no supported upstream release. Do not assume that
setting environment variables makes an upstream connector compatible.

Its server entry requires `kind: "zulip"`, that `sourceRevision`, `realmTag`,
`idMode`, `emojis` (a category-to-name map with a required `unknown` fallback),
and `availableEmojiNames` (operator-preflighted names). Explicit child
`ZULIP_ID_MODE` and `ZULIP_REALM_TAG` must match. Strict/compat modes preserve
scoped string IDs; compat also accepts positive safe decimal strings. Legacy
mode currently passes preparation but cannot emit a reaction. No numeric
coercion or realm stripping is performed.

The driver unions configured names into `ZULIP_SUPPRESSED_REACTIONS_BASELINE`,
preserving entries in **that variable only**. The connector prefers it over
`DISCORD_SUPPRESSED_REACTIONS_BASELINE`, so AF's injected Discord-named baseline
is hidden. These limitations remain pending the Zulip contract decision.

## Lifecycle and diagnostics

The host snapshots the bridge's opaque binding and epoch at installation. It
never silently trusts a replacement configuration. If either changes, markers
fail closed and ownership remains held: **there is no legacy fallback or runtime
rearm**. Restart the whole host through normal preparation and installation to
recover. An issued ADD cannot be undone.

An epoch identifies the framework's config and connection objects in this
process, not the child PID, a transport epoch, or a connector's identity.
Automatic crash/reconnect in place keeps that epoch; replacing the connection
(including `mcpl_restart` or deploy/restart) changes it even when the config
matches. Restart the whole host to re-enable marking after replacement.

Diagnostics include server ID (null for unknown origin), agent name, turn ID and
category. When a current refusal cannot produce a marker, the first failure per
server also sends a `refusal-reaction-unavailable` ops alert. Alerts are bounded
per installation, not a background health monitor: stale state is detected when
a refusal arrives. Check the status, connector availability, advertised schema,
capabilities and suppression policy; restart the host after correcting config.

## Effect guarantees

Only unhandled MAIN final refusals after provider retries and rewind decisions
are eligible. Handled rewinds and ephemeral/subagent runs have no effect. A
marker identifies the request's origin, not cause attribution or proof of human
receipt. Tool calls use the captured agent's normal authorization and effective
advertised schemas; unsupported constraints or capabilities fail closed.

Effects are ADD-only, with no deletion or automatic retry after an unknown
acknowledgement. The host retains 1024 turn/instance keys and allows eight effects
in flight. A fresh turn is independent. Disposing prevents unissued calls but
cannot undo calls already issued. No durable exactly-once or cross-host guarantee
is provided. No grants, subscriptions, operator filter files or DM policies change.

## Tests

`bun test test/refusal-reactions.test.ts test/refusal-recipe.test.ts` exercises
host behavior with public-surface doubles. Source-backed connector tests require
`REFUSAL_CONNECTOR_SOURCE_DIR` containing `discord-source/` and `zulip-source/`
checkouts at the revisions above. For AF integration, build and pack AF #1018
locally, then replace `node_modules/@animalabs/agent-framework` with the unpacked
tarball in a lockfile install (or link a coherent local build). Set
`LOCAL_AF_SOURCE_ROOT` to the same AF source tree for the offline stream fixtures
and run `bun test test/refusal-framework-integration.test.ts`. Published-AF integration coverage
remains blocked on the bridge release. No live bot or realm qualification is
claimed by these offline tests.
