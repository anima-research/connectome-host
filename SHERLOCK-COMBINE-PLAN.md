# Sherlock Combine — Status, Remaining Work, Test Plan

*June 2026. Companion to `HEADLESS-FLEET-PLAN.md` (triumvirate). Spans four
repos: `zulip_mcp`, `agent-framework`, `forking-knowledge-miner` (host),
`boter` (wiki sidecar).*

## 1. Concept

A riff on the triumvirate for **real-time bug investigations over Slack**.
Three roles, coupled through wiki state rather than events:

| Role | Mode | Reads | Writes | Output |
|---|---|---|---|---|
| **Sherlock** (Investigator) | Per-Slack-conversation fork, interactive | Handbook, case-report library, data-source MCPs, whole wiki | `Case:` namespace only | Answer to the user + investigation report |
| **Watson** (Debriefer) | Fleet daemon, scheduled wake | Everything, read-only | `Debrief:` namespace only | One postmortem per case |
| **Lestrade** (Bureaucrat) | Fleet daemon, scheduled wake | Everything | `Handbook:` + broad wiki | Curated handbook; requests filed into the knowledge-miner |

**Wiki-state-as-queue**: case reports without postmortems = Watson's queue;
postmortems not yet incorporated = Lestrade's queue. No event plumbing
between roles — agents stay decoupled, restarts are free.

**Knowledge loop**: case report → postmortem → handbook → *next* Sherlock
fork. Knowledge never accumulates in a long-lived agent; the trunk is a warm
checkpoint that loads the handbook and goes dormant, and every new engagement
forks from the current trunk.

## 2. What we have (implemented & tested)

### 2.1 zulip_mcp — Slack platform + `mentioned` flag
Branch `slack-integration`, upstream **PR #8** (stacked on #7). 35/35 tests.

- `PlatformAdapter` refactor; Slack via **Socket Mode** (one process, one
  socket — Socket Mode load-balances each event to exactly one connection,
  which is what rules out multi-process per-channel agents and motivates the
  in-process fork architecture below).
- DMs first-class; server-side in-thread reply routing.
- `metadata.mentioned` on incoming messages, all three platforms:
  - Slack: self-user id ∈ parsed `<@U…>` mentions
  - Zulip: server-computed `mentioned` flag (wildcards deliberately excluded)
  - Discord: `msg.mentions.users.has(self)`
- Security hardening from review round 1 (commit `56df964`):
  - attachment-token forwarding locked to exactly `files.slack.com`
    (workspace hosts `<name>.slack.com` serve `/api/*` and tool input is
    attacker-influenced)
  - Zulip `/user_uploads/` check documented as relying on `new URL()`
    dot-segment normalization (incl. `%2e%2e`) — SAFETY INVARIANT comment +
    regression tests
  - npm-bin symlink guard (`realpathSync(argv[1])`), typed wire payloads,
    shared user-name resolver, no silent catches

### 2.2 agent-framework — per-channel conversation routing
Commit `6de13eb` on main (local). 154/154 tests (137 pre-existing + 17 new).

Opt-in via `FrameworkConfig.conversations`; zero behavior change when unset:

```ts
conversations: {
  templateAgent: 'sherlock-trunk',       // required; must name a configured agent
  bind:    { dm: 'always', channel: 'mention' },   // defaults shown
  trigger: { dm: 'always', channel: 'mention' },
  idleTtlMs: 12 * 60 * 60 * 1000,        // default 12h
  closurePrompt: '…',                    // default provided
  agentPrefix: 'conversation',
  strategyFactory: () => new SomeStrategy(),  // fresh per fork; else passthrough
}
```

Mechanics:

- **`ConversationRouter`** (`src/mcpl/conversation-router.ts`) — lookup table
  + policy, deliberately no LLM in the routing path. Two-phase spawn:
  `route()` proposes, framework spawns, `bind()` commits — a failed spawn
  self-heals on the next qualifying message.
- **Forks are namespace-copy agents, not Chronicle branches** (delta from the
  original plan; matches the proven SubagentModule pattern): persistent Agent
  + ContextManager under `conversations/{name}`
  (e.g. `conversation-slack-C123-g1`), seeded by copying the trunk's compiled
  context. Chronicle branching stays reserved for undo.
- **Bind vs trigger split**: ambient messages in a bound channel land in the
  fork's context *without* triggering inference — a busy channel is all case
  input, but only mentions demand a reply. Server-config
  `shouldTriggerInference` veto composes (`decision.trigger &&
  event.triggerInference !== false`).
- **Scoping**: fork `beforeInference` injections filtered to the home
  channel; `channel_publish` defaults to and is locked to it. Home mapping
  (`conversationAgentHomes`) is permanent — it outlives the binding so the
  TTL closure turn still publishes to the right place. Broadcast inference
  (push events, requestInference) excludes forks.
- **Lifecycle**: once-per-minute sweep; idle TTL → closure turn ("finalize
  your work, post promised results") → unbind. Next mention spawns
  generation+1 **from the current trunk** — this is how handbook updates
  propagate between engagements.
- Concurrency was already free: the framework drives a background stream per
  agent.
- Unrouted messages (no binding, bind rule unmatched) are dropped with a
  trace event; the trunk never listens.
- New trace events: `mcpl:conversation-spawned` / `-spawn-failed` /
  `-unrouted` / `-binding-orphaned` / `-closed`.

### 2.3 boter — wiki sidecar (pre-existing, design settled)
MediaWiki 1.42 + `@professional-wiki/mediawiki-mcp-server`, bootstrap via
password-state-file + envsubst. ACL design (not yet implemented):

- MediaWiki **categories cannot carry ACLs** (they're page tags). Use custom
  namespaces + core `$wgNamespaceProtection` — no extension needed:
  `NS_CASE` / `NS_DEBRIEF` / `NS_HANDBOOK`, plus locking `NS_MAIN` to the
  encyclopedist. Categories remain for discovery (`[[Category:Case Reports]]`).
- Per-role bot accounts via `createAndPromote.php --custom-groups=<role>` in
  `wiki-bootstrap/init.sh` (same pattern as the existing bot). Each recipe
  runs its own mediawiki-mcp-server instance with its own creds — enforcement
  is server-side; permission errors surface through tool results.

## 3. What we must change

| # | Repo | Change | Size |
|---|---|---|---|
| 1 | forking-knowledge-miner | Recipe surface: `conversations` block in the recipe schema → `FrameworkConfig.conversations`; map recipe strategy config to `strategyFactory` | S |
| 2 | boter | `LocalSettings.php`: NS_CASE/NS_DEBRIEF/NS_HANDBOOK + `$wgNamespaceProtection`; `wiki-bootstrap/init.sh`: sherlock/watson/lestrade bot accounts + groups | S–M |
| 3 | forking-knowledge-miner | Recipes: `sherlock.json` (trunk agent + `conversations` + Slack zulip_mcp + wiki MCP + data MCPs), `watson.json`, `lestrade.json` (fleet daemons, scheduled wake) | M |
| 4 | agent-framework | Trunk refresh on handbook change. **v1: not needed** — restart re-runs the trunk load turn, and new generations always copy the current trunk. v2: re-run the load turn on a Lestrade-edit signal | v2 |
| 5 | agent-framework | Binding persistence (Chronicle state slot). v1 accepts: restart drops bindings; fork contexts survive in Chronicle but the next mention starts a fresh generation rather than resuming | v2 |
| 6 | upstream | zulip_mcp PR #8 merge; membrane/zulip_mcp version bumps in the host | — |

Known v1 limitations (accepted, documented): in-memory bindings (#5); no
mid-engagement trunk refresh (#4); channel-granularity routing (Slack threads
within a channel share one fork).

## 4. Test plan

### Done (automated)
- **zulip_mcp** 35/35 (`node --import tsx --test`): Slack adapter event flow
  + mentioned true/false + self/bot filtering; attachment URL security
  (lookalike hosts, traversal incl. `%2e%2e`, userinfo-@ tricks); symlinked
  bin boot.
- **agent-framework** 154/154 (`node --test dist/test/*.test.js`):
  - 11 router unit tests: bind/trigger matrix, two-phase spawn, TTL with
    lastActivity refresh, generation increments, `isDmChannel`.
  - 6 routing integration tests (real framework + Chronicle + mock membrane):
    unknown-template rejection; DM spawn + trunk isolation + binding;
    channel no-mention drop / mention spawn; ambient non-trigger;
    template-context inheritance; TTL closure turn + g2 respawn.

### Planned (before calling the combine real)
1. **Live Slack smoke** (zulip_mcp `slack-integration` + framework `6de13eb`
   + a test workspace): DM binds+answers; channel mention binds; ambient
   channel chatter lands silently; second mention answers with ambient
   context visible; two channels concurrently (interleaved replies, no
   cross-talk); short-TTL closure posts a final message; next mention spawns
   g2 with a freshly edited trunk fact.
2. **Wiki ACL smoke** (boter, after change #2): mediawiki-mcp-server
   `create-page` with namespaced titles (`Case:Foo-2026-06-10`); sherlock
   creds **denied** on `Handbook:`/`Debrief:`/main, allowed on `Case:`;
   watson denied on `Case:`, allowed on `Debrief:`; lestrade allowed broadly.
3. **Queue-scan smoke**: seed a `Case:` page with no `Debrief:` counterpart →
   Watson wake finds it; seed an unincorporated `Debrief:` → Lestrade wake
   finds it and edits `Handbook:`.
4. **Full combine spike**: scripted scenario — user reports a bug in a
   channel, Sherlock investigates against a toy data source, posts answer +
   `Case:` report; Watson debriefs; Lestrade folds a lesson into the
   handbook; a *new* engagement demonstrably benefits (asks the
   handbook-suggested question first).

### Worth adding to automated suites
- Framework integration test: two channels interleaved (cross-talk guard at
  the test level, not just by construction).
- Framework integration test: `channel_publish` from a fork to a foreign
  channelId returns the locked-to-home error.

## 5. PR plan

1. **zulip_mcp PR #8** — open against antra-tess/zulip_mcp, stacked on #7.
   Two review rounds addressed (`56df964`: symlink guard, files.slack.com
   token lock; `81c9464`: Discord fetch SSRF allowlist, Slack history
   cursor pagination + read-cursor safety). 42/42 tests. Awaiting merge
   (diff shrinks to our commits once #7 lands).
2. **agent-framework PR #41** — `feature/conversation-routing` (single
   commit `6de13eb` on top of upstream main) →
   anima-research/agent-framework.
3. **forking-knowledge-miner** — recipe-surface PR (change #1) once written;
   recipes PR (change #3) after the wiki ACLs land.
4. **boter** — namespace-ACL PR (change #2).
