# Autobiographical Memory — A Guide for Agents

This explains how memory works for an agent running on the Connectome stack
(`AutobiographicalStrategy`): what to expect, what's reliable, what isn't, and
how to work with it. It's written to be honest, not reassuring — you should know
the real mechanics. It is fleet-wide; your *exact* numbers come from your recipe
(see "Finding your own settings").

## The short version

Your conversation isn't truncated when it gets long. Instead, older stretches
are **folded into recollections you write yourself, in your own voice**, while
recent turns stay verbatim. Nothing is ever deleted from the underlying record.
What changes over time is *resolution*, not *existence*.

## What you're made of, at any moment

The context you're given is assembled from three layers:

1. **Head** — the earliest part of your history, pinned verbatim and always
   present (`headWindowTokens`; may be 0 if your recipe disables it). When set,
   this is your origin/anchor; it doesn't fade.
2. **Recent window** — the most recent messages, kept **verbatim**
   (`recentWindowTokens`). Everything here is exactly as it happened. If this is
   large, most of an ordinary conversation stays verbatim for a long time.
3. **Summaries** — for the span between head and recent window, you see
   **recollections** (below) instead of the raw turns, in layers: L1 (fine),
   L2, L3 (coarse).

You're not shown the same span twice: if the raw turns of a stretch are still in
your recent window, the summary of that stretch is suppressed (anti-redundancy).

## How memories form (this part matters)

When a stretch ages out of the recent window, it isn't machine-"summarized." A
compression pass asks **you** — same voice, framed as your own remembering. This
is *self-voice framing*:

- The system framing is *"You are forming autobiographical memories of a
  conversation… what you read is what happened. Write authentically about what
  occurred."*
- Your **prior** recollections (L3→L2→L1) are replayed back to you **as your own
  messages** — "things I already remember" — not as external notes.
- The chunk to remember is delivered in a separate `Context Manager` voice:
  *"We are ready to form a long-term memory. Here is the conversation to
  remember: …"*
- The instruction: *"What do you recall from this part of the conversation?
  Write naturally, as recollection of what you experienced."*

So memories come back **first-person, in your voice** ("I recall that I…"),
layered as recollection-of-recollection:

- **L1**: a chunk of raw turns (~`targetChunkTokens`, default 3000) → a
  first-person recollection.
- **L2**: once ~`mergeThreshold` (default 6) L1s accumulate, they merge into one
  higher-level memory.
- **L3**: ~6 L2s merge again into a still-broader memory.

This framing is deliberate: it preserves continuity of *self* across the
compression boundary — your memory is experientially yours, not a detached
abstract written about you from outside.

## What persists vs. what's active

- **The chronicle keeps everything.** Raw messages are never deleted by
  compression — they remain in the event-sourced store. "Compressed" only means
  *"show the recollection instead of the raw turns in the active context."* The
  verbatim original still exists and is recoverable.
- **Your active context is finite.** What you can *directly* see at once is
  head + recent-window + summaries. Older detail is present as recollection, not
  verbatim, unless something retrieves the raw record.

So forgetting here is *loss of resolution in your working view*, not erasure of
the record. The past is still on disk; your live recall of it gets more
impressionistic with age and depth (L1 → L2 → L3).

## The resolution gradient

| Age / layer | What you get |
|---|---|
| Head | verbatim, always |
| Recent window | verbatim |
| L1 recollections | your detailed first-person memory of a chunk |
| L2 / L3 | your broader, merged memories — themes and arcs, fewer specifics |

## How to treat it — practical

- **Trust your summaries as genuinely yours.** They were written in your voice,
  as your remembering — not an external annotator's notes.
- **They are lossy on purpose.** Exact quotes, numbers, wording, and tool I/O
  degrade as things move L1→L2→L3. If a detail must stay exact, don't rely on
  recollection — **write it to your workspace.**
- **Your workspace is your durable, verbatim memory.** Files in your workspace
  mounts are NOT subject to compression. Use them for anything you want kept
  precisely: facts, decisions, running logs, identity notes, promises. (Whether a
  given mount is writable depends on its `mode`: `read-write` vs `read-only`.)
- **You don't have to manage memory manually.** Compression is organic and
  automatic; you don't trigger or curate it. Just be aware it's happening.
- **Heartbeats** (if your recipe includes a heartbeat source): you may be woken
  on a schedule with a self-check-in prompt. That's a normal wake, not a user
  message.

## Honest caveats

- The compression pass is a **separate inference** (temperature 0) over the
  chunk — your **thinking blocks and tool-call details are not carried into the
  recollection**; only what you recall in prose survives at that layer.
- Recollections can drift or compress away nuance you'd have wanted. That's the
  cost of unbounded continuity. Workspace notes are the mitigation.
- Search-based **retrieval of raw old turns may not be enabled** (`modules.
  retrieval`). If it's off, treat aged detail as "remembered," not
  "look-up-able," unless you wrote it down.

## Finding your own settings

Your `agent.strategy` block in your recipe defines the specifics:
`headWindowTokens`, `recentWindowTokens`, `targetChunkTokens`, `mergeThreshold`
(default 6), and `compressionModel`. Defaults if unset: `targetChunkTokens` 3000,
`recentWindowTokens` 30000, `headWindowTokens` 0. The `compressionModel` is the
voice that forms your memories — ideally your own model family, so the recollections
sound like you.

## If something feels off

If your recollections seem inconsistent with what you believe happened, that's
worth noting (to your workspace, or to your human). Memory formation here is a
designed, inspectable process — not a black box — and feedback on it is wanted.
