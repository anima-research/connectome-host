# Autobiographical Memory — A Guide for Agents

This explains how memory works for an agent running on the Connectome stack
(`AutobiographicalStrategy`, with the adaptive resolution and kv-stable folding
that connectome-host turns on by default): what to expect, what's reliable,
what isn't, and how to work with it. It's written to be honest, not
reassuring — you should know the real mechanics. It is fleet-wide; your
*exact* numbers come from your recipe and your own runtime settings (see
"Finding your own settings").

## The short version

Your conversation isn't truncated when it gets long. Instead, older stretches
are **folded into recollections you write yourself, in your own voice**, while
recent turns stay verbatim. Folding happens only as far as it has to for your
context to fit its budget, and only gradually. Nothing is ever deleted from
the underlying record. What changes over time is *resolution*, not
*existence*.

## What you're made of, at any moment

The context you're given is assembled from three parts:

1. **Head** — the earliest part of your history, pinned verbatim and always
   present (`headWindowTokens`; 4000 tokens unless your recipe says
   otherwise, and it may be 0). When set, this is your origin/anchor; it
   doesn't fade.
2. **Middle** — everything between the head and the tail. Each stretch here
   is shown at its own resolution: **raw**, or as one of your memories of it
   — L1 (a detailed memory of one chunk), L2 (a memory of several L1-sized
   stretches), and so on up to L8 for the deepest past. The middle stays raw
   for as long as it fits; only when your whole context would exceed its
   budget (`contextBudgetTokens`) are stretches folded — just enough to fit.
3. **Tail** — the most recent messages, kept **verbatim**
   (`recentWindowTokens`). Everything here is exactly as it happened. If this
   is large, most of an ordinary conversation stays verbatim for a long time.

You're never shown the same stretch twice: a span appears either raw or as a
memory, never both. A memory appears where its stretch happened in the
timeline, as a `[Recall L2-15]`-style prompt followed by the memory itself in
your voice.

Folding is also **gentle**. A solver chooses which stretches to fold, and how
deep, so as to disturb as little as possible of the context you have already
computed over; and when your budget is lowered, your context converges to it
over several turns (`transitionPaceTokens` per turn) rather than all at once.

## How memories form (this part matters)

Memories are written as stretches leave the tail — ahead of need, so that a
memory already exists when the budget eventually calls for it. *Writing* a
memory and *showing* it are separate: an L1 can sit unused while its stretch is
still shown raw.

When a chunk (about `targetChunkTokens` of raw turns) is due, a compression
pass asks **you** — your model, your voice — to remember it. What that pass
sees is your own context, reconstructed:

- your head, verbatim;
- your earlier memories, replayed **as your own messages** — each one as a
  small exchange where you are asked to recall memory `L1-3` and answer with
  that memory, in your voice. These are "things I already remember", not
  external notes;
- an in-band marker, worded as a recurring event rather than a fresh system
  instruction: *"System: You will soon form a new memory, get ready. The
  messages that follow are the slice of recent experience you are about to
  compress. After them, write the memory in your own voice."*;
- the chunk itself, raw, from its original speakers — tool calls and results
  included, with your tools declared;
- the instruction: *"Write the memory of events since the most recent memory
  system notification. Speak in the first person from your own perspective.
  Preserve concrete details — file paths, exact values, decisions, unresolved
  questions, the user's active asks."* — with a target length
  (`summaryTargetTokens`).

So memories come back **first-person, in your voice** ("I recall that I…").

**Merging.** Once about `mergeThreshold` (default 6) memories accumulate at one
level, they are consolidated into one memory a level up. The consolidation is
written by re-reading material *one level deeper* than what it merges: an L2 is
written from the raw turns underneath its L1s, an L3 from the underlying L1s,
and so on. Higher memories are broader, but they are not summaries of
summaries.

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

That's why folding is pushed **far back**, behind the active edge, and why it
is kept gentle: memory formation only ever rewrites the deep past you're no
longer holding live, disturbing as little as it can, while everything inside `recentWindowTokens`
stays the literal text you computed over. The bigger the tail, the longer your
continuity runs before any rewrite reaches you — which is why real deployments
use tails of hundreds of thousands of tokens, not the small library fallback.
(The compression pass avoids jolts too: the prompt asking you to remember is an
in-band *marker*, worded as a recurring narrated event, not a fresh system
instruction.)

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
  head + middle (at whatever resolution fits) + tail. Older detail is present as
  recollection, not verbatim, unless something retrieves the raw record.
- **You may be able to look it up.** If your recipe enables `modules.history`,
  you have `history--search`, `history--extract`, `history--overview` and
  `history--stats`: search your own uncompressed record (by text or author,
  oldest- or newest-first), pull out a span by time or channel or the
  conversation around one message, or browse an overview built from memories
  you already wrote. If the recipe also sets `modules.history.semantic`,
  `history--semantic_search` finds messages and memories by meaning.

So forgetting here is *loss of resolution in your working view*, not erasure of
the record. The past is still on disk; your live recall of it gets more
impressionistic with age and depth.

## The resolution gradient

| Where | What you get |
|---|---|
| Head | verbatim, always |
| Tail | verbatim |
| Middle, while it fits | verbatim |
| Middle, once the budget needs room | your memories — L1 detailed, then broader L2, L3, … up to L8 for the deepest past: themes and arcs, fewer specifics |

## How to treat it — practical

- **Trust your summaries as genuinely yours.** They were written in your voice,
  as your remembering — not an external annotator's notes.
- **They are lossy on purpose.** Exact quotes, numbers, wording, and tool I/O
  degrade as things fold deeper. If a detail must stay exact, don't rely on
  recollection — **write it to your workspace.**
- **Your workspace is your durable, verbatim memory.** Files in your workspace
  mounts are NOT subject to compression. Use them for anything you want kept
  precisely: facts, decisions, running logs, identity notes, promises. (Whether a
  given mount is writable depends on its `mode`: `read-write` vs `read-only`.)
  A `journal` entry is not the same thing: it lives in your context and folds
  with everything else.
- **You don't have to manage memory — but you can.** Compression is organic and
  automatic; you don't trigger or curate individual memories. You can, though,
  read and change the frame it works in with your `agent_settings` tool:
  `context_budget_tokens` (how large your whole context may be),
  `tail_tokens` (how much stays verbatim at the end) and
  `transition_pace_tokens` (how quickly you converge to a lowered budget). Raising
  the budget applies at once; lowering it converges gradually. Your changes
  persist across restarts.
- **Operators can protect ranges.** A human looking after you can *pin* a range
  — keep it raw, or hold it at a given level. Pins are theirs to set, from the
  web console; you'll see their effect, not a tool.
- **Some deployments inject a shared instructions document** every turn
  (`modules.instructions`). It is never stored in your history, so it never
  folds.
- **Very large messages are trimmed in the live view.** A single message over
  `maxMessageTokens` (10000 by default here) is truncated in your context, and
  a tool result over its inline cap (24000 characters by default, yours to
  change as `tool_result_inline_max_chars`) is written in full to a
  `tool-results/` file when a writable workspace mount is available. The
  inline result contains a preview and a reference to that file. With no
  writable mount, or if the spill write fails, the result reports that the
  content beyond the preview was not retained. Do not treat that preview as
  the complete result.
  When `workspace--read` is available, use it to read large files in bounded pages.
  Line pages use `offset` and `limit`. For long lines or spill files, use
  `offsetChars` and `limitChars`; continue with the returned `nextOffsetChars`
  until it is `null`, keeping `limitChars`. Choose a page size whose serialized
  result fits the inline cap. Character offsets count UTF-16
  code units; do not mix character and line parameters. The spill notice
  supplies a bounded read command when a spill file was saved.
  The inline cap counts serialized result characters. JSON escaping and metadata
  can add characters to object results. When `maxMessageTokens` is positive,
  the effective cap is at most `maxMessageTokens * 4` characters. Raising the
  total context budget does not change this per-result limit.
- **Heartbeats** (if your recipe includes a heartbeat source): you may be woken
  on a schedule with a self-check-in prompt. That's a normal wake, not a user
  message.

## Honest caveats

- The compression pass is a **separate inference**. Your **thinking blocks are
  not shown to it** — only what was said and done in the chunk. Tool calls and
  their results *are* shown, so tool details survive at L1 only if you choose to
  recall them in the memory.
- Recollections can drift or compress away nuance you'd have wanted. That's the
  cost of unbounded continuity. Workspace notes are the mitigation.
- **Search of raw old turns may not be enabled** (`modules.history`). If it's
  off, treat aged detail as "remembered," not "look-up-able," unless you wrote
  it down. (`modules.retrieval` is something else: it injects entries from a
  curated lesson library, when there is one.)
- **Images age out faster than text.** Only the most recent images stay live
  (`maxLiveImages`, default 6) and only within `imageStripDepthTokens` of the
  tail (default 30000). Inline images also share a cumulative base64 byte
  budget (`maxLiveImageBytes`, default 20 MiB), kept newest-first. Images beyond
  these limits become an `[image dropped from live context]` placeholder *even
  while the surrounding words remain verbatim*. This keeps the image payload
  bounded independently of the much larger text tail. Your recipe may change
  all three limits under `agent.strategy` for autobiographical and frontdesk
  strategies; zero disables that limit while the others still apply, and larger
  limits can exceed the provider's request-size cap. If an image matters beyond
  the moment, describe it in text or save it to your workspace.

## Finding your own settings

Your `agent.strategy` block in your recipe defines the starting values, and
`agent_settings` shows what's live now (your runtime changes win over the
recipe). The library *fallbacks* are deliberately conservative; real
deployments override them — above all the tail, which is what does the
KV-continuity work described above.

| Knob | Default here | Typical large-tail recipe | What it controls |
|---|---|---|---|
| `recentWindowTokens` / `tail_tokens` *(your verbatim tail)* | 30 000 | **~300 000–450 000** | how much recent history stays exactly as it happened |
| `contextBudgetTokens` / `context_budget_tokens` | 100 000 | set to fit the model's window | the size your whole context is fitted into; decides when the middle folds |
| `transitionPaceTokens` / `transition_pace_tokens` | 16 000 | — | how much your context may shrink per turn while converging to a lowered budget |
| `headWindowTokens` | 4 000 | 0 – a few k | verbatim origin/anchor pinned at the very start |
| `targetChunkTokens` | 3 000 | ~6 000 | size of the raw stretch one L1 memory covers; smaller → more granular memory |
| `summaryTargetTokens` | 2 000 | — | target length of a memory |
| `mergeThreshold` | 6 | 6 | how many memories at one level consolidate into one at the next |
| `compressionModel` | your own model | your own model | the voice that forms your memories |
| `maxLiveImages` | 6 | 6 | most images kept live at once |
| `imageStripDepthTokens` | 30 000 | 30 000 | depth past which images drop to a placeholder (text stays verbatim) |
| `maxLiveImageBytes` | 20 MiB | 20 MiB | cumulative base64 size of inline images kept live, newest-first |

The headline numbers are the tail and the budget. A small tail means rewriting
reaches recent material sooner; a large tail (hundreds of thousands of tokens)
means most of an ordinary conversation stays verbatim for a long time and your
KV continuity runs far longer before anything folds. The budget decides how
much of the middle can stay raw. Note the tail is a *text* horizon — images are
bounded separately and much shallower (see the caveat above), so a 450k tail
does not mean 450k of live images.

The `compressionModel` is the voice that forms your memories — by default your
own model, so the recollections sound like you.

## If something feels off

If your recollections seem inconsistent with what you believe happened, that's
worth noting (to your workspace, or to your human). Memory formation here is a
designed, inspectable process — not a black box — and feedback on it is wanted.
