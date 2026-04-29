# Unified Tree Plan: Fleet Children as Subagents in the TUI

Goal: collapse the two-paradigm UI (`SubagentModule`'s in-process tree vs. `FleetModule`'s flat child list) into a single tree-rendering paradigm where fleet children appear and behave like subagents — same readouts (context tokens, phase, tool-call count), same unfold-children affordance, same row component.

Companion to [HEADLESS-FLEET-PLAN.md](./HEADLESS-FLEET-PLAN.md), which defines the underlying IPC.

## Design summary

- **Event stream is the primary path.** Children already pipe `framework.onTrace()` over the IPC socket verbatim (`headless.ts:141`). The same fold logic that builds the in-process subagent tree from those events can build a tree per fleet child; just run the reducer N+1 times (once on local traces, once per child via `onChildEvent`).
- **One reducer, three call sites.** The reducer extracted in Phase 2 runs on (a) parent's local trace stream, (b) parent's per-fleet-child stream, and (c) *inside each headless child* to support `describe`. Same code everywhere; `describe` is just `serialize(reducer.getTree())`.
- **`describe` is a recovery verb, not a query verb.** Modeled on lockstep game engines' state-dump: requested rarely, at known sync points (TUI cold start, reconnect, after child restart), to seed/reseed the per-child reducer with ground truth. Then the live event stream takes over.
- **No subfleets.** Depth-1 invariant enforced at startup. Eliminates the "grandchild events are invisible to grandparent" problem entirely. If subfleets ever become necessary, the wire protocol additions here are forward-compatible with a future `via:` re-broadcast scheme.

## Why this works (and why it didn't before)

Today's fleet IPC is structurally fine but data-thin:
- Pure event stream, fire-and-forget commands, no request/response.
- `fleet-module.ts` keeps a 500-event rolling buffer per child but does almost no folding (just `lastEventAt` and `lastCompletedSpeech`).
- Every consumer (TUI, conductor) currently has to fold events itself if it wants counts or phase.
- This is why the fleet UI shows status only and requires `/usage` to see context size — nobody has done the fold yet.

The in-process subagent path *has* done that fold (in `subagent-module.ts:262-340` and scattered across `tui.ts:174-175, 1019-1037, 1280-1341`). Extracting that fold into a reusable reducer and running it against fleet child event streams is the unification.

## Phase 0 — De-risk the unknowns ✓ COMPLETE

Two investigations completed before committing to the plan:

**0a — agentName uniqueness audit (`tui.ts` and consumers)**: VERDICT GREEN. Namespacing is mechanical: ~50-60 touch sites, no hidden invariant violations forcing redesign. Three findings folded into Phase 4 below:
- Centralize scope derivation at event ingest (`tui.ts:970-971`, `subagent-module.ts:264-267`), not scattered through map ops.
- ~8-10 sites compare `if (agent === rootAgentName)` to detect researcher events. Replace with `isLocalRoot(agent)` helper, not direct string compare.
- Fleet child IDs are already user-chosen and unique by design; collisions only happen between in-process subagent names across processes. Less work than initially flagged.
- The `subagent--spawn` tool-call detection at `tui.ts:1101-1106` already builds `agentParent` from tool call traces. The same pattern extends to `fleet--spawn` for conductor → fleet-child edges. No new mechanism.

**0b — Snapshot data sources audit (`SubagentModule.peek()` vs. framework state)**: VERDICT REVISES PHASE 1. `peek()` is the wrong source — it's optimized for live-streaming UI, missing cumulative tokens / phase / `lastEventAt` / `completedAt`. Top-level framework agents aren't in SubagentModule at all. Tokens and phase are event-derived; they live nowhere as durable state. Findings folded into Phase 1 + Phase 2 below:
- The Phase 2 reducer **is** the snapshot source. Run it inside the child too; `describe` calls `reducer.getTree()`.
- Phase 1 is now structurally trivial *after* Phase 2; Phase 2 becomes a hard prerequisite.
- No upstream changes to framework or SubagentModule. `framework.onTrace()` + `framework.getAllAgents()` + read access to `SubagentModule.activeSubagents` for metadata enrichment is enough.
- `peek()` stays as-is, used by the streaming peek window — it's a separate concern.

## Phase 1 — Wire-protocol additions

Files: `src/modules/fleet-types.ts`, `src/headless.ts`

Depends on: Phase 2 (reducer must exist before `describe` handler can call it).

Add one new `IncomingCommand` variant and one new event type:

```typescript
// IncomingCommand
| { type: 'describe'; corrId?: string }

// New child→parent event: a serialized AgentTreeReducer.getTree() output
{
  type: 'snapshot';
  corrId?: string;
  asOfTs: number;
  child: {
    name: string;
    status: 'ready' | 'idle' | 'exiting';
    pid: number;
    recipe?: string;
    startedAt: number;
  };
  tree: AgentTreeNode;  // root + children, recursively, same shape as Phase 2 reducer output
}
```

`headless.ts` adds:
- A long-lived `AgentTreeReducer` instance subscribed to `app.framework.onTrace()` from process startup, accumulating state for the lifetime of the child. Initialized with the framework's existing agents from `framework.getAllAgents()`.
- Read access to `SubagentModule.activeSubagents` (if mounted) for metadata enrichment (`type`, `task`, `parent`, `findingsCount`) at snapshot time.
- A `describe` arm in `dispatchCommand`: assembles `{type:'snapshot', child:{...}, tree: reducer.getTree(), asOfTs: Date.now()}` and `emit()`s it.
- Subscription filter must always allow `snapshot` through (it's a response, not telemetry — exempt from `subscribe` filtering).

**Acceptance**: integration test in `connectome-host/test/fleet/` — open socket, send `describe`, receive a well-formed snapshot whose tree matches what an independent reducer fold of the same trace stream produces.

## Phase 2 — Extract the agent-tree reducer

New file: `src/state/agent-tree-reducer.ts`

This is the keystone phase: extracting the fold logic that's currently smeared across `subagent-module.ts:262-340` and `tui.ts:174-175, 1019-1037, 1280-1341` into a single reusable module.

```typescript
class AgentTreeReducer {
  applyEvent(e: TraceEvent | WireEvent): void
  applySnapshot(s: SnapshotEvent): void   // resets state, then stream resumes
  reset(): void                            // for child restart / disconnect
  getTree(): AgentTreeNode                 // root with recursive children
  getNode(name: string): AgentTreeNode | undefined
}
```

The reducer must handle the canonical phase-transition mapping (mirror `tui.ts:1280-1341`):

| Event | Action |
|---|---|
| `inference:started` | phase ← 'sending', lastEventAt ← ts |
| `inference:tokens` | phase ← 'streaming', lastEventAt ← ts |
| `inference:tool_calls_yielded` | phase ← 'invoking' |
| `inference:usage` | **accumulate** contextTokens (NOT overwrite — current SubagentModule.lastInputTokens is broken in this respect) |
| `inference:completed` | phase ← 'done', completedAt ← ts, absorb final token counts |
| `inference:failed` | phase ← 'failed', completedAt ← ts |
| `tool:started` | phase ← 'executing', toolCallsCount++ |
| `tool:completed` | (durations / output handling) |
| `subagent--spawn` tool call observed | parent edge: parentMap.set(child, agent) |
| `fleet--spawn` tool call observed | parent edge for fleet child node |

Initial population:
- Top-level framework agents come from `framework.getAllAgents()`, registered as root nodes (parent=null, type='framework').
- Subagents discovered via `subagent--spawn` / `subagent--fork` tool-call observations OR seeded from `SubagentModule.activeSubagents` if available at construction time.

Strategy: **dual-path validation**. Initially leave `subagent-module` and `tui.ts` logic intact; *also* construct an `AgentTreeReducer` from the same event stream. Diff the two trees in a test harness over a recorded trace stream. Once they match on all displayed fields, switch the TUI over and remove the duplicated logic.

**Acceptance**: in single-process mode, `AgentTreeReducer.getTree()` matches the existing rendering byte-for-byte on context tokens, phase, tool count, parent edges across a representative session (recorded trace stream replayed).

## Phase 3 — Per-child reducers wired through fleet-module

Files: `src/modules/fleet-module.ts`, `src/tui.ts`

Depends on: Phase 1 + Phase 2.

Instantiate one `AgentTreeReducer` per fleet child via `fleetModule.onChildEvent(childName, ...)`, plus one for local via `framework.onTrace()`. Trigger `describe` at sync points:

- TUI cold start, after fleet children reconnect or are reattached.
- `lifecycle:ready` arrives for a child whose reducer is empty (covers initial attach and parent-side reconnect; child-side reconnect already re-emits `ready`).
- `process:exited` (via fleet-module) → `reducer.reset()` for that child; next `lifecycle:ready` triggers fresh `describe`.

On `describe` response, `applySnapshot()` blows away local state and resumes folding. Events that arrived during the request window are discarded if their `ts < snapshot.asOfTs` (cheap dedupe).

**Acceptance**: `kill -9` a fleet child, watch the parent's reducer clear and rebuild on restart with no ghost agents from the previous incarnation.

## Phase 4 — Namespace agent keys

Depends on: Phase 2 (the reducer is the natural place to apply scope).

Per Phase 0a findings, this is mechanical but requires diligence at three zones:

**Zone 1 — Map keys** (~12 declarations + ~40-50 set/get sites): replace `Map<string, X>` with `Map<string, X>` keyed on `${scope}/${agentName}` (or tuple key if preferred). Targets enumerated in 0a report: `subagentPhase`, `agentParent`, `agentContextTokens`, `summaryCache`, `peekLogs`, `peekCurrentTool`, `procPeekLogs`, `procPeekTokenLine`, `peekTokenLine`, `activeSubagents`, `parentMap`.

**Zone 2 — Event-ingest scope derivation** (`tui.ts:970-971`, `subagent-module.ts:264-267`): centralize at the listener. One function `scopeOf(event) → scope` applied before any map ops, so the rest of the code reads scoped names.

**Zone 3 — Root-agent comparisons** (~8-10 sites at `tui.ts:975, 1040, 1069, 1110, 1129, 1153, 1187, 1557, 1562`): replace `if (agent === rootAgentName)` with `isLocalRoot(agent)` helper. Don't string-compare directly.

The conductor → fleet-child edge: the reducer's existing `subagent--spawn` tool-call detection extends naturally to `fleet--spawn` (same `tool:started` event shape, different tool name). No new mechanism.

**Acceptance**: a session where parent's `commander` and a fleet child's `commander` coexist renders both correctly, no collisions, no swapped readouts.

## Phase 5 — TUI rendering: N trees in one tab

File: `src/tui.ts`

Depends on: Phase 3 + Phase 4.

Replace the single subagent tree with one local tree + one tree per fleet child. The fleet-child node renders as a header row (name + recipe + lifecycle status) with its agents/subagents indented beneath using the same row component already used by in-process subagents.

The `[tab]` window's existing unfold mechanism is reused. No new key bindings needed.

**Acceptance**: tabbing through the subagent window shows context tokens, phase, tool calls for every node — local and fleet alike — without invoking `/usage`. Unfolding a fleet child reveals its agents and subagents.

## Phase 6 — No-subfleets invariant

File: `src/modules/fleet-module.ts` (start path)

Independent — can land any time after Phase 0.

Reject any recipe loaded into `FleetModule.spawn()` that itself declares a `fleet` module. Single check, comprehensible error message:

```
fleet child recipe '<name>' declares its own 'fleet' module;
nested fleets are not supported (see UNIFIED-TREE-PLAN.md §6)
```

Document the invariant in HEADLESS-FLEET-PLAN.md.

**Acceptance**: a recipe with a `fleet` module inside fails at spawn time, before any child process starts, with the error above.

## Ordering & parallelism

```
Phase 0 ✓ DONE
   ↓
Phase 2 (extract reducer) ──→ Phase 1 (wire protocol; needs reducer for describe handler)
   │                                   │
   └→ Phase 4 (namespace) ─────────────┤
                                       ↓
                                Phase 3 (per-child wiring)
                                       ↓
                                Phase 5 (rendering)

Phase 6 (invariant) — independent, land any time
```

Phase 2 is now the keystone. Phase 1 simplifies dramatically once Phase 2 exists (`describe` handler is one line: `emit(reducer.getTree())`). Phases 1 and 4 can be done in parallel after Phase 2. Phase 3 needs both. Phase 5 needs 3.

## Implementation outcome (all phases shipped)

**Phase 0** — investigations completed, plan adjusted (`peek()` ruled out as snapshot source; reducer became the keystone; namespacing confirmed mechanical).

**Phase 1** — `describe` IncomingCommand + `snapshot` WireEvent in `fleet-types.ts`; `headless.ts` runs a long-lived reducer subscribed to `framework.onTrace` from startup, seeded with `framework.getAllAgents()`; `describe` handler emits the reducer's snapshot exempt from subscription filtering.

**Phase 2** — `src/state/agent-tree-reducer.ts` with the full canonical fold (phase transitions, token semantics, parent-edge inference for `subagent--spawn`/`fork` and `fleet--launch`, callId routing for tool events, snapshot apply with deep-copy safety, lazy node creation).

**Phase 3** — `src/state/fleet-tree-aggregator.ts` owns one reducer per fleet child + one local; orchestrates `describe` at sync points (registration, `lifecycle:ready`); drops events with `ts < lastSnapshotTs`; clean read API for the TUI.

**Phase 4** — pragmatically reduced. The aggregator's per-child reducers are *already namespaced* by construction (one reducer per scope), so the local TUI maps stayed as-is. Only the `FleetNode` shape grew a `kind` discriminator (`researcher` | `subagent` | `fleet-child` | `fleet-child-agent`), and `renderNode` switches data sources by kind. No rewrites to the existing 50-60 sites; the namespacing happened at the *data source*, not at the rendering call sites.

**Phase 5** — `buildFleetTree()` appends fleet-child header nodes as additional descendants of the researcher root, each carrying a subtree built from the aggregator's per-child nodes. Auto-expanded on first display. Same `renderNode` handles all four node kinds. Peek/stop key bindings dispatch by node-id prefix (`proc:NAME` for headers, `NAME:agent` for agents-inside-children). The `processes` view is preserved as an alternate raw-status view; the unified tree lives in `fleet`.

**Phase 6** — `FleetModule.handleLaunch` rejects nested-fleet recipes before subprocess spawn, narrowly (only on confirmed-loaded recipes that declare a `fleet` module), with a clear error message pointing to this plan. Documented in HEADLESS-FLEET-PLAN.md decision §13.

**Test coverage**: 38 new tests across reducer, aggregator, describe IPC, fleet-launch edge inference, no-subfleets invariant, and an e2e integration that wires real spawn → real IPC → reducer-populated tree. Full suite: 157 pass / 0 fail.

**Out of scope (left as designed)**: subfleets, snapshot delta-events, cross-child unified timeline, snapshot checksums. Late-attach replay gap accepted.

## Out of scope (deliberately)

- **Subfleets.** Phase 6 forbids them. The wire protocol stays compatible with a future `via:` re-broadcast scheme if the requirement ever appears.
- **Delta events on top of `describe`.** The lockstep analogy says snapshot-on-recovery is sufficient; revisit only if late-attach drift turns up in practice.
- **Cross-child unified timeline view.** Each tree is per-process; no merging across processes.
- **Snapshot checksums / desync detection.** Add only if reducer drift is observed.
- **Extending `SubagentModule.peek()`.** Per 0b, peek stays optimized for the live streaming peek window. The reducer is the snapshot source.
- **Per-agent token tracking inside the framework.** Per 0b, no upstream changes to `agent-framework`. The reducer accumulates from trace events.

## Risks the plan does NOT address

- **Late-attach replay gap** between child startup and TUI attach is partially papered over by `describe`-on-attach, but events that fired before the parent existed at all (e.g. child started by a previous TUI session) are gone from the framework's perspective; only the snapshot's current state is recoverable. This is the same property single-process traces have and is accepted.
- **Clock skew across children.** Each child stamps `ts` with its own `Date.now()`. Per-tree rendering doesn't care; only matters if a future cross-child timeline view is built (out of scope here).
- **TUI subscription density at scale.** Default `['*']` subscription means every child fires every trace event. Fine for current recipes (≤ ~5 children); could need narrowing if fleets grow much larger. Not addressed here.
- **`findingsCount` for framework agents.** Currently only tracked per-subagent in `ActiveSubagent`. Top-level framework agents will report 0 / undefined. If this ever matters, extend the reducer to count "findings-shaped" tool calls; not addressed here.
