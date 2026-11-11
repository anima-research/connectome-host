# Local selected L1 quarantine waiver (unreleased companion)

This is **not a release-ready dependency alignment**. The host's checked-in
locks select AF 0.33.0 / CM 0.25.3 / Membrane 0.8.1 / Chronicle 0.6.0.
That CM has the public manager accessor but **not** this optional keyed
capability. It refuses rather than falling back to legacy clear-all. A real
new CM release containing the reviewed API and coordinated AF/host dependency
floors are required; no release numbers are assigned here. Typechecking this
companion needs that new public CM API; the current stock lock is not a claimed
feature build. Local candidate testing is not a stock-package qualification.

## Surface and consent limits

Only an **already running headless host's separate local UNIX control socket**
at `DATA_DIR/q/s` accepts `quarantine-inspect`, `quarantine-release`,
`quarantine-result`. These verbs are **not** interactive/fleet commands on
`ipc.sock`. The install's `connectome quarantine` command opens only the control
socket, using the existing install record and JSON-lines client framing. It
never falls back to `ipc.sock`, starts a host, or subscribes to agent events.
There is no Web UI/HTTP mutation, slash/chat command, MCP/model tool or generic
method dispatcher, and no second native store writer.

The control channel sends a channel-ready handshake and **only the requesting
socket's correlated responses**. A nonempty string `corrId` is required (max 200
characters); input lines are limited to 64 KiB. It accepts one pending command
per connection; another returns `busy`. It has no foreground trace/boot replay,
subscriptions or text handling. Inspect, result and even a pending release do
not become `currentClient`, close a controller, reset subscription/text state,
or move notifications. Legitimate regular successors/reconnects still take
over the regular controller exactly as before, without stealing or aborting
operator replies. Requester loss drops only its reply, not admitted native work;
shutdown closes control connections and invalidates snapshots without promising
to finish a pending acknowledgement. Receipts retain the uncertainty rules below.

Channel setup requires Linux `/proc`, a host-owned non-group/other-writable data
directory and a private, no-follow `q` directory (0700). A short endpoint path is
used; paths over 103 UTF-8 bytes explicitly disable the channel. The endpoint
always follows `DATA_DIR`, even if `--socket-path` overrides interactive IPC.
Failure, an unsupported platform, insecure directory or an unknown endpoint
**disables only this optional channel**, logs why and leaves interactive startup
unchanged. It never chmods/repairs existing paths or unlinks an unknown endpoint.
There is **no automatic stale endpoint reclamation**, even for a proven-dead
owned listener. ANY existing socket or ownership claim (including empty, torn,
legacy or ambiguous files) refuses startup without modifying existing bytes.
The operator channel is **UNAVAILABLE**, not fully ready, until explicit trusted
administrator recovery; the core interactive host continues. This deliberately
trades automatic availability for safe concurrent startup.

Before bind or endpoint publication, startup exclusively creates private,
no-follow 0600 `q/owner.json` as an immutable generation claim. Exactly one of
two legitimate starters sharing DATA_DIR can reserve it. It remains held for
the whole listener lifetime through final socket cleanup; the claim is removed
last. Existing claims are never interpreted as permission to reclaim. Startup
failure/crash/power loss after reservation or during bind can leave partial
state requiring manual recovery. A clean stop removes only its own anchored
socket/claim inodes and permits a fresh listener; delayed old cleanup cannot
remove a newer generation. A one-use private bind alias prevents Bun automatic
close-unlink from reaching a replacement endpoint. Inert `.bind-*` aliases from
crashes are not automatically swept.

Recovery is an **explicit administrative action outside normal startup**, not a
retry/controller/daemon or generic removal command. The trusted administrator
must positively establish that the owning listener and any in-progress starter
or delayed cleanup are dead/inactive, prevent overlapping startup during
recovery, and inspect the exact DATA_DIR/q and retained ownership evidence
before deliberately retiring only the identified inactive channel artifacts.
Ambiguity means leave them untouched and keep the channel unavailable. Never
remove or roll back keyed-quarantine operation intents/results as channel
recovery. The channel claim is not a native CM-store lock and does **not**
serialize cross-process native operations. It is cleanup/reservation evidence,
not an operation receipt, consent token, or malicious-same-UID sandbox.
This is not new TCP/discovery/grants.

**P1 history:** rejected candidate `0706a7b908f5a61c066a2671290beb43568bbe10`
connected the operator CLI to the regular socket. Even successful read-only
inspection evicted a retained stream controller. Documenting takeover did not
make that disruption acceptable; the separate control channel removes that path and remains unchanged here.
The subsequent `1f14edb918f6b064e9ace2820d5bc722892d1e41` reclaim branch had a
separate concurrent stat→unlink P1: a paused stale reclaimer could unlink a
new live generation. This correction removes that branch entirely, rather than
adding further checks. The original race/control fixtures no longer reach their
reclaim barrier; they are historical evidence, not newly passing race tests.

Filesystem access under the host UID is administrative access, **not proof of a
human's consent or a hostile-agent sandbox**. An agent with shell/full sudo can
invoke this command too. Actor names, recipes, booleans and `APPROVE` text confer
no authority. Selection and the exact confirmation statement are necessary to
avoid inadvertent mutation; they are not authentication or human attestation.
Use the existing host account/socket access policy. This does not add grants.

## Example

```sh
connectome quarantine inspect resident
# Inspect records (not chunks/spans), binding, configuredModel, completeness,
# selection nonce, expiry, server epoch and agent incarnation. Explicitly pick
# ONE selectable full key and its native generation. No automatic selection.
# Generate a fresh UUIDv4 operation ID, e.g. with uuidgen (lowercase).
connectome quarantine release resident "$KEY" "$GENERATION" "$SELECTION" "$OPERATION" \
  --confirm "waive L1 hold resident $KEY $GENERATION $SELECTION $OPERATION"
connectome quarantine result "$OPERATION"
```

Substitute observed values, not literal variable names. For a key beyond a
truncated list: `connectome quarantine inspect resident "$FULL_KEY"`.
A key must be one full lowercase 64-hex native key. Empty, omitted, `all`,
prefixes, wildcards and bulk release are invalid. The CLI exits 2 for bad syntax,
1 for refusals/uncertainty/unavailability, 0 for an inspection or acknowledged
release (including its saved acknowledgement). It never starts a host.

Inspection is read-only; the host stores at most 64 snapshots for 60 seconds.
Expiry uses monotonic elapsed time (the displayed expires value is a wall-clock estimate). Each snapshot binds exact agent/incarnation, server/framework/agent/manager/
strategy identity, native namespace/branch/load binding, and selectable full
key/generation pairs. The nonce is consumed on its first new-operation release submission,
including invalid confirmation. Restart, branch/load change, changed instance,
expiry or framework replacement requires fresh inspection and intent. Ordinary
conversation appends do not invalidate it. Busy turns, queues, scripts,
operator work, stop/switch, unloaded/shared/unverifiable manager scope and unsupported/duplicated CM
package identity explicitly refuse. Native branch/generation CAS remains the
CM's authority, including while its call waits on its own lock.

### Wire example

```json
{"type":"quarantine-inspect","agent":"resident","limit":50,"corrId":"read-1"}
```

The response is `quarantine-response`; `status: "ok"` carries the native view,
plus `selection`, `expires`, `serverEpoch`, `agent`, `agentIncarnation`.
Release carries the same `agent`, exact `key`, `generation`, `selection`, fresh
UUIDv4 `operation`, and `confirmation` statement above. Result carries only
`type: "quarantine-result"` and `operation`. All require a nonempty string `corrId` on the separate control socket.
These are fixed verbs, not names of arbitrary methods to invoke.

## Durable intent, replay and uncertainty

Before its **one** native `releaseCompressionRefusalQuarantine` call, the host
synchronously reserves the operation in
`DATA_DIR/keyed-quarantine-operations/<UUID>.intent.json`. It consumes the nonce,
checks current lifecycle/identity, uses anchored directory file descriptors and
O_EXCL/O_NOFOLLOW, writes mode 0600 under a private 0700 directory, and fsyncs
both file and directory before invoking native CAS. Data directory ownership
and non-group/other-writability are required. This implementation requires
**Linux with `/proc/self/fd` and a filesystem honoring fsync/noclobber**; other
systems explicitly refuse release/result persistence. Ancestors and the host
UID/admin are trusted; this does not sandbox malicious same-UID filesystem
changes. Retain receipts on durable storage; do not delete/roll back this
operation directory independently of the host's lifetime.

An immutable separate result records the observed native response, or an
uncertain exception. Repeating an operation ID, from another CLI client or
after host restart, only reads its saved observation: it never redispatches a
reserved operation. Concurrent duplicates see `uncertain` while it is pending,
not a promised eventual success. A torn/unreadable reservation or failed
outcome write also remains uncertain. Pre-dispatch persistence failures call
no native mutation. No acknowledgement means **unknown**, never permission to
send a new operation or generation automatically. Inspecting a missing key is
a separate observation, **not proof that this operation cleared it**. A fresh
operator intent is not an automated reconciliation/retry mechanism.

There is no atomic transaction spanning these files and Chronicle, and no
exactly-once provider promise. A crash after a native write but before recording
its acknowledgement leaves a permanent pending/uncertain receipt. The host
never restores old state, invokes the legacy optional-key clear, or retries a
native exception. It cannot protect replay history against an administrator
who removes/rolls back receipts, disk corruption, or storage that lies about
fsync. Receipts have no automatic pruning, so disk usage grows with operations.

## Semantics and observability limits

A release is a **waiver**, not scheduling, a provider request, L1 success,
coverage, paid debt, fit recovery or semantic fidelity. One active shape leaves
the cap, not all retained history. Other records survive; **all shared family
progress is forgotten** by the native operation, including progress shared
with siblings. Native eligibility, fallback/admission and subsequent ordinary
work remain CM-owned. Zero alarm callback count means only record absence.
Same-live-episode non-payment diagnostics are separate from callback counts;
the host does not trigger a tick or an alarm check on waiver.

`configuredModel` describes the loaded strategy's configured logical model;
`recordedModel` is historical configuration. `configuredAtInspection` preserves
the loaded strategy model and explicit public `recipe.agent.provider` label
(or null when unspecified), plus a null credential alias, in the intent and
outcome receipts. This is a host-default logical label, not a separately
verified compression route or an upstream observation. Neither is the actual upstream
used model. Native provider/credential/category fields remain null. This host
baseline configures compressionModel separately where specified, otherwise
uses the agent model; it has no authoritative separate compression-route alias
in this surface. No credential/token/fingerprint, topic-based category inference
or per-item model override is introduced.

**Actual correlated retry observations are unknown.** Existing CM diagnostic
`compression:attempt` carries source IDs/hash, request hash, configured model
and normalized outcomes, but is not a public operation/generation-correlated
host callback. CM's provider call passes formatter/signal, not the selected
quarantine generation/operation. AF's auxiliary admission wrapper passes a
model and completion, while Membrane's request/response hooks can observe a
request but have no authoritative selected native-key/generation correspondence.
The current surface deliberately does not attach the next unrelated request.
A minimal future proposal is a public nonsecret CM attempt correlation context
(namespace/branch/load + native key/generation/source/request identity), threaded
through AF's auxiliary lane to existing Membrane attempt observations, with
explicitly observed upstream model and logical route labels when available.
That proposal needs separate scope/review before AF/CM/Membrane edits. This
companion does **not** fully solve retry-route observability (Rowlet 6).

Inspection limits bound record/list entry counts, not full native ledger I/O or
arbitrary string bytes. This is a trusted local administrative surface, not a
qualified untrusted remote DoS endpoint. No real provider/live-agent/store,
engine-floor, deployment or full-suite qualification is implied by fake tests.
