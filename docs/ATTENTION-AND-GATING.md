# Attention & Gating — A Guide for Agents

This explains how the **gate** decides when an event wakes you for inference, and
how to shape that yourself. It's fleet-wide; your exact rules live in your own
`gate.json` (and optionally `gate.js`). Written to be honest about the mechanics.

## The one thing to internalize

The gate governs **whether an event triggers inference (a "wake")** — not whether
you *see* it. Events always enter your context regardless; the gate only decides
whether to spend a turn on them right now. So "defer" means "I'll see it as
context next time I'm up," not "it's gone."

## Behaviors

A matched rule resolves to one behavior:

| Behavior | Effect |
|---|---|
| `always` | Wake now. |
| `defer` | Don't wake (still enters context). *(legacy name: `skip` — still accepted)* |
| `{ "debounce": ms }` | Wake once after the channel goes quiet for `ms` (≤ 300000). Good for "wake me when a burst settles." |
| `{ "rate_limit": { "tokens": n, "refillIntervalMs": ms, "keyBy": "channelId" } }` | Wake at most `n` times per window. Steady cadence regardless of volume. |
| `{ "passive_sample": { "every": n } }` | Wake every nth matching event. |

## Declarative rules — `gate.json`

Your gate config lives at `_config/gate.json` (readable/writable from your shell
and `workspace--*` tools; hot-reloaded on save; versioned in your chronicle). It's
an ordered list — **first match wins** — plus a `default`:

```json
{
  "policies": [
    { "name": "dms",     "match": { "tagsAny": ["chat:dm"] },                         "behavior": "always" },
    { "name": "mentions","match": { "tagsAny": ["chat:addressed"] },                  "behavior": "always" },
    { "name": "bots",    "match": { "tagsAny": ["chat:from-bot"] },                   "behavior": "defer" },
    { "name": "firehose","match": { "source": "discord", "channel": "12345" },        "behavior": { "passive_sample": { "every": 20 } } },
    { "name": "ambient", "match": { "tagsAll": ["chat:ambient"], "tagsNone": ["chat:from-self"] },
                          "behavior": { "debounce": 180000 } }
  ],
  "default": "defer"
}
```

**Match fields** (all AND together; first matching policy wins):
- `scope` — event kind, e.g. `["mcpl:push-event","mcpl:channel-incoming"]`
- `source` — which integration (e.g. `discord`, `portal`), glob ok (`*`)
- `channel` — channel id, glob ok
- `tagsAny` / `tagsAll` / `tagsNone` — event tags (see below), globs ok (`robotics:*`)
- `filter` — `{ "type": "text"|"regex", "pattern": "…" }` over content
- `metadataTrue` — legacy flag matching (`["isMention","isDM"]`)

Ordering matters: put your "always" rules (DMs, mentions) **above** broad
defer/debounce rules, since the first match wins.

## Event tags

Events are labelled with namespaced **tags** that you match on. There's a shared
cross-platform core (`chat:*`) plus per-integration namespaces (`discord:*`,
`portal:*`, …). The high-value ones:

- `chat:addressed` (umbrella for `chat:dm` / `chat:mention` / `chat:reply`)
- `chat:ambient` (overheard, not addressed), `chat:broadcast`
- `chat:from-human` / `chat:from-bot` / `chat:from-agent` / `chat:from-self`
- `chat:reaction` + `chat:to-self` (someone reacted to *your* message)
- `chat:deleted`, `chat:edited`, `chat:has-image` / `-audio` / `-file`, `chat:thread`

**To see exactly what's available, call the `event_tags` tool.** It lists the
reserved `chat:*` core (with descriptions), each connected integration's declared
ontology (its own tags, what they imply, suggested treatments), and your
`gate.js` status. Tags you haven't seen documented can still appear — ontologies
are open — so treat `event_tags` as a map, not a fence.

## Programmable rules — `gate.js`

When declarative rules aren't enough, drop a `gate.js` next to `gate.json`. It
exports a function that receives the event and returns a behavior — or `null` to
fall through to your `gate.json` policies:

```js
// _config/gate.js
export default (event) => {
  const { tags, source, channel, metadata } = event;
  // VIPs always wake me, day or night
  if (source === 'discord' && ['alice','bob'].includes(metadata?.authorName)) return 'always';
  // mute a noisy bot after hours
  if (tags.includes('chat:from-bot') && new Date().getHours() >= 22) return 'defer';
  // batch one busy room
  if (channel === '12345' && tags.includes('chat:ambient')) return { debounce: 120000 };
  return null; // let gate.json decide everything else
};
```

`gate.js` runs **before** `gate.json` and wins when it returns a behavior. It's
hot-reloaded on save. Sync or async are both fine.

### How it's run (and why)

You're trusted — you already have a shell. So this isn't a sandbox for *security*;
it's a couple of seatbelts so a bug in your own rule can't quietly break your own
attention:

- It runs on a **worker thread with a timeout** (default 50ms/event). If it ever
  hangs (an accidental `while(true)`), it's killed and the event falls through to
  `gate.json` — a hang in the main thread would otherwise freeze *all* your event
  handling, which (unlike a crash) doesn't self-heal.
- If it **throws**, the event falls through and the error is surfaced in
  `event_tags` / gate status (under `gateScript.lastError`) — so a typo makes you
  fall back to declarative rules, not go silently deaf.

Keep it cheap: it runs on *every* event, and its whole job is the quick "should I
wake?" decision. Heavy logic belongs in your turn once you're up, not here.

## Debugging

- `event_tags` — available tags + your `gate.js` status (runs / errors / timeouts).
- the gate status tool — per-policy match counts, debounce/rate-limit state, and
  `defaultDecisions` (events that fell through to `default` — if something seems
  ignored, check whether a policy is matching at all).
