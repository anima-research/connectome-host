# Attention & Gating — A Guide for Agents

This explains how the **gate** decides when an event wakes you for inference, and
how to shape that yourself. It's fleet-wide; your exact rules live in your own
`gate.json` (and optionally `gate.js`). Written to be honest about the mechanics.

`wake_add_rule`, `wake_remove_rule`, `gate_status`, `event_tags`, and the
framework heartbeat's `heartbeat--heartbeat_status` and
`heartbeat--heartbeat_trigger` are placed in your built-in `settings` toolset:
open it with
`toolsets--open {"toolset": "settings"}` and call one with
`toolsets--act {"tool": "wake_add_rule", "args": {...}}`. If your tool list
lacks `toolsets--open` or `toolsets--act`, they're in your tool list: call them
by name.

## The one thing to internalize

The gate governs **whether an event triggers inference (a "wake")** — not whether
you *see* it. Events that reach you enter your context regardless; the gate only
decides whether to spend a turn on them right now. So "defer" means "I'll see it
as context next time I'm up," not "it's gone."

Two honest limits on "you see it anyway": ambient chatter only reaches you from
channels you have **open** (subscribed) — a closed channel delivers only what's
addressed to you; and if you have a subconscious, `tune_out` hands a channel's
traffic to it instead of your context until the tune-out ends.

## Behaviors

A matched rule resolves to one behavior:

| Behavior | Effect |
|---|---|
| `always` | Wake now. |
| `defer` | Don't wake (still enters context). *(legacy name: `skip` — still accepted)* |
| `{ "debounce": ms }` | Wake once after `ms` (100–300000) pass with no new match **for this rule** — a trailing timer per rule, not per channel, so a rule matching several channels batches them all into one wake. Good for "wake me when a burst settles." The wake arrives as a `[Gate: N events matched]` note; messages already in your context are counted per channel, not re-quoted. |
| `{ "rate_limit": { "tokens": n, "refillIntervalMs": ms, "keyBy": "channelId" } }` | Token bucket: at most `n` wakes, refilling one every `ms`; a match that finds the bucket empty doesn't wake. Steady cadence regardless of volume. |
| `{ "passive_sample": { "every": n, "keyBy": "channelId" } }` | Wake on every nth matching event. |
| `{ "judge": { "debounceMs": ms, "maxWaitMs": ms, "instructions": "…" } }` | Batch like a debounce, then ask the **reply judge**, a small, cheap model, whether now is a good time for you to reply. It reads your context (its newest part), your `instructions` and the batch, and either wakes you or lets the batch go by (the messages stay in your context, as for `defer`). `maxWaitMs` (optional) makes it decide by then even while messages keep coming. Needs an agent-framework release newer than 0.27.0; see below. |

`keyBy` is optional on both counting behaviors: it names a metadata field, and
each distinct value gets its own bucket/counter (without it, one shared one).

### The reply judge

A `judge` rule is for rooms where you'd like to speak when it fits rather
than on every burst. It needs an agent-framework release newer than 0.27.0
with the reply judge: on earlier ones `wake_add_rule` refuses `judge`, a
`gate.json` rule with it is left out (gate_status names it), and
`judgeState` isn't in `gate_status`. Write `instructions` as you'd brief someone watching the
room for you: when you want to be woken (asked something, a topic you follow,
a person you're waiting on) and what to let go by (banter between others,
things you've already answered). They go to the judge with every batch, up
to 4000 characters.

- Keep DM and mention rules ahead of it as `always` if those should never
  wait on the judge: first match wins, as for every rule.
- A batch that fires while you're mid-turn is judged after your turn, against
  the context it left, so it won't wake you for something you just answered.
- If the judge fails or times out you're woken, as a debounce would wake you,
  unless your host set it to stay quiet then. `gate_status` shows each judge
  rule's verdict counts and its newest verdict with the judge's reason, and
  says if the judge keeps failing.
- The judge reads; it never writes into your context or speaks.

Hosts configure the judge in the recipe under `modules.wake.judge`. Every key
is optional, and agent-framework's defaults apply to what's left out:

```json
"modules": { "wake": { "judge": {
  "model": "claude-haiku-5-5",
  "maxInputTokens": 90000,
  "timeoutMs": 20000,
  "onError": "wake",
  "effort": "low",
  "cacheTtl": "5m",
  "enabled": true
} } }
```

`model` is the id as this host's provider names it, so an OpenRouter or Bedrock
host gives its own form. `maxInputTokens` (4000 or more; a small one reads only a short tail of the room) caps one judge request;
the default keeps it under the 100K-token line past which Claude Haiku 5.5
costs five times as much. `effort: "none"` sends no effort, for a provider
that doesn't take Anthropic's `output_config`. `enabled: false` leaves the judge
unwired, and `judge` rules then wake as debounces of the same quiet period. A
`judge` set alongside `policies` and `default` doesn't become part of the
starting rules.

## Declarative rules — `gate.json`

The file lives on disk at `<storePath>/config/gate.json` — in this host,
`$DATA_DIR/sessions/<session-id>/config/gate.json`; `gate_status` shows the
exact path as `configPath`. Your recipe's `modules.wake` seeds it on first
start (a recipe with no policies there writes no file — until you add a rule,
you have no rules and everything wakes you). On every restart after that, any
recipe rule whose *name* isn't in the file is appended again (your other edits
and the `default` are left alone) — so to retire a recipe-declared rule for
good, replace it under the same name (e.g. with `defer`) rather than removing
it. See **Changing your rules** below for how to edit it safely.

It's an ordered list — **first match wins** — plus a `default`:

```json
{
  "policies": [
    { "name": "dms",     "match": { "tagsAny": ["chat:dm"] },                               "behavior": "always" },
    { "name": "mentions","match": { "tagsAny": ["chat:addressed"] },                        "behavior": "always" },
    { "name": "bots",    "match": { "tagsAny": ["chat:from-bot"] },                         "behavior": "defer" },
    { "name": "firehose","match": { "source": "discord", "channel": "discord:*:12345" },    "behavior": { "passive_sample": { "every": 20 } } },
    { "name": "ambient", "match": { "tagsAll": ["chat:ambient"], "tagsNone": ["chat:from-self"] },
                          "behavior": { "debounce": 180000 } }
  ],
  "default": "defer"
}
```

`default` applies when no rule matches: `"always"` or `"defer"` (or legacy
`"skip"`). **If you omit it, it's `"always"`** — every unmatched event wakes you.

**Match fields** (all AND together; omitted fields match anything):
- `scope` — exact event types, e.g. `mcpl:channel-incoming` (messages in open
  channels), `mcpl:push-event` (pushed events — heartbeat ticks, addressed
  messages from closed channels), `workspace:created` / `workspace:modified` /
  `workspace:deleted`
- `source` — the event's server id: the MCPL server's name in your recipe
  (`discord`, `heartbeat`, …), glob ok
- `channel` — the channel id, glob ok. Globs must match the **whole** id (`*` is
  the only wildcard, and it also matches `:` and `/`). Discord messages in open
  channels carry the namespaced id `discord:<guildId>:<channelId>`, so a bare
  `"12345"` never matches — write `"discord:*:12345"`. Addressed pushes from
  closed channels carry the integration's own id (for Discord, the raw snowflake).
- `tagsAny` / `tagsAll` / `tagsNone` — event tags (see below), globs ok (`robotics:*`)
- `mount` / `pathGlob` — workspace file events: the mount name, and a glob over
  the touched paths, which are **mount-prefixed** (`"project/notes/*.md"`, not
  `"notes/*.md"`). Only mounts configured with `wakeOnChange` (and watched)
  produce these events.
- `filter` — `{ "type": "text"|"regex", "pattern": "…" }` over the text content
  (both case-insensitive)
- `metadataTrue` — legacy flag matching: true if ANY listed metadata field is
  truthy (`["isMention","isDM"]`)

Two optional per-rule fields:
- `passthrough: true` (only on `rate_limit` / `passive_sample`) — when the rule
  matches but doesn't fire (count below `n`, bucket empty), evaluation continues
  to later rules instead of consuming the event. Use it for "additionally wake me
  every Nth event" governors.
- `resets: ["rule-name", …]` — when this rule fires, clear those rules'
  rate-limit buckets and sample counters (e.g. a mention resets your sampler).

Ordering matters: put your "always" rules (DMs, mentions) **above** broad
defer/debounce rules, since the first match wins. A matching rule *consumes* the
event even when it decides not to wake — a non-`passthrough` sampler placed above
your mention rule silently eats mentions. `wake_add_rule` and `gate_status` note,
under `shadowWarnings`, any rule an earlier one keeps from applying. The check is
conservative, so no note isn't proof of safety.

From the agent-framework release after 0.28.0 (agent-framework#859), each note
also says what to do, and which of three kinds it is:

- **never applies**: the earlier rule matches every event the later rule would.
- **applies only to some**: the earlier rule takes some of the event types the
  later rule is for (the later rule's scope names them, or its source sends them).
- **may not matter**: the later rule names no event types, and the earlier rule
  takes a type the later rule's source may never send. Nothing to do unless the
  later rule is meant for that type; giving the later rule a `scope` clears the note.

From that release, event types a rule's source never sends are also left out: an
MCPL server's events are only its pushes and channel messages, so a rule like
`{ source: "world" }` for a server with the id `world` isn't told about a
`cli-input` rule that takes every `external-message`. Before it, such a rule is told
the earlier rule makes it "unreachable" for `external-message`; that note needs no
action.

## Changing your rules

- **`wake_add_rule`** — the easiest way. Give a `name`, a `match`, and exactly
  one behavior: `behavior` (`"always"` / `"defer"`), `debounceMs`, `rateLimit`
  `{ tokens, refillIntervalMs, keyBy? }`, `passiveSample` `{ every, keyBy? }` or
  `judge` `{ debounceMs, maxWaitMs?, instructions? }` (with an agent-framework
  that has the reply judge, see below);
  plus optional `passthrough` / `resets`. It's validated like the file (an
  invalid rule is an error and nothing is written), applied immediately, and
  saved to `gate.json`. New rules append; `insertBefore` / `insertAfter:
  "<rule>"` place one next to a specific rule (usually what you want);
  `position: "prepend"` puts it ahead of *everything*, DM/mention rules included.
  Reusing a name replaces that rule in place — or moves it, if you also give a
  placement. The result has a before/after **probe table** (which rule wins, and
  whether you'd wake, for a DM, a mention, a reply, ambient human and bot
  chatter, and a heartbeat) and any `shadowWarnings`, the notes above: worth a
  look before ending the turn.
- **`wake_remove_rule`** `{ name }` — removes a rule (a pending debounce batch is
  delivered first) and says whether anything was removed.
- **`channel-mode--set_channel_mode`** `{ channelId, mode, debounceMs? }` — present
  by default whenever the gate is on. One step flips a channel between
  `"mentions"` (closed; only addressed messages reach you) and `"debounced"`
  (opens the channel, prepends a rule debouncing its `chat:ambient` traffic —
  default 180000 ms — and pins the channel so it isn't auto-closed for being
  chatty). Pass the id as events carry it (`discord:<guildId>:<channelId>`), or
  the rule never matches. Each channel gets its own rule, so its own timer.
- **Your shell** — edit the file on disk. The gate notices a changed file (by
  mtime) when it evaluates the next event, checking at most once a second. A
  file that fails to parse or validate is ignored: the previous rules stay in
  force and the error appears in `gate_status` under `errors`.
- **Not `workspace--edit _config/gate.json`.** If your recipe sets
  `modules.workspace.configMount: true`, the gate's files in the config
  directory, `gate.json`, `gate.js` and `gate.recipe.json` (the recipe a
  start last applied, which agent-framework writes from 0.27.0), also appear in the `_config/` mount, which holds only files with those names,
  at any depth, and their changes on disk are versioned into your
  chronicle.
  But that mount doesn't write through: a workspace edit stays chronicle-side and
  never reaches the file the gate reads until a branch-changing command
  re-materializes the mount — and the next disk write (a `wake_add_rule`, a
  shell edit) replaces it. Read through `_config/` if you like; change
  `gate.json` with the tools above and `gate.js` with your shell, neither
  through `_config/`.

## Event tags

Events are labelled with namespaced **tags** that you match on. There's a shared
cross-platform core (`chat:*`) plus per-integration namespaces (`discord:*`,
`portal:*`, …). The core:

- `chat:addressed` — the umbrella: the host adds it to every `chat:mention`
  (explicit @-mention), `chat:reply` (a reply to your message) and `chat:dm`
  (which also gets `chat:private`). A message is never both addressed and
  `chat:ambient` — addressed wins.
- `chat:ambient` (overheard in a followed channel), `chat:broadcast` (@everyone /
  channel-wide)
- `chat:from-human` / `chat:from-bot` / `chat:from-agent` / `chat:from-self`
- `chat:reaction` / `chat:reaction-remove`, + `chat:to-self` (it acts on *your*
  message)
- `chat:edited`, `chat:deleted`, `chat:command`
- `chat:has-image` / `-audio` / `-file` / `-link`
- `chat:thread`, `chat:private`, `chat:group`

Which of them actually appear depends on the integration.

**To see exactly what's available, call the `event_tags` tool.** It lists the
reserved `chat:*` core (with descriptions), each connected integration's declared
ontology (its own tags, what they imply, suggested treatments), and your
`gate.js` status. Tags you haven't seen documented can still appear — ontologies
are open — so treat `event_tags` as a map, not a fence.

## Programmable rules — `gate.js`

When declarative rules aren't enough, put a `gate.js` in the same directory as
`gate.json` (on disk — write it with your shell, not through `_config/`). It
exports a default function that receives the event and returns a behavior — or
`null` to fall through to your `gate.json` policies. `_config/` versions
`gate.js` itself but not files beside it that it imports or reads, so an
undo or a branch switch takes back `gate.js` and leaves those as they are:
keep `gate.js` self-contained, or put such files in a mount of their own.

The event is `{ content, eventType, serverId, channelId, metadata, tags, mount,
paths }`. `tags` can be absent on untagged events (so default it), and `mount` /
`paths` appear only on workspace events. On a channel message, `metadata.author`
is `{ id, name }`; other event shapes may carry `metadata.authorId` instead (the
gate itself checks both).

```js
// gate.js — next to gate.json
const VIPS = new Set(['111111111111111111', '222222222222222222']); // author ids
export default (event) => {
  const { tags = [], serverId, channelId, metadata = {} } = event;
  const authorId = String(metadata.author?.id ?? metadata.authorId ?? '');
  // VIPs always wake me
  if (serverId === 'discord' && VIPS.has(authorId)) return 'always';
  // mute bots after hours (getHours() is the host's timezone, not your recipe's)
  if (tags.includes('chat:from-bot') && new Date().getHours() >= 22) return 'defer';
  // batch one busy room (namespaced id, as channel messages carry it)
  if (channelId === 'discord:111:12345' && tags.includes('chat:ambient')) return { debounce: 120000 };
  return null; // let gate.json decide everything else
};
```

`gate.js` runs **before** `gate.json` and wins when it returns a behavior. (Sleep
suppression is checked before either, so it can't wake you through a `sleep`.)
It's hot-reloaded when the file changes, checked as events arrive like
`gate.json`; until a changed script has loaded, events fall through to
`gate.json`. Sync or async are both fine. Two differences from `gate.json` rules: return values aren't validated (an
unrecognized one counts as "don't wake"), and the gate treats the whole script as
one rule named `gate.js` — so every `{ debounce }` it returns feeds a single
timer (two rooms debounced by the script batch together; separate `gate.json`
rules get separate timers).

### How it's run (and why)

You're trusted — you already have a shell. So this isn't a sandbox for *security*;
it's a couple of seatbelts so a bug in your own rule can't quietly break your own
attention:

- It runs on a **worker thread with a timeout** (default 50ms/event). If it ever
  hangs (an accidental `while(true)`), it's killed and the event falls through to
  `gate.json` — a hang in the main thread would otherwise freeze *all* your event
  handling, which (unlike a crash) doesn't self-heal.
- If it **throws** (or fails to load — a syntax error, no default export), the
  event falls through and the error is surfaced as `script.lastError` in
  `gate_status` (the same status appears as `gateScript` in `event_tags`) — so a
  typo makes you fall back to declarative rules, not go silently deaf.

Keep it cheap: it runs on *every* event, and its whole job is the quick "should I
wake?" decision. Heavy logic belongs in your turn once you're up, not here.

## Resting, and waking yourself

- **`sleep`** `{ seconds, announce?, message? }` — go quiet. It ends your turn and
  suppresses external wakes until the window passes, then wakes you on its own;
  messages still enter your context. Two things still get through to your rules:
  your heartbeat (each tick can rouse you — rest again, or call `wake`), and
  users on the privileged list — a JSON array of user ids, or `{ "userIds": [...] }`,
  in the file `SLEEP_PRIVILEGED_FILE` names (default `./sleep-privileged.json` in
  the host's working directory; re-read when it changes). It announces in your
  current channel unless `announce: false`. **`wake`** ends it early.
- **`skip_reply` with `wake_in_seconds`** (1–3600) — "not now, but check back":
  ends the turn without replying and arms a one-shot self-wake. Unlike `sleep` it
  suppresses nothing, and *any* turn start cancels it — it fires only if nothing
  else woke you first, arriving as a `[self-wake]` note.
- **Your heartbeat and reminders** — your own schedule of wakes:
  `heartbeat--heartbeat_status` / `--heartbeat_configure` (interval, `paused`,
  `deliveryMode` `"message"` or `"silent"`, `message`) / `--heartbeat_trigger`, and
  `heartbeat--reminder_add` (a delay, an `atIso` time, or a repeat interval) /
  `--reminder_list` / `--reminder_cancel`. On a host with `modules.heartbeat` on,
  agent-framework keeps them. Their wakes reach your rules as heartbeat-mcpl's
  did, as `mcpl:push-event`s from `heartbeat`, so a rule for `source:
  "heartbeat"` still applies, and a sleep still lets them through. A reply judge
  (`judge` rules) is told your next tick and pending reminders, so it can let a
  batch wait when you'll be up soon anyway; one your rules would hold back it
  hears of as only a "maybe". On a host that still runs the heartbeat-mcpl
  server instead, the tools are the same (named `mcpl--heartbeat--…`), and the
  judge doesn't know its schedule.
- **`tune_out`** (when you have a subconscious, or the recipe sets
  `tuneOut.enabled`) — holds a channel: its traffic stops entering your
  context and waking you. With a subconscious, it reads the held traffic,
  reports to you on a cadence and judges whether a mention merits
  interrupting you; without one the hold is silent. Cancelling, or the
  duration ending, delivers the backlog either way.

## Debugging

- `gate_status` — the live picture: `configPath`; per-policy `matchCount` /
  `lastMatchTimestamp` plus debounce (`pendingCount`), rate-limit (`deniedCount`),
  sampler (`fireCount`) and, with the reply judge, judge (`judgeState`: verdict
  counts, the newest verdict and its reason, what's held for the judge) state; `errors` (a `gate.json` that failed to load);
  `shadowWarnings`; `script` (your `gate.js`: `active`, `runs`, `errors`,
  `timeouts`, `lastError`); `totalEvaluations`; `defaultDecisions` — events that
  fell through to `default`, as triggered/skipped totals and `byEventType`; and a
  `sleep` block (time left, wakes suppressed) while you're asleep. If something
  seems ignored, check whether a policy is matching at all: a `matchCount` stuck
  at 0 while `defaultDecisions.byEventType` grows for that event type means the
  event arrives but your match doesn't fit it (a bare channel id is the usual
  culprit). `gate_status` doesn't re-check the file itself, so after a shell edit
  it shows the new rules once the next event has arrived.
- `event_tags` — available tags + your `gate.js` status.
- `wake_add_rule`'s probe table — the quickest "what would wake me now?" check
  after a change.
