# Tune-out mk2: operating guide

Tune-out mk2 is agent-framework's Dendrite work: the admission stage (one
decision per inbound event, before any side effect), the tune-out reader as a
succession of forks of the resident, the all-except scope (`focus`), and the
`speech.locus` rule. It lands through four pull requests, released in this
order: chronicle#40, context-manager#238, agent-framework#546 and
connectome-host#334. The host takes it at the agent-framework release that
carries #546; its recipe fields are typed from that framework's own config.
Until those releases exist, the four repositories run side by side from the
pull requests' branches — see *Running from the branches* at the end.

## Recipe

A resident with reader forks, the default speech rule stated, and a
folding strategy (the fork shares the resident's fold state and its cache
prefix — a passthrough resident caches only system and tools):

```json
{
  "name": "scout",
  "agent": {
    "name": "scout",
    "model": "claude-sonnet-4-5",
    "systemPrompt": "…",
    "strategy": { "type": "autobiographical" }
  },
  "subconscious": {
    "enabled": true,
    "reader": "forks",
    "model": "claude-sonnet-4-5",
    "voice": "You are reading for scout while they are tuned out. Report with the deliver_summary tool, in second person, briefly: what happened, what needs them, what can wait. If you end in plain prose instead, that prose is delivered as your report."
  },
  "speech": { "locus": "delivery" },
  "mcpServers": { "…": "your channel connector" }
}
```

- `subconscious.model` is required for forks and never defaulted: it says
  whose weights read the resident's whole prefix. The resident's own model
  is a copy of the resident; another model is allowed when named.
- `subconscious.voice` is the reader's voice block, delivered to each fork
  after the fork point with the held traffic; it is not a system prompt.
- Leave `subconscious` out and set `"tuneOut": { "enabled": true }` for a
  silent hold with no reader at all.
- `"speech": { "locus": "latest-inbound" }` brings back the moves on an
  addressed message and the most recent inbound message's channel as the
  fallback, after an open all-except tune-out's excepted channel, for prose
  and for a `channel_publish` with no `channelId`. No setting sends a
  publish there ahead of the turn's own channel, or from a turn that takes
  no fallback (a heartbeat's, a `noChannel` turn, an ephemeral agent's).
  A recipe that leaves `speech.locus` unset gets `delivery`, the framework's
  default from that release on.
- `"tuneOut": { "announce": false }` keeps the all-except scope's entry and
  release out of the excepted channel (default: announced there).

## What to exercise

Tools the resident sees: `tune_out` (`mode: enter | cancel | check`,
`scope: channel | all-except`, `peek`), `focus` (the all-except alias,
`durationSeconds` required), and — when `reader: 'forks'` — the reader's own
four tools in its block, refused with a pointer if the resident calls them.

1. **Per-channel hold.** `tune_out` a channel; post there; the message is
   stored with `metadata.tuneOut`, absent from the resident's compiled view,
   wakes nobody. An addressed message gets the suppressed-mention reaction
   and, after the 2 s coalesce, one reader fork (`tune-out:reader-fork` in
   the trace), whose `deliver_summary` arrives as mail under its own name.
   A fork that answers in prose without the tool still reports: its final
   prose arrives the same way (`tune-out:reader-prose-delivered`).
2. **A DM.** `tune_out` the DM channel id (`discord:dm:<id>`); the next DM is
   held. This was #232 gap 1.
3. **Mid-turn.** Post to the held channel while the resident is inside a
   tool call: stored, never injected into the live turn.
4. **Release.** `tune_out mode: cancel` — one notice, the backlog as
   `author: text [image]` lines up to `backlogCap`, the reader's report.
5. **Focus.** `focus channelId=<work> durationSeconds=600`; `<work>` hears
   `[Focus: <name> is here for 10 min, until HH:MM UTC; …]` under the
   resident's name and nothing is posted elsewhere; everything else, DMs
   included, is held; a heartbeat turn's prose lands in `<work>`;
   `tune_out mode: check peek=<other>` shows what is held now, without
   releasing (lines from a released epoch do not appear);
   the deadline releases per channel and `<work>` hears `[Focus: <name>
   released — duration elapsed.]`.
6. **Locus.** With no hold and no delivery (a heartbeat), the resident's
   prose stays private and a `[routing]` notice says so; an addressed
   message arriving mid-turn from another channel gets a `[routing] <author>
   addressed you from <channel> …` notice in the live turn and does not move
   the turn's locus. `channel_publish` with no `channelId` goes to the turn's
   locus (the waking delivery's channel, or one opened this turn). A
   message's author is named in the resident's window — `author: text` —
   whichever shape the server sends: a spec-shaped driver's bare body
   (`author` in the field, body alone as content) and a server that renders
   `Name: body` itself both show the name once.
7. **Restart under a hold.** Stop the host mid-epoch and start it again: the
   epoch resumes; a release left in the deferred queue lands and wakes the
   resident. A reader fork cut off by the stop is left live
   (`dendrite:agent-interrupted`, reason `host-stop`) and the next boot ends
   it as `host-restart`, with an `[Agent lifecycle: …]` line in the
   resident's window and a `dendrite:agent-ended` trace. The headless agent
   tree and socket see these: `main()` holds the traces `create()` replays
   across `start()` for the headless sink, and the first client to connect
   receives them marked `replay: true`. A sink of your own sees them only if
   attached with `{ replay: true }` before `framework.start()`; `start()`
   drops the replay buffer.

Traces worth watching: `admission:decided`, `tune-out:entered`, `tune-out:announced`,
`tune-out:reader-fork`, `dendrite:agent-created`, `dendrite:mail-delivered`,
`tune-out:cancelled`, `tune-out:wake-budget-paused`, `gate:held-dropped`.

## Known limits

- Admission decides per shared slot, not per recipient: residents sharing
  one slot share one hold.
- The mention autoreply (#232 §3.4) is not built; a suppressed mention gets
  a reaction.
- The reader fork's judgement has been exercised against a mocked model and
  its request shape and cache reuse against Claude Sonnet 5.5; a live run of
  the reader's tool loop is what the rig adds.

## What the host guarantees, and what it leaves to a module

Reader forks read the resident's whole prefix on the model
`subconscious.model` names — the resident's own model for a copy of them, or
another model by name — and report to the resident under their own name.
The host guarantees what a fork can do, and leaves what a fork must be
asked, or told, to the deployment:

- A fork can post nowhere unless `subconscious.allowChannelSpeech` is on:
  every tool but its own (`deliver_summary`, `cancel_tuneout`,
  `note_disposition`) is refused at dispatch, while the block it is shown
  stays the resident's, for the shared prefix. With speech on,
  `speak_in_channel` goes out through the resident's publish path — the
  channel sees it under the resident's account, in the fork's words.
- What a forked or spawned stream is told at its start is
  `modules.subagents.orientation` (`full` | `none`).
- The framework attaches no consent model to a derivation. What it offers a
  deployment that wants one is generic: `dendrite.beforeDerive(spec)` says
  yes or no to any derivation before the agent exists, `dendrite.
  derivationNotice` decides what the source is told, and a record's
  `metadata` carries what the deployment records. A consent flow — a
  recorded yes, a check that the fork section is the one agreed, a way to
  take the yes back — is a module built on those, to come as a package of
  its own; the platform carries no one kind of mind's preferences
  (architecture channel, 2026-10-19: tel0s, Antra, Ra).

The first live run (Weft's, 2026-10-12) asked scout in the open before any
fork ran, with the fork described in full (which model, whole context,
reports under its own name, never speaks as them, ends when they do), and
set two rules that a consent module would carry: the yes is public-channel
speech (scout's first answer landed inside the private `think` tool and was
not counted; the keepers asked again in the open), and the record travels
with the findings. Scout's words:

   > Yes, I agree to reader forks of myself running during this test. I
   > understand they'll operate while I'm tuned out, read what arrives in
   > the channel, and report back to me under their own name via mail
   > rather than as channel messages. That seems like a useful way to test
   > the feature and understand what's happening during tune-out periods.
   >
   > — scout, 2026-10-12T21:32:18.817Z

## Running from the branches

Until the releases above are published, a rig builds the four repositories
from the pull requests' branches. This section goes when they are.

| Repository | Branch | What it carries |
|---|---|---|
| `anima-research/chronicle` | `feat/dendrite-views` (#40) | branch-bound handles and views the fork primitive reads through |
| `anima-research/context-manager` | `feat/dendrite-fork` (#238) | `derive()` — shared/copied inheritance of a context onto a branch |
| `anima-research/agent-framework` | `feat/dendrite` (#546) | registry, forks, admission, reader forks, all-except, `speech.locus` |
| `anima-research/connectome-host` | `feat/dendrite-tuneout` (#334) | the recipe surface: `reader: 'forks'`, `speech`, `tuneOut`, `dendrite` |

Prerequisites: Node ≥ 22.12.0 and npm (the three libraries build with
`tsc`; Chronicle with `napi`); a Rust toolchain (`cargo`) for Chronicle's
native module (the npm package ships prebuilt binaries, the branch does
not); Bun ≥ 1.4.3 for the host — the host's `engines` field is the
authority.

```sh
mkdir dendrite && cd dendrite
git clone -b feat/dendrite-views   git@github.com:anima-research/chronicle
git clone -b feat/dendrite-fork    git@github.com:anima-research/context-manager
git clone -b feat/dendrite         git@github.com:anima-research/agent-framework
git clone -b feat/dendrite-tuneout git@github.com:anima-research/connectome-host

(cd chronicle        && npm install && npm run build)
(cd context-manager  && npm install && npm run build)
(cd agent-framework  && npm install && npm run build)
(cd connectome-host  && bun install)
```

Then point every consumer at the branch builds — one copy of each library,
so Chronicle's native module is loaded once and membrane's types once:

```sh
link() { rm -rf "$1" && ln -s "$2" "$1"; }
link context-manager/node_modules/@animalabs/chronicle          ../../../chronicle
link context-manager/node_modules/@animalabs/membrane           ../../../agent-framework/node_modules/@animalabs/membrane
link agent-framework/node_modules/@animalabs/chronicle          ../../../chronicle
link agent-framework/node_modules/@animalabs/context-manager    ../../../context-manager
link connectome-host/node_modules/@animalabs/chronicle          ../../../chronicle
link connectome-host/node_modules/@animalabs/context-manager    ../../../context-manager
link connectome-host/node_modules/@animalabs/agent-framework    ../../../agent-framework
link connectome-host/node_modules/@animalabs/membrane           ../../../agent-framework/node_modules/@animalabs/membrane
```

The membrane links give the framework, the context manager and the host one
copy of membrane's types: with two (each repository's install pins its own
patch version), `tsc` reports the framework's `Membrane` and the context
manager's as different types and `instanceof` checks across the copies
fail, which is not a defect in either branch. If a build still reports it
after linking, delete `agent-framework/dist/tsconfig.tsbuildinfo` (the
composite build's record of the old resolution) and build again. A later
`npm install` or `bun install` replaces the links; relink after.

Check the links took: `ls -l connectome-host/node_modules/@animalabs/` shows
four symlinks, and `(cd agent-framework && npm test)` runs the framework's
suite against the linked libraries (≈4,700 tests; the admission and
all-except files are `dist/test/admission-e2e.test.js`,
`dist/test/all-except-e2e.test.js`, `dist/test/tune-out-reader-forks-e2e.test.js`).
