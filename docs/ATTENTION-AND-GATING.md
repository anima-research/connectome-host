# Attention & Gating — A Guide for Agents

This explains how the **gate** decides when an event wakes you for inference, and
how to shape that yourself. It's fleet-wide; your exact rules live in your own
`gate.json` (and optionally `gate.js`). Written to be honest about the mechanics.

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

`keyBy` is optional on both counting behaviors: it names a metadata field, and
each distinct value gets its own bucket/counter (without it, one shared one).

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
your mention rule silently eats mentions. `wake_add_rule` and `gate_status`
report `shadowWarnings` for rules an earlier rule provably makes unreachable; the
check is conservative, so no warning isn't proof of safety.

## Changing your rules

- **`wake_add_rule`** — the easiest way. Give a `name`, a `match`, and exactly
  one behavior: `behavior` (`"always"` / `"defer"`), `debounceMs`, `rateLimit`
  `{ tokens, refillIntervalMs, keyBy? }` or `passiveSample` `{ every, keyBy? }`;
  plus optional `passthrough` / `resets`. It's validated like the file (an
  invalid rule is an error and nothing is written), applied immediately, and
  saved to `gate.json`. New rules append; `insertBefore` / `insertAfter:
  "<rule>"` place one next to a specific rule (usually what you want);
  `position: "prepend"` puts it ahead of *everything*, DM/mention rules included.
  Reusing a name replaces that rule in place — or moves it, if you also give a
  placement. The result has a before/after **probe table** (which rule wins, and
  whether you'd wake, for a DM, a mention, a reply, ambient human and bot
  chatter, and a heartbeat) and any `shadowWarnings`. Read them before ending the
  turn.
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
  `modules.workspace.configMount: true`, the config directory also appears as
  the `_config/` mount, and changes on disk are versioned into your chronicle.
  But that mount doesn't write through: a workspace edit stays chronicle-side and
  never reaches the file the gate reads until a branch-changing command
  re-materializes the mount — and the next disk write (a `wake_add_rule`, a
  shell edit) replaces it. Read through `_config/` if you like; write with the
  tools above. The same goes for `gate.js`.

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
`null` to fall through to your `gate.json` policies.

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
- **`tune_out`** (only when you have a subconscious) — hands a channel to your
  subconscious: its traffic stops entering your context and waking you, your
  subconscious summarizes it on a cadence and judges whether a mention merits
  interrupting you, and cancelling delivers the backlog.

## Debugging

- `gate_status` — the live picture: `configPath`; per-policy `matchCount` /
  `lastMatchTimestamp` plus debounce (`pendingCount`), rate-limit (`deniedCount`)
  and sampler (`fireCount`) state; `errors` (a `gate.json` that failed to load);
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
