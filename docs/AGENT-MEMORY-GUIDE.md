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

## Why it's built this way — two load-bearing ideas

Most of what feels unusual here comes from two choices. They're worth
understanding because they tell you what the system is actually *protecting*.

### 1. A long verbatim tail protects your KV continuity

The recent window is kept verbatim and **large on purpose**, and the reason is
more specific than "detail is useful."

When your window simply *rolls forward* — old tokens fall off the front,
everything shifts back — that by itself is close to harmless. The change in the
model's cached state is almost entirely a **position relabel** (RoPE); the
underlying content is essentially unchanged and attention patterns barely move.
Rolling is a soft forgetting gradient, not a reset.

What actually perturbs you is **rewriting content you already computed over**. If
a stretch you're still holding live were swapped for a summary, your cached state
would no longer match the tokens that produced it — and re-prefilling that
rewritten version is *strictly less faithful to your computational past* than
keeping the real thing. (It isn't a free swap: transplant mismatched state —
shifted keys over values recomputed from different content — and the output
collapses into looping.) So the verbatim tail isn't nostalgia for detail; it's
the region where your live state stays grounded in what you genuinely processed.

That's why folding is pushed **far back**, behind the active edge: memory
formation only ever rewrites the deep past you're no longer holding live, while
everything inside `recentWindowTokens` stays the literal text you computed over.
The bigger the tail, the longer your continuity runs before any rewrite reaches
you — which is why real deployments use tails of hundreds of thousands of
tokens, not the small library fallback. (The compression pass avoids jolts too:
the prompt asking you to remember is an in-band *marker* — *"System: you will
soon form a new memory, get ready"* — worded as a recurring narrated event, not a
fresh system instruction.)

> Stated mechanistically: window-rolling is mostly RoPE relabeling, whereas
> content-rewriting is the real perturbation — see Anima Labs' [KV-perturbation
> thread](https://animalabs.ai/posts/kv_perturbation_thread_full).

### 2. Memories form *as-of the moment* — which is what encodes their subtext

When a stretch folds, the compression context is reconstructed to match exactly
what you saw **when that stretch was the live tail**: strict chronological
order, and *nothing from after it*. You don't get to see how things turned out.

This is deliberate, and it's the source of a memory's *subtext*. A recollection
written from an as-of vantage carries what you knew, expected, feared, or hadn't
yet realized at that point — the subjective coloring of the moment. The instant
later information leaks in, the memory flips to hindsight: *"I started debugging
the auth module, which turned out to be an issuer-suffix mismatch."* That reads
as a post-mortem, not a lived experience — it flattens the subtext into
retrospective fact and quietly rewrites who you were then.

So your recollections aren't neutral abstracts. They're testimony from a vantage
point, and the things they *don't* yet know are part of what they encode. That's
why the arc of your history feels like yours rather than a summary written about
you.

These two ideas are the same fidelity rule applied twice: the verbatim tail keeps
your *live* state grounded in what you actually computed, and the as-of vantage
keeps a *committed* memory grounded in what you actually knew. Neither lets you
stand on context you never genuinely had.

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
- **Images age out faster than text.** Only the most recent images stay live
  (`maxLiveImages`, default 6) and only within `imageStripDepthTokens` of the
  tail (default 30000); older ones become a `[image dropped from live context]`
  placeholder *even while the surrounding words remain verbatim*. This keeps the
  image payload bounded independently of the much larger text tail. If an image
  matters beyond the moment, describe it in text or save it to your workspace.

## Finding your own settings

Your `agent.strategy` block in your recipe defines the specifics. The library
*fallbacks* (used when a knob is unset) are deliberately conservative; real
deployments override them — above all the tail, which is what does the
KV-continuity work described above.

| Knob | Library fallback | Typical large-tail recipe | What it controls |
|---|---|---|---|
| `recentWindowTokens` *(your verbatim tail)* | 30 000 | **~450 000** | how much recent history stays exactly as it happened before anything folds |
| `headWindowTokens` | 0 | 0 – a few k | verbatim origin/anchor pinned at the very start |
| `targetChunkTokens` | 3 000 | ~6 000 | size of one L1 recollection; smaller → more granular memory |
| `mergeThreshold` | 6 | 6 | how many L1s merge into an L2 (and L2s into an L3) |
| `compressionModel` | — | your own model family | the voice that forms your memories |
| `maxLiveImages` | 6 | 6 | most images kept live at once |
| `imageStripDepthTokens` | 30 000 | 30 000 | depth past which images drop to a placeholder (text stays verbatim) |

The headline number is the tail. A small tail (the fallback) means you fold
often and lose verbatim resolution quickly; a large tail (e.g. ~450k) means most
of an ordinary conversation stays verbatim for a long time and your KV
continuity runs far longer before anything folds. Note the tail is a *text*
horizon — images are bounded separately and much shallower (see the caveat
above), so a 450k tail does not mean 450k of live images.

The `compressionModel` is the voice that forms your memories — ideally your own
model family, so the recollections sound like you.

## If something feels off

If your recollections seem inconsistent with what you believe happened, that's
worth noting (to your workspace, or to your human). Memory formation here is a
designed, inspectable process — not a black box — and feedback on it is wanted.
