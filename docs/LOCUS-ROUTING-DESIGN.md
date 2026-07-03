# Conversational Locus & Output Routing — Design Note

**Status:** Agreed design, implementation deferred.
**Date:** 2026-05-29
**Context:** Surfaced while wiring periodic heartbeats for an agent instance
running headless on a Linux VPS.

---

## TL;DR

"Stickiness" — *where does the agent's plain-text output go by default* — is a
**host concern, not an MCPL concern.** It currently lives in `discord-mcpl`
(in-memory `lastChannelId` + an `afterInference` auto-post hook). That is a
single-surface shortcut. It must be hoisted into the host
(`@animalabs/agent-framework`), persisted natively in the chronicle, with MCPL
servers reduced to pure `channels/publish` executors.

## Problem / how we got here

- A heartbeat MCPL (`heartbeat-mcpl`) was built to wake the agent on an interval
  via `push/event`. Wakes fire and the agent responds — but nothing posts to
  Discord.
- Root cause of "no post": `discord-mcpl` tracks the sticky channel in an
  in-memory field `lastChannelId`, initialized to `null`, set only on inbound
  Discord messages / outbound sends. It is **not persisted**, so every
  agent restart resets it to `null`. A heartbeat firing after a restart
  has no sticky channel → `afterInference` skips (`reason: no-sticky-channel`).
- First instinct was to persist `lastChannelId` (file, then MCPL host-state).
  That instinct is wrong: it persists *host-conceptual* state through the MCPL
  layer because the state is living in the wrong layer.

## The decisive argument (multi-surface)

Each MCPL server sees **only its own surface's events**. With two surfaces
(e.g. `discord-mcpl` + a future `telegram-mcpl`):

- discord-mcpl knows only the last Discord channel; telegram-mcpl only the last
  Telegram chat. **Neither can see the other.**
- If the agent gets a Discord message, then a Telegram message, the true locus
  is now Telegram — but discord-mcpl cannot know it's no longer active.
- A per-server sticky design therefore **races**: a text-only reply could
  double-post (Discord *and* Telegram), or land on the stale surface.

Only the **host** sees the merged event stream across all MCPLs, so only the
host can determine the real cross-surface locus and make one coherent routing
decision. ∴ locus tracking can only correctly live in the host.

## Target design

- **Host owns the locus.** It already observes every `channels/incoming` and
  every outbound send across all servers. Track `(serverId, channelId)` of last
  activity as host state, persisted natively in the chronicle (no MCPL
  `state/update` round-trip; it's just host state, and rides chronicle
  branching/rollback for free).
- **Host makes the routing decision.** On a text-only turn (agent produced text
  with no explicit send tool call), the host decides whether/where to route it,
  using the locus.
- **MCPL servers are pure executors.** "Publish this text to `channelId`" via
  `channels/publish`. They no longer track stickiness or own `afterInference`
  auto-post.
- **Retire** `discord-mcpl`'s `afterInference` auto-post + `lastChannelId`
  once the host owns routing. (It's a single-surface shortcut; it breaks the
  moment a second surface exists.)

## Where it lives

The orchestration layer that sees all servers: **`@animalabs/agent-framework`**
(`mcpl/hook-orchestrator.ts`, `mcpl/push-handler.ts`, `mcpl/channel-registry.ts`).
This is a *published package*, so this is a framework change, not a host-app or
discord-mcpl patch.

## Implications for related ideas

- **"Inform the agent where output goes"** (so it knows a plain reply will post
  to #X): this becomes the *host's* job — surface the current locus into context
  natively. NOT a `discord-mcpl` `beforeInference` injection (wrong layer). Drop
  that idea from discord-mcpl.
- **Heartbeat MCPL is validated by this.** It is correctly surface-agnostic — it
  only *wakes* the agent; deciding where output goes was never its job. No change
  needed there.
- **`CHX_NOOP_PREFIX` ('m continue')** — the existing "prefix your output to
  suppress the auto-post" hack in discord-mcpl — should not be surfaced to the
  agent. The clean answer to "think without posting" is the **dedicated
  deliberation channel** (separate work): a place where sticky/auto-post simply
  doesn't apply.

## Interim state (acceptable)

- The agent runs headless on the VPS; heartbeats wake it and it responds.
- Sticky does **not** persist across restarts → heartbeat/agent text right after
  a restart won't auto-post to Discord until there's fresh channel activity.
  Known, benign gap. No workaround installed (deliberately — avoid entrenching
  locus in the wrong layer).

## Bugs found in passing (separate fixes, worth upstreaming)

1. **discord-mcpl `connect()` race** — resolved on `login()` (before gateway
   READY), so `registerDiscordChannels` enumerated an empty `guilds.cache`.
   *Fixed*: `connect()` now awaits the `ready` event. (Not yet
   committed/pushed.)
2. **Empty `DISCORD_GUILD_ID` → `[]` filter** — `"".split(',').filter(Boolean)`
   yields `[]` (truthy), and the guild filter then excludes *all* guilds.
   *Worked around* by setting `DISCORD_GUILD_ID` to the real guild id. Real fix:
   treat empty as "no filter."
3. **`push/event` rejected: featureSets array vs record** — the agent-framework
   `initializeServer` consumes `capabilities.featureSets` as a **name-keyed
   record** (`{...declared}`, `Object.keys`, `featureSet in declared`), but the
   `mcpl-core` type annotates it as `FeatureSetDeclaration[]`. An array keys by
   index ("0"), so `enabledFeatureSets` matches nothing and every `push/event`
   is rejected as "Feature set not enabled." Discord avoids this because its
   messages arrive via `channels/incoming`, not `push/event`.
   *Worked around* in `heartbeat-mcpl` by sending `featureSets` as a record.
   Real fix: normalize array→record in `initializeServer`, or fix the type +
   all senders.
