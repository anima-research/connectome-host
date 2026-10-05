# History — what we meant to build

The documents in this folder are records of intent: plans and designs written
before or while the thing was built. They are kept **verbatim** — moved here on
2026-09-30, not edited — because the reasoning in them is still the best
explanation of *why* parts of the system are shaped the way they are. They are
not descriptions of the current system, and relative links inside them point
at where files used to live.

For what the system is and does now, read [`../../README.md`](../../README.md),
[`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) and the guides indexed in
[`../README.md`](../README.md). For the change-by-change record in between,
read [`../../CHANGELOG.md`](../../CHANGELOG.md).

## The short version

The early documents describe **a terminal app for a knowledge-mining agent
that can fork itself** — a researcher that spawns subagents, keeps a lesson
library with confidence scores, and lets its operator undo turns. The fleet
plans extend that into three cooperating miners run from one terminal.

What the code does today is mostly something else: it is the body that
**long-lived residents** live in. The bulk of the work since these documents
went into keeping one agent continuous for months on Discord or Zulip —
autobiographical memory folded in the agent's own voice, prompt-cache
economics at 500k-token contexts, subscription quotas, operator surgery on a
live context, and bringing agents in from claude.ai, Claude Code and Codex.
The knowledge-mining recipes still ship and still run; they are now one use
among several, and several of the original goals (lessons, subagents,
retrieval) became opt-in modules rather than the point of the thing.

## The documents

### [`ARCHITECTURE.md`](./ARCHITECTURE.md) — the original architecture

Written in spring 2026, before headless mode or the WebUI existed, when the
host still lived in a `forking-knowledge-miner` checkout and built against
sibling `../agent-framework`, `../context-manager` and `../chronicle`
checkouts on agent-framework's `mcpl-first-class` branch. It frames the host
as "a general-purpose agent TUI host" and sets six goals and a five-item
roadmap.

What became of the goals:

| Goal | Outcome |
|---|---|
| Recipe-driven configuration | Shipped, and much larger: providers, ~45 memory-strategy keys, extensions, `${VAR}` substitution with unresolved persistence, conversations, subconscious, fleet, webui. MCP servers became *recipe opt-in* — `mcpl-servers.json` supplies commands and credentials, the recipe decides which servers load — the reverse of "the file wins". |
| Parallel exploration (subagents) | Shipped, then made opt-in (0.7.4). Grew a second, cross-process form: the fleet (headless children under a parent), rendered as one agent tree in the TUI and WebUI. |
| Semantic memory (lessons + retrieval) | Shipped, then demoted to opt-in (0.7.4). Lessons no longer inject anything; retrieval injects up to 5 lessons after the last user message, not into the system prompt. The agent's primary memory became context-manager's autobiographical compression, plus agent-framework's `HistoryModule` for raw lookup. |
| Reversibility | Shipped: `/undo`, `/redo`, checkpoints, `/branchto`. Agent-framework later added operator surgery (roll back to a message, suppress messages, quiesce), exposed in the WebUI. The host's `/undo` still uses its own branch stacks, so two undo mechanisms coexist. |
| Session management | Shipped; grew importers (claude.ai, Claude Code, Codex), import-source sidecars and warmup. |
| Dogfood the agent framework | Ongoing, and it worked: the gate, workspace, history, conversations, tune-out, code execution, `agent_settings`, ops alerts, provider holds, undo and surgery all moved upstream into agent-framework. |

What became of the roadmap:

1. **TUI refresh after branch operations** — shipped (`refreshFromStore()` in
   `src/tui.ts`). Rollbacks started from the WebUI still don't refresh an
   attached TUI.
2. **Hierarchical compression** — shipped in context-manager (L1→L2→L3 and
   beyond, self-voice summaries, source tracking), then superseded as the
   default by *adaptive resolution* with *kv-stable folding*: the context is
   fitted to a budget by folding the middle to whatever level each stretch
   needs, choosing folds that disturb the prompt cache as little as possible.
3. **Domain-specific strategies** — partly: the `frontdesk` strategy (for
   channel-staffing agents), agent-framework's `KnowledgeStrategy` for
   subagents, and an extension seam for deployment-specific strategies. No
   knowledge-extraction strategy was built.
4. **Undo at the framework level** — shipped in agent-framework
   (`undoLastTurn`, `rollbackToMessage`, `suppressMessages`, `quiesce`).
5. **MCPL integration depth** — shipped, mostly in the WebUI (live MCPL panel,
   inbound-trigger display) and as agent tools (`mcpl_list`, `mcpl_deploy`,
   `mcpl_restart`, `mcpl_unload`). The TUI still only edits the server file.

### [`HEADLESS-FLEET-PLAN.md`](./HEADLESS-FLEET-PLAN.md) — headless daemon & fleet

2026-04-21, @tengro and Claude. Goal: run the knowledge-mining triumvirate
(miner / reviewer / clerk) as one system from one terminal, with a conductor
agent supervising headless children over Unix sockets.

It shipped, and headless mode turned out to matter more than the fleet: it is
how every production resident runs, under systemd or launchd, usually with no
parent attached at all. The live protocol reference is now
[`../fleet-protocol.md`](../fleet-protocol.md). Where the code departs from
the plan:

- stdout is not the JSONL channel — stdout and stderr go to `headless.log`,
  and the socket is the only protocol channel.
- `lifecycle:ready` is sent on every connection, before the parent subscribes;
  `graceful: false` shuts down the same way as `true`, and neither waits for
  in-flight inference.
- `fleet--launch` takes no `env` and never prompts the user for an
  off-allowlist recipe — it returns an error. `fleet--relay` and
  `fleet--await` were added. The plan's allowlist example (`recipes/*.json`)
  is rejected by validation (only trailing `*` is allowed).
- The conductor gets no fleet-status context injection and is never woken by
  fleet events; it asks through tools.
- Reattach reads the fleet state persisted in the session, probes the pid and
  requires the child to report the same pid — it doesn't scan data dirs.
- The quit prompt is `[y/N/d]` and **defaults to cancel**; there is no
  `/quit --detach`. An orderly exit stops children unless detached.
- autoRestart shipped (1 s / 3 s / 10 s backoff, at most 3 per minute, only on
  non-zero exit), rather than being deferred.
- Tab toggles chat ↔ a single fleet tree instead of cycling four views.
- The "no web dashboard" scope line did not survive: the WebUI now shows the
  whole fleet and proxies every inspection panel to any child.

### [`UNIFIED-TREE-PLAN.md`](./UNIFIED-TREE-PLAN.md) — fleet children as subagents

Companion plan: collapse the in-process subagent tree and the flat fleet list
into one tree, via a reusable trace-event reducer and a `describe`/`snapshot`
resync verb. Its own "Implementation outcome" section records how it shipped.
Later drift:

- The conductor→child edge comes from `fleet--launch`, not `fleet--spawn`.
- Snapshots carry a flat node list with parent pointers, not a recursive tree.
- `inference:usage` *overwrites* the input-token count (it is a context size),
  rather than accumulating it.
- The reducer-required event set is derived from the reducer's handlers, not a
  hand-maintained constant, and the host also forces `usage:updated`.
- The reducer runs in the browser too: the WebUI builds the same tree.

### [`LOCUS-ROUTING-DESIGN.md`](./LOCUS-ROUTING-DESIGN.md) — where plain text goes

2026-05-29. Argued that "where does the agent's plain-text output go" is a host
concern, not an MCPL-server concern, because only the host sees every surface.
Implemented in agent-framework's `ChannelRegistry`, and then grew into the
recipe-selectable prose-routing modes (`locus`, `hybrid`, `explicit`,
`disabled`) and the `think` / same-round-think policy documented in the main
README.
