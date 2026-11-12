# Agent service home (opt-in, Zulip only)

This is a delivery mode of **NoticesModule**, not another incident service.
The host posts observations without an LLM turn, context marker, channel open,
locus change, or admission change. There is no dashboard polling, pin/edit
loop, chat control, pause, restart, rewind, new IPC, or operator authority in
notification data. A diagnostic is data, **not an instruction**.

Omitting `home` preserves legacy notices (including legacy tiers, replies and
unknown-kind behavior). `home` cannot be combined with legacy notices options:
it replaces those delivery routes, rather than inheriting their inbound-topic
or waker behavior. Nothing here enables a recipe or creates a live channel.

## Binding and trust: read before configuring a later pilot

Example **fragment**, not a deployment command or activation approval:

```json
{
  "modules": {
    "notices": {
      "home": {
        "connector": "zulip",
        "logicalAgent": "pilot-agent",
        "serverId": "operator-chat",
        "toolPrefix": "mcpl--operator-chat",
        "declaredRealm": "https://example.zulipchat.com",
        "stream": "agent-operations",
        "statusTopic": "pilot-agent status",
        "incidentsTopic": "pilot-agent incidents",
        "trustMode": "operator-attested-unverified",
        "selfEchoPreflight": "operator-attested"
      }
    }
  }
}
```

All fields are required. Realm is a canonical HTTPS origin (no slash/path,
userinfo, query or fragment). Stream is a **name**; both topics are explicit,
non-empty and distinct. Strings are bounded to 256 characters and cannot have
control characters. Routing is trusted operator configuration, never alert or
model output. Reuse the shape for other agents; do not copy an agent's journal.

`serverId` must already identify the intended registered, authenticated Zulip
connection, with exactly the declared prefix. The adapter checks connection,
tool ownership as reported by AF's dispatch resolver, and the explicit
`send_message`/inline-attachment schema on every attempted call. It sends
`type=stream`, `to=stream`, and the fixed topic through **ModuleContext.callTool**.
No `reply_to`, latest-inbound route, `channel_publish`, fallback server/topic,
credential-file read, new HTTP client, grant change, or LLM tool selection.
Missing capability refuses locally; it does not choose another destination.
The schema guard accepts the pinned public fork's explicit `string|null` fields
as well as string-only fields, but always supplies non-null stream/to/topic.
It validates supplied values against enum/const/length constraints and refuses
unsupported schema constraints rather than guessing a default or reply target.

**This trust mode does NOT independently verify the authenticated realm.**
AF 0.33.0's public server listing does not expose that realm. State, attachment
and status label it `verification=operator-attested/unverified`. The operator
attests the registered-server/declaredRealm association. An optional backend
`realm` value, if exposed, must match or the adapter refuses. Unchanged server
ID/prefix cannot detect changed credentials, endpoint or realm; a changed
declared destination refuses journal reuse. Stronger connector-attested realm
identity/an expected-realm guard is future work, not implemented here.

The self-echo attestation represents a **required deployment preflight**, not
runtime enforcement, a security boundary, or evidence supplied by these tests.
Before any later pilot, separately qualify the selected connector's own-send
filter (including startup/profile-read failure behavior). The inspected public
Zulip connector can have unknown self identity after a failed profile read.
Do not attest readiness without that qualification. The host escapes display
mentions/fences/control characters and `[[msg:...]]` macros (also inside code fences) and never routes notification text into its
own model context; it cannot promise a connector will not echo messages.

Private vs public stream, access, grants and subscriptions are operator
deployment policy. Provision/qualify them separately; this feature creates
none. A shared stream **may wake other agents** even though these sends do not
invoke this agent's model. Consider diagnostic confidentiality and destination
policy before a pilot. No live qualification/activation is part of this slice.

## What is actually observed

* Startup takes one public `healthSnapshot()` observation. Thereafter the host
  samples on observed `ops:alert`, this agent's inference started/aborted/failed/
  waiting/exhausted/completed/turn_ended, server-reconnected, module-added and
  module-removed traces. There is **no periodic timer**. It posts a status only
  when its bounded projection/active incident identities change (plus startup).
* The health projection is agent status, consecutive inference failures,
  refusal total, and scalar provider-admission counters/flags. Missing values
  stay null; missing agent/read failure is **unknown**, never recovery. No gate
  reasons, pending payloads or active stream bodies are copied. A snapshot is
  observation at the record's timestamp, **not a current/continuous health claim**.
  AF can emit traces before releasing provider admission; `idle` with
  `primaryActive:true` is recorded as null/`transition-unsettled`, not a claim
  that the idle agent is currently active. No periodic refresh is implied.
* Every `ops:alert` observed by this framework sink is forwarded, including
  framework/component/child subjects, unknown kinds (generic presentation), and
  `refusal`; there is no category/tier censorship in home mode. Kind-less alerts
  get `unknown-alert-kind`. Current-boot traces cached by AF are requested with
  `replay: true`; events not emitted, before the cache, or beyond its bounded
  early-trace retention are not reconstructed. There is no failures.log tailer.
* AF 0.33.0 logs **each individual refusal** to its existing failures.log, but
  emits a refusal `ops:alert` only at consecutive streak **>= 2**. This path does
  not publish an individual incident for a first refusal. A later sampled
  refusal-total change can be visible in status; absence of an alert does not
  mean no refusal occurred. Categories are not used to hide observed alerts.
* An explicit `*-clear` is a **source clear observation**, not a general healthy
  claim; correlation can be unknown. Only successful `inference:turn_ended`
  closes this agent's main-turn hard-down, context-refusal and refusal episodes.
  In AF 0.33, `inference:completed` precedes refusal reporting and has no stop
  reason: it clears **nothing** here. Natural completion without a later
  authoritative clear may therefore leave an episode unresolved.
  Main-turn success never clears auxiliary `refusal-offpath` or
  `context-maintenance-failed` (including agent-scoped background maintenance).
  These need their own source clear; this slice does not infer CM repair or
  fidelity from an ordinary reply. Unknown health alone never clears anything.
  A matching server-reconnected or `mcpl:<serverId>` module-added observation
  closes `mcpl-down`. Other kinds await their clear event; no cause/offending
  message is guessed from the last inbound item.

Records are an **allowlisted diagnostic projection, NOT a full trace**. Public
message/ref text is retained with the existing redaction and bounds. Structured
`ops:alert.data` retains these operational fields, regardless of alert category:
nonnegative safe-integer `count`, `mail`, `keptForRecovery`, `heldBySurgery`,
`passedOn`, `streak`; boolean `agentEnded`; redacted/bounded `category`, `scope`,
`pending`; up to 16 redacted kind-name/count entries in `kinds`; and known CM
`progress` counters (`totalChunks`, `chunksCompressed`, `l1QueueLength`,
`l1WaitingOnTools`, `mergeQueueLength`, `mergesWaitingOnTools`), boolean `pending`
and `summaryCounts.l1/l2/l3`. This preserves loss/mail state, refusal category
and streak, and maintenance scope/pending/progress without capturing arbitrary
nested payloads. Changed retained metadata is a changed diagnostic, not an
identical repeat.

AF's `boundFailureFields` bounds values and projects Errors but is **not a
secret-free guarantee**. No raw requests/responses/headers/env/private history,
conversation bodies, stacks, thinking or arbitrary nested Trace data is copied.
Unknown or invalid metadata fields are omitted; a count of omissions (not their
possibly sensitive names), truncation flag and redaction flag are explicit in
`metadata`. Text fields are capped at 512, kind names at 128, and projected
fields at 3,072 JSON characters (metadata <=4,096); excess fields are dropped
with an explicit truncated/omitted disposition, not secretly treated as full
fidelity. Original v1 records without metadata stay message-only; missing
metadata is not retrospectively reconstructed.

Recognizable secret/header assignments in allowed text are visibly redacted;
this is not a universal secret detector. Producers must keep raw bodies/secrets
out of public diagnostics. Diagnostics are capped at 8,192 input characters,
kind/subject/reference fields at 256 (kind/subject caps visibly marked); excess
is not captured. AF messages are already source-bounded to 2,000 characters.
There is no recovery of source-omitted/truncated text.

Display is fenced/escaped and visibly truncated at 1,200 characters. Each send
includes the **allowlisted pre-dispatch diagnostic projection as an inline JSON attachment**
using the connector's existing upload facility; it is not a delivery receipt.
The filename is the stable local record ID. No `file://` remote-access claim,
new webserver, or attachment-root/private-file access. Attachment upload can
have succeeded even if message acknowledgement is uncertain. The private
journal retains the record and final known outcome; no attachment cleanup or
external-effect rollback is attempted.

## Journal, uncertainty and bounded retention

Host-owned location: `$DATA_DIR/notice-home/<sha256(logicalAgent)>/journal.json`,
not the conversation/session checkpoint. Directory is 0700, files 0600. Refuse
non-private/non-regular/symlink leaf state, malformed/oversized journals and
binding/schema drift without replacing the existing journal. Fixed temporary
`journal.next` plus fsync/atomic rename/directory fsync serializes durable intent
**before** entering the delivery boundary, then outcome. File sync errors stop
delivery, not the agent core. Filesystem durability still depends on its fsync
contract; no cross-host fencing or exactly-once guarantee is claimed.

The immutable binding includes logical agent and destination. Each record has
its origin runtime instance (random per host process), local record and incident
ID, source trace type/timestamp/trace ID when available, observed time, count,
last-seen time and outcome. Source message/turn/checkpoint references remain
unknown; a local incident ID is not a provider's incident ID. A new instance
preserves old record identities and active incidents, and adds a startup
observation. **Single active host per logical-agent journal is a v1 assumption.**
Cloning state does not stop/fence the old host; do not run both copies.

* `sent`: positive, well-formed Zulip acknowledgement and message IDs: legacy
  positive safe integers or validated `<tag>:<positive-safe-integer>` strings
  from the fork's compat/strict receipt modes. Tags match the fork grammar
  `[a-z0-9][a-z0-9_-]{0,63}`; IDs remain opaque, unmodified and scoped by the
  bound `serverId`. A tag is **not proof of a realm URL**; there is no trusted
  tag/URL mapping here. Mixed namespaces, malformed IDs, success=false,
  missing ack or observable receipt routing/realm mismatch stay uncertain.
  New sent outcomes include `serverId`; old numeric receipts remain readable.
  Old uncertain receipts are never silently upgraded to sent.
* `not-dispatched`: definitive local preflight refusal, or conservatively local-only publication-related observation.
* `uncertain`: dispatch threw/timed out (5 seconds), returned failure/malformed
  acknowledgement, or restart found a pending intent. Timeout does not cancel a
  remote send; a late acknowledgement is not used to upgrade/replay it.

**No automatic resend/retry of a retained record**, even after reconnect/restart.
Uncertain/pending records are retained and never replayed; they do **not**
permanently disable unrelated new observations. A startup-connecting/schema
refusal is local to its record. New observations after connection/schema
recovery can deliver normally, without a reset command or evidence deletion.

Publication never emits a failure ops notice of its own. A private async context
marks causal descendants of its delivery call local-only, including synchronous
call-failure callbacks and late callbacks after timeout, and their derived
statuses. Independent observations arriving outside that context during a slow
successful send queue and deliver normally; being in flight is not itself a
reason to suppress them. After a failed attempt, the remaining derived status
of that same observation also stays local. There is no retry timer, no
delivery-failure alert worker and no recursive publication loop.

**Bounded async-context risk (not live-qualified):** AsyncLocalStorage also
propagates into long-lived timers/transports created inside delivery. Later
bound-server lifecycle events from those resources may remain marked
publication-related and local-only. Review probes demonstrated propagation in
Bun 1.4.4 / Node 22.23.3 and the synthetic module effect, **not AF MCP end-to-end**. Review found inference
queue events are not tainted by this mechanism; it is not a global inference
suppression claim. Real-connector preflight must check bound-server lifecycle
alerts/reconnects after delivery-triggered transport failure. No new AF API or
lifecycle-fencing guarantee is provided here.

Console diagnostics and read-only `homeState()` expose
storage/queue disablement. The original journal `deliveryHalted` flag is retained
as **historical evidence only**, not consulted as a future-message latch;
`homeState().legacyDeliveryHalted` exposes it separately. Actual corrupt journal,
binding drift, storage/queue/protected-backlog exhaustion still fail closed
without overwriting/deleting evidence or blocking core processing.

Identical diagnostic repetitions in an active episode coalesce into count /
lastSeen / first+last source reference in a retained record, **except a prior
`not-dispatched` record is not a coalescing anchor**. A fresh identical observation
with a new source identity after recovery can send once as a new record with
the same incident ID, preserving the original non-dispatch evidence. This is
not a retry of the old record: exact retained source-event replay still dedups,
and uncertain/pending records are not automatically resent (identical fresh
observations can still coalesce into an uncertain record). Coalescing into sent
records is unchanged; changed diagnostics get new records with the same
incident ID. Exact retained first/
last event identities are not resent across restart. Counts are observations,
not a complete per-event audit; without a distinct source trace identity,
same-timestamp identical events cannot be distinguished. Counts saturate at
the maximum safe integer. Attachments are immutable snapshots: later repeat
counts live in the private journal, not in an edited remote board.

Hard bounds: 128 retained records, 64 active incidents, 64 queued work items,
2 MiB per file (current + fixed temporary, at most 4 MiB total). When making room,
oldest terminal `sent`/`not-dispatched` records are evicted first, except the
newest incident record anchoring each active identity. Active identities and
that latest diagnostic/outcome survive; older terminal diagnostics in an active
episode can leave the window. `retention.evicted` is a saturating explicit count.
**Uncertain/pending records are never evicted**, even after an incident clears.
If protected evidence itself fills the bounded store, delivery stops visibly
and later observations are not retained; do not delete unknowns to provoke
replay. Byte and queue bounds can also stop retention/delivery.

Dedup is explicitly limited to retained first/last identities in this at-most
128-record window, not forever-history/exactly-once. Reobserving an old evicted
terminal event can produce a new notice. This small bounded retention permits
healthy long-running reconnect/refusal cycles without a lifetime stop, but is
not an audit platform. Existing AF logs have their own independent retention.

## Offline evidence and limits

`test/notice-home.test.ts` exercises the actual NoticesModule/adapter boundary,
synthetic private journals, fake MCP results and a real AF ModuleContext dispatch
to an offline fake API module. Model callbacks are forbidden; visible locus,
channel-open and admission hooks/state stay unchanged. Tests cover binding,
unknowns, source clear/recovery, formatting/full-record reference, dedup/restart,
durable ambiguity/no replay, known non-dispatch, drift, malformed answers,
per-record uncertainty, non-recursive publication, bounded compaction and protected-backlog caps. They do **not** prove a live connector's
authenticated realm, echo suppression, upload availability, destination access,
shared-stream wake policy, or crash/power-loss behavior of a production disk.
No other connector implementation is claimed.

Future owner-authenticated preemptive controls must be a separate authority
path, not interpreted from this data. Context rewind would not undo external
effects. This feature implements no control topic, buttons, pause/resume,
quiesce, suppression, rewind, history/store deletion, repair UI or self-restart.
