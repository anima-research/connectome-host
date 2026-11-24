# Agent service home (opt-in, Zulip only)

This is a delivery mode of **NoticesModule**, not another incident service.
The host posts observations without an LLM turn, context marker, channel open,
locus change, or admission change. There is no dashboard polling, pin/edit
loop, chat control, pause, restart, rewind, new IPC, or operator authority in
notification data.

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
Two connector versions are supported, both read from source: upstream
`anima-research/zulip_mcp` `main` at `bd500ba8` (string fields, numeric
message IDs) and the `theaspirational/zulip_mcp` fork at `61298a12`
(`string|null` fields, `<tag>:<n>` message IDs; the tagged IDs are open
upstream as anima-research/zulip_mcp#67). The host does not choose the
connector; the recipe does. The schema guard accepts the fork's explicit
`string|null` fields as well as string-only fields, but always supplies
non-null stream/to/topic.
It validates supplied values against enum/const/length constraints and refuses
unsupported schema constraints rather than guessing a default or reply target.

**This trust mode does NOT verify the authenticated realm before sending.**
AF 0.35.1's public server listing (`listMcplServers()`) does not expose that
realm. The display and attachment label it
`verification=operator-attested/unverified`. The operator attests the
registered-server/declaredRealm association. An optional backend `realm`
value, if exposed, must match or the adapter refuses. Unchanged server
ID/prefix cannot detect changed credentials, endpoint or realm before a send.
**The realm is checked after the fact:** the connector uploads the attachment
first and returns each upload's URL, built from its own configured realm. When
a receipt carries `attachments`, every URL's origin must equal `declaredRealm`;
otherwise the record is `uncertain`
(`receipt-attachment-outside-declared-realm`) and stderr says the message may
have gone to another realm. Stronger connector-attested realm identity before
dispatch is future work, not implemented here.

The self-echo attestation represents a **required deployment preflight**, not
runtime enforcement, a security boundary, or evidence supplied by these tests.
Before any later pilot, separately qualify the selected connector's own-send
filter (including startup/profile-read failure behavior). The inspected public
Zulip connector can have unknown self identity after a failed profile read.
Do not attest readiness without that qualification. Display content is built
from fixed labels and typed values and never routed into the host's own model
context; the host cannot promise a connector will not echo messages.

Private vs public stream, access, grants and subscriptions are operator
deployment policy. Provision/qualify them separately; this feature creates
none. A shared stream **may wake other agents** even though these sends do not
invoke this agent's model. Consider incident confidentiality and destination
policy before a pilot. No live qualification/activation is part of this slice.

## What is actually observed

* Status reports **tracked incidents only**: each active incident's ID, kind
  and subject, and a count of forgotten identities. It is a startup observation and a report on changes
  to local tracking, not a health snapshot. Routine turns do not post status;
  the sink does not read inference, refusal totals or provider admission state.
  Reconnect or registration of the bound server, or the first successful
  delivery of a previously unsent incident on a fresh repeat, can report a
  view that was not previously acknowledged. Identical acknowledged snapshots dedup; local
  refusal does not advance the baseline, and an uncertain status clears it, so
  the next status is sent even if it matches the last acknowledged one. The
  sink never polls.
* Every accepted `ops:alert` observed by this framework sink is considered, including
  framework/component/child subjects, unknown kinds (generic presentation), and
  `refusal`; there is no category/tier censorship in home mode. Coalescing,
  same-observation delivery failure, overload drops and storage disablement mean
  not every alert gets a remote post. Before calling the framework's stop,
  the host closes home admission and gives accepted work a chance to finish
  while the connector is still open. Agent-framework closes MCP connections
  in parallel with module stops.
  Sends share one five-second budget from the drain; an in-flight send keeps
  its existing deadline and later sends use only the time remaining. After
  expiry, work that would otherwise dispatch is recorded locally as
  `not-dispatched` if journal I/O completes, subject to the normal coalescing
  and retention bounds. The host waits at most six seconds for the pre-stop
  drain (the send budget plus one second for I/O), then logs a timeout and
  starts framework teardown if the drain is still pending. The timeout does
  not cancel a pending write or send; either may complete or be lost during
  teardown. If the pre-stop wait times out, MCP connectors close after about
  six seconds, but shutdown and session switch still wait for pending journal
  I/O inside `framework.stop()`. Unrecognized or missing kinds display as
  `unknown-alert-kind`. Current-boot traces cached by AF are requested with
  `replay: true`; events not emitted, before the cache, or beyond its bounded
  early-trace retention are not reconstructed. There is no failures.log tailer.
* AF 0.35.1 logs **each individual refusal** to its existing failures.log, but
  emits a refusal `ops:alert` only at consecutive streak **>= 2**. This path does
  not publish an individual incident for a first refusal; absence of an alert
  does not mean no refusal occurred. Categories are not used to hide observed
  alerts.
* An explicit `*-clear` is a **source clear observation**, not a general healthy
  claim; correlation can be unknown. A clear whose message starts
  `superseded by ` (as when `auth-expiring` becomes `auth-expired`) is only
  journaled as a `superseded` record: no post, no status, and the incident
  stays tracked. The named successor's alert, when processed, closes it and
  opens its own incident with one status; no recovery is posted. Until then
  the old incident stays tracked. The successor's ordinary clear closes it
  with a recovery post, whether or not the successor is tracked (a full queue
  can drop its alert); a further superseding clear of the successor hands it
  to the next successor.
  `inference:completed` and `inference:turn_ended` both close a matching
  subject's `hard-down`, `refusal-offpath` and `context-maintenance-failed`
  incidents, including for a child agent, as a successful turn closes those
  legacy episodes; AF emits no source clear for them. In AF 0.35.1
  `inference:completed` precedes refusal reporting and has no stop
  reason, so it does not clear refusal or context-refusal;
  `inference:turn_ended` can close those as well. When an agent ends
  (`dendrite:agent-ended`, as when a child is released), AF forgets its
  failure accounting and emits no clear, so the home closes that agent's
  tracked incidents itself, recording one `subject-ended` per incident (not
  a recovery claim) and checking for a status update if any close. Same-named
  `mcpl-down` incidents stay open. All framework-wide incidents also stay
  tracked when an agent ends; neither turns nor agent ends match their keys,
  even for an agent named `framework`. The home keys these apart from all
  agent subjects: `context-maintenance-failed` with
  `scope: 'pass'`, and `recovery-sync`, `deferred-import`, and `provider-wait`
  under `framework` (for `provider-wait`, only the unreadable wait store
  marker with `model: '*'` and `until: null`).
  A closing turn is not evidence of maintenance repair or fidelity.
  Absence of an incident does not prove health.
  A matching server-reconnected or `mcpl:<serverId>` module-added observation
  closes `mcpl-down`. AF 0.35.1 emits a source clear only for
  `context-refusal`; the host also emits clears for credential alerts,
  `instructions-unavailable`, and `compression-quarantine`.
  There is no built-in closer for `provider-wait`, `recovery-sync`,
  `deferred-import`, `store-held-long`, `store-held-lost`,
  `stream-cancel-failed`, `thinking-binding-loss`, `presentation-legacy`,
  `discord-awareness-unresolved`, or `context-reinit-failed`. Unknown kinds
  have no guaranteed clear either. Without a matching explicit clear or
  subject end, these stay tracked until eviction, restart, or session switch,
  even when the alert reports a one-off event. No cause or offending message
  is guessed from the last inbound item.

The journal, Zulip display and inline JSON attachment contain **no diagnostic
free text**. They carry fixed labels (including a fixed set of alert kinds),
times, IDs, counts and delivery state, plus each incident's **subject** label.
The host agent's configured name and known MCP server IDs can appear
verbatim. Known IDs are not necessarily operator-chosen: an agent-deployed
server ID persisted in the runtime MCP overlay can appear as a subject label
after restart. Framework-wide incidents and incidents for an ordinary subject
named `framework` (including a child agent) both display as
`subject=framework`, but their incident keys are distinct. A missing subject
displays as `none`;
other names display as `unlisted-` and the first 12 hex digits of the incident
key (the journal's `incidentKey`), so the post can be matched to the journal.
Each incident post shows
`<phase>: <kind>; subject=<subject>`, and status lists every tracked incident
as `<id> <kind> subject=<subject>`. Trace IDs, messages and structured alert
data are not copied. Diagnostics remain in the existing local
producer logs; this mode does not forward diagnostic text. The binding
fingerprint does not store literal routing values, but the bound server ID
can also appear as a subject label. The journal stores validated receipt IDs
verbatim, so a connector-chosen tag can also match a routing value.

The attachment is the pre-dispatch record, not a delivery receipt. Its filename
is the local record ID, and upload uses the connector's existing facility. No
`file://` remote-access claim, new webserver or attachment-root/private-file
access. Upload can succeed even when delivery is uncertain. The host journal
records the final known outcome; no attachment cleanup or remote rollback is
attempted.

## Journal, uncertainty and bounded retention

Host-owned location: `$DATA_DIR/notice-home/<sha256(logicalAgent)>/journal.json`,
not the conversation/session checkpoint. Directory is 0700, files 0600.
The host starts a fresh journal on host startup and session switch; see
**Restart and session switch**. Fixed temporary
`journal.next` plus fsync/atomic rename/directory fsync serializes durable intent
**before** entering the delivery boundary, then outcome. File sync errors stop
delivery, not the agent core. Filesystem durability still depends on its fsync
contract; no cross-host fencing or exactly-once guarantee is claimed. The
recursive parent-directory creation is not power-loss qualified: provision the
private directory durably before activation. A missing journal is treated as
first run, not as proof that no remote messages exist.

A binding fingerprint ties the file to the configured logical agent and
destination without carrying their literal strings. The record contains
generated record/incident IDs, a runtime instance fingerprint, event and
incident keys, fixed source type, times, count and outcome. The event key
uses the source time and trace ID for replay detection without retaining the
raw trace ID. Source message/turn/checkpoint references remain unknown; a
local incident ID is not a provider's incident ID.
**Single active host per logical-agent journal is a v1 assumption.**
Cloning state does not stop/fence the old host; do not run both copies.
The journal resides in the host data tree: update rollback/backup restoration
can restore stale delivery evidence while remote Zulip posts remain. Preserve
the latest journal independently before restoring data; this slice provides
no cross-rollback deduplication guarantee.

* `sent`: positive, well-formed Zulip acknowledgement and message IDs: legacy
  positive safe integers or validated `<tag>:<positive-safe-integer>` strings
  from the fork's compat/strict receipt modes. Tags match the fork grammar
  `[a-z0-9][a-z0-9_-]{0,63}`; IDs remain opaque, unmodified and scoped by the
  bound `serverId`. A tag is **not proof of a realm URL**; there is no trusted
  tag/URL mapping here. Mixed namespaces, malformed IDs, success=false,
  missing ack or observable receipt routing/realm mismatch stay uncertain.
  The journal's binding fingerprint scopes numeric and branded receipts to
  the configured server; the outcome has no separate server-name field.
  Old uncertain receipts are never silently upgraded to sent.
* `not-dispatched`: definitive local preflight refusal, an earlier failed
  delivery for the same observation, a send skipped because the shared
  shutdown budget expired before dispatch, or a `superseded` record, which is
  never posted (`superseded-not-posted`).
* `uncertain`: dispatch threw/timed out (5 seconds), returned failure/malformed
  acknowledgement. Timeout does not cancel a remote send; a late
  acknowledgement is not used to upgrade or replay it.

**No automatic resend or retry.** While running, uncertain records stay within
the finite retention window and do **not** permanently disable unrelated new
observations. A restart or session switch never replays records from the old journal. A refusal
because the server is still connecting or has an incompatible schema is local
to its record. New observations after connection/schema
recovery can deliver normally, without a reset command or evidence deletion.

Publication never emits a failure ops notice of its own. An unsuccessful
delivery keeps the remaining publications for that same observation (such as
its derived status) local. The host does not use async ancestry to suppress
new traces: observations from connector timers or transports created during
a send can still publish, including later independent outages and reconnects.
There is no retry timer or delivery-failure alert worker.

**Possible connector echo:** If the connector or framework emits a trace
because of a home send (including after timeout), that observation can publish
an incident or status of its own. Matching repeats are subject to normal
coalescing and dedup, but those rules do not prove or filter causation.
Qualify transport-failure alerts and reconnect behavior in preflight. This
is separate from inbound Zulip message self-echo.

Console diagnostics report storage disablement and overload drops. The
cumulative runtime `dropped` count is only held by `NoticesModule.homeState()`,
a module method; this host has no CLI, UI or API route to it (see Known limits).
Shutdown non-dispatch is journaled, not counted as an overload drop. None of
these block core processing.

### Restart and session switch

On host startup and when a session switch recreates the framework, the host
renames the existing `journal.json` and `journal.next` entries to distinct
`journal.archived-<time>-<id>.json` names in the journal directory. This does
not read journal contents, unlink old entries or replace an existing archive.
Symlinks, including dangling ones, are archived as links with their original
bytes. Their targets are never followed or moved by virtue of being targets;
the two fixed entries are handled independently. If a rename or its sync
fails, no fresh journal is started and home delivery is disabled for that run.
Check both the original locations and any completed moves before retrying.

**Incident IDs start fresh after a restart or session switch.** An incident
still active may be reported again as new, and a later clear may not match
its earlier incident. Earlier delivery evidence and dedup history are not
used or replayed. Inspect the archives if needed and manage their retention
separately.

**A timed-out pre-stop drain does not let a session switch skip journal I/O.**
The host waits for `framework.stop()` to finish the old home's pending save
before starting the new home, so that save cannot race the new home's move-aside.

Disablement logs include the cause and the journal path on stderr.
Missing/ambiguous bound server IDs name registered candidates and
point to recipe and runtime-overlay configuration, unlike a disconnected
known server. The home does not emit ops alerts for its own delivery failures;
operators must monitor console logs.

Fresh repeats in an active episode coalesce into count, last-seen time and
first/last event identity. Prose changes do not start a new record. A prior
`not-dispatched` record is not a coalescing anchor: a fresh observation after
recovery can send as a new record with the same incident ID. Exact retained
event replay still dedups, and repeats may coalesce into an uncertain record,
which is never retried. Counts are observations, not a complete per-event
audit; two events with the same timestamp and no trace ID cannot be told apart
within one incident. If neither source time nor trace ID is present, a random
event key prevents fresh observations from colliding; such events cannot dedup
on replay. Counts saturate at the maximum safe integer. Attachments are immutable
snapshots: later repeat counts live in the journal, not in the remote post.

Hard bounds: 128 retained records, 64 tracked active incidents, 64 queued work
items, 2 MiB per active or staging file (at most 4 MiB excluding archives). Queue
saturation drops **only newly arriving excess observations**, logs once per
saturation burst and increments the module's `dropped` count. While running, work
continues and acceptance resumes as soon as a slot opens. This also applies
to startup replay; there is no unbounded replay buffer or backpressure on the
framework/core.

This is a **finite observation window, not an audit log**. When making room,
the least recently observed records leave regardless of outcome, including
uncertain records; the most recently observed incident record anchoring each
tracked identity and the current publication are protected. A coalesced repeat
refreshes its record's position. Record and incident counts do not guarantee
that the encoded journal fits below the 2 MiB byte cap: status snapshots
repeat subject labels, so long labels can put a save over the cap and
disable home delivery for the run.
`retention.evicted` counts removed records. When a 65th unresolved identity
arrives, the oldest tracked identity is forgotten, **not recovered**;
`retention.forgottenActive` counts this loss of tracking and is included in
status. The original record remains until normal record eviction. A late clear
of a forgotten incident has unknown correlation. No time-based recovery is
inferred, no old record is resent, and unknown delivery evidence does not
create a lifetime halt. Export evidence elsewhere if indefinite retention is
required; there is no reconciliation or archive cleanup worker in this slice.

Dedup is explicitly limited to retained first/last identities in this at-most
128-record window, not forever-history/exactly-once. Exact source kind and
subject are hashed together for correlation, so distinct unknown kinds can
share a display label without merging their episodes. Digests are identifiers,
not anonymity guarantees. Reobserving an old evicted
event (including one with an unknown delivery outcome) can produce a new notice. This small bounded retention permits
healthy long-running reconnect/refusal cycles without a lifetime stop, but is
not an audit platform. Existing AF logs have their own independent retention.

## Offline evidence and limits

`test/notice-home.test.ts` exercises the actual NoticesModule/adapter boundary,
synthetic private journals, fake MCP results and a real AF ModuleContext dispatch
to an offline fake API module. Model callbacks are forbidden; visible locus,
channel-open and admission hooks/state stay unchanged. Tests cover binding,
unknowns, source clear/recovery, a free-text canary in all three sinks, in-run
dedup, preservation and reset on restart and session switch, durable ambiguity/no replay, known
non-dispatch, drift, malformed answers,
per-record uncertainty, connector echoes and independent lifecycle events,
bounded rolling compaction, overload and child recovery, quiet routine turns,
bounded stop, and a real `framework.stop()` through the host's stop path with
one send in flight and one queued, against a stdio test server. They do **not** prove a live connector's
authenticated realm, echo suppression, upload availability, destination access,
shared-stream wake policy, or crash/power-loss behavior of a production disk.
No other connector implementation is claimed.

### Known limits

* **macOS service shutdown can be cut short.** A slow Zulip send can use the
  drain's entire five-second send budget, exhausting launchd's five-second
  exit window on macOS 26 (see [Deployments](DEPLOYMENTS.md)). Launchd can
  send SIGKILL before framework teardown begins.
* **Agent-end tracking is name-based.** An alert arriving after an agent
  ends can stay tracked. A child ending can close an unknown-kind server
  incident with the same name, even though `mcpl-down` incidents are exempt
  from this name match.
* **Repeated status sends when the connector reconnects on every send.** An
  uncertain status clears the dedup baseline, and a reconnect or registration
  of the bound server triggers a status check. If the connector reconnects
  while handling each home send, and every send ends uncertain (timeout or no
  valid acknowledgement), each reconnect sends another status, which can cause
  another reconnect. There is no retry limit, and the next send does not wait
  for a separate observation. The operator sees repeated status posts or
  attempts in the status topic. Stderr shows a
  `[notices:home] record <id>: uncertain; detail=...` line for each send, and
  the journal's `retention.evicted` count rises as older records leave the
  128-record window. The loop ends when a status is acknowledged (the next
  identical view is then deduplicated), when the connector stops
  reconnecting, or when the host stops. Stop the host or fix the connector.
* **No operator route to `homeState()`.** The cumulative overload `dropped`
  count and disablement state are only readable through the module method
  `NoticesModule.homeState()`; the host exposes it through no CLI, UI or API.
  Operators see overload and disablement through console logs only.
* **Refusal and context-refusal are not closed by `inference:completed`
  alone.** After a subject's `refusal` or `context-refusal` incident, a later
  successful turn that emits `inference:completed` but no
  `inference:turn_ended` for that agent leaves the incident active. Legacy
  notices close those episodes on that completion. The operator sees the
  incident ID stay in later status posts under `Tracked incidents`, with no
  `recovery-observed` post. It stays until a matching `inference:turn_ended`
  or explicit clear, eviction from the 64 tracked incidents (counted as
  forgotten), or a host restart or session switch.

Future owner-authenticated preemptive controls must be a separate authority
path, not interpreted from this data. Context rewind would not undo external
effects. This feature implements no control topic, buttons, pause/resume,
quiesce, suppression, rewind, history/store deletion, repair UI or self-restart.
