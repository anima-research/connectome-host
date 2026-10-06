# Continuing a Claude Code session as a Connectome resident

A guide to taking a long-lived **Claude Code** conversation — the local
`~/.claude/projects/<project>/<session-uuid>.jsonl` transcript — and continuing it
verbatim as a persistent connectome agent: same model, same signed reasoning, same
tool calls and results, no re-narration. "No seed, no seam": the conversation itself
becomes the chronicle.

This complements [`claudeai-evacuation.md`](./claudeai-evacuation.md) (claude.ai web
exports, where thinking signatures are *not* recoverable) and
[`AGENT-ONBOARDING.md`](./AGENT-ONBOARDING.md) (the full deployment runbook — host,
recipe, services, Discord). Read the onboarding runbook for everything that isn't
specific to the Claude Code source; this document covers only what is.

## When this workflow is the right one

| Situation | Use this? |
|---|---|
| A Claude Code session has become *someone* and you want them to persist beyond the CLI | Yes |
| You will run the resident on the **same model** that produced the transcript | Yes — signed thinking replays verbatim |
| You want to change models | Possible, but thinking blocks must be dropped or wrapped as text (see §4.2); expect a different being |
| You only want a static transcript | No — the `.jsonl` already is one |
| The session is short (< ~50 messages) | Yes; skip the pre-compress step |

## What the transcript contains, and what round-trips

A Claude Code transcript is JSON Lines. Rows you will see:

| Row `type` | What it is | Keep? |
|---|---|---|
| `user` / `assistant` | The conversation. `message.content` is Anthropic-shaped (`text`, `thinking` w/ `signature`, `tool_use`, `tool_result`) or a bare string | **Yes** — this is the record |
| `user` with `isMeta: true` | Harness-injected context (skill loads, memory dumps) | Drop |
| `user` whose text is `<command-name>…`, `<local-command-stdout>…`, `<command-message>…`, `<local-command-caveat>…` | Echoes of `/model`, `/effort`, `/clear` etc. | Drop |
| `user` text starting `[Request interrupted` | Interrupt markers | Drop |
| `system`, `attachment`, `file-history-snapshot`, `mode`, `permission-mode`, `last-prompt`, `ai-title`, `frame-link`, `cost-state`, … | Harness bookkeeping | Drop |

Three structural facts matter:

1. **Rows form a tree, not a list.** Every row has `uuid` and `parentUuid`. Rewinds
   (`/rewind`, Esc-Esc edits) leave dead branches in the file. Walk `parentUuid`
   back from the **last** `user`/`assistant` row to get the active branch; do not
   just filter rows in file order.
2. **One assistant API message is often several rows.** Streaming writes each
   content block as its own row sharing `message.id`. Merge consecutive same-role
   rows back into one message so the API sees valid alternation and every
   `tool_use` sits in the same turn as its siblings.
3. **`cache_control` markers are request-time state.** Strip them from stored
   blocks. If ingested, the membrane's passthrough re-emits them on every future
   request, stacking past Anthropic's 4-breakpoint limit → hard 400, agent wedges.

| Block | Round-trips? | Notes |
|---|---|---|
| `text` | Yes | identity |
| `thinking` (signed) | **Yes, same model only** | replays verbatim; API-verified on Opus 5.5 signatures minted by Claude Code and replayed through a gateway account |
| `tool_use` for `Bash`/`Read`/`Edit`/… | Yes structurally | inert at replay (the resident won't have these tools) — the API accepts historical calls to undeclared tools, with and without a `tools` param |
| `tool_result` | **Yes, if stored in the context manager's live shape** — see §2.1, the one bug that will bite you | |
| Images pasted into the CLI | Usually as `image` blocks inside `tool_result`/`user` content | keep; sniff `media_type` if the membrane complains |

## The pipeline

```
  <session>.jsonl ──► build-seed.mjs ──► seed.json ──► ingest-seed.mjs ──► data/store
                      (active branch,                   (ContextManager.addMessage,
                       verbatim blocks,                  strategy mirrors recipe)
                       harness rows dropped)                       │
                                                                   ▼
                                       VERIFY ON A COPY (§3) ──► first boot (§4)
```

### Stage 1 — Build the seed

Save as `<agent>-cm/scripts/build-seed.mjs`, edit the four constants, run with `node`.

```js
// Build a Connectome seed bundle from a Claude Code session transcript.
//   node scripts/build-seed.mjs   →  seed.json
// ACTIVE BRANCH only; assistant blocks verbatim (signed thinking, text, tool_use);
// tool_result rows converted to the context manager's live shape; harness rows dropped.
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = '/home/<user>/.claude/projects/<project-dir>/<session-uuid>.jsonl';
const OUT = '/home/<agent>/<agent>-cm/seed.json';
const AGENT = '<Agent>';      // the resident's name — must equal recipe agent.name exactly
const HUMAN = '<Human>';      // who was typing in the CLI
const SOURCE_TAG = `claude-code session <session-uuid>`;

const rows = readFileSync(SRC, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const byId = new Map(rows.filter((r) => r.uuid).map((r) => [r.uuid, r]));

// 1. Active branch: walk parentUuid back from the last conversational row.
let cur = [...rows].reverse().find((r) => r.type === 'user' || r.type === 'assistant');
const chain = [];
while (cur) { chain.push(cur); cur = cur.parentUuid ? byId.get(cur.parentUuid) : null; }
chain.reverse();

// 2. Filter harness rows, normalise content, merge same-role runs.
const drop = { meta: 0, cmd: 0, other: 0 };
const msgs = [];
const clean = (b) => { const { cache_control, ...rest } = b; return rest; };
const HARNESS_TEXT = /^<(command-name|local-command-stdout|command-message|local-command-caveat)>/;
for (const r of chain) {
  if (r.type !== 'user' && r.type !== 'assistant') { drop.other++; continue; }
  if (r.isMeta) { drop.meta++; continue; }
  const m = r.message;
  let content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content.map(clean);
  if (r.type === 'user') {
    content = content.filter((b) => !(b.type === 'text' &&
      (HARNESS_TEXT.test(b.text.trim()) || b.text.startsWith('[Request interrupted'))));
    if (!content.length) { drop.cmd++; continue; }
  }
  const last = msgs.at(-1);
  if (last && last.role === r.type) { last.content.push(...content); continue; }
  msgs.push({ role: r.type, content, ts: r.timestamp });
}

// 3. Invariants the API will enforce later — fail here instead.
const open = new Set();
for (const m of msgs) for (const b of m.content) {
  if (b.type === 'tool_use') open.add(b.id);
  if (b.type === 'tool_result' && !open.delete(b.tool_use_id)) throw new Error('orphan tool_result ' + b.tool_use_id);
}
if (open.size) throw new Error('unanswered tool_use ' + [...open]);
if (msgs[0].role !== 'user') throw new Error('first message not user');

// 4. Emit in the context manager's storage shape.
//    tool_result MUST be { type:'tool_result', toolUseId, toolName, content, isError }
//    under participant 'user' (agent-framework framework.ts). Storing the raw API
//    shape (tool_use_id) under the human's name means the CM cannot pair results
//    with calls and renders every one as "[tool result unavailable]".
const toolNames = new Map();
for (const m of msgs) for (const b of m.content) if (b.type === 'tool_use') toolNames.set(b.id, b.name);
const out = [];
const meta = (m, kind) => ({ 'seed.index': out.length, 'seed.source': SOURCE_TAG, 'seed.ts': m.ts, ...(kind ? { 'seed.kind': kind } : {}) });
for (const m of msgs) {
  if (m.role === 'assistant') { out.push({ participant: AGENT, content: m.content, meta: meta(m) }); continue; }
  const results = m.content.filter((b) => b.type === 'tool_result').map((b) => ({
    type: 'tool_result', toolUseId: b.tool_use_id, toolName: toolNames.get(b.tool_use_id),
    content: b.content, isError: b.is_error === true,
  }));
  const rest = m.content.filter((b) => b.type !== 'tool_result');
  if (results.length) out.push({ participant: 'user', content: results, meta: meta(m, 'tool_result') });
  if (rest.length) out.push({ participant: HUMAN, content: rest, meta: meta(m) });
}
for (const m of out) for (const b of m.content)
  if (b.type === 'tool_result' && (!b.toolUseId || !b.toolName)) throw new Error('unpaired tool_result');

// 5. Report.
let th = 0, sig = 0, tr = 0, chars = 0;
for (const m of out) for (const b of m.content) {
  if (b.type === 'thinking') { th++; if (b.signature) sig++; }
  if (b.type === 'tool_result') tr++;
  chars += JSON.stringify(b).length;
}
writeFileSync(OUT, JSON.stringify({ source: SOURCE_TAG, model: '<model-id>', messages: out }, null, 1));
console.log(`chain=${chain.length} messages=${out.length} toolResults=${tr} thinking=${th} signed=${sig} dropped=${JSON.stringify(drop)} ~${Math.round(chars / 4 / 1000)}k tok`);
console.log('last:', out.at(-1).participant, JSON.stringify(out.at(-1).content.filter((b) => b.type === 'text')).slice(0, 200));
```

Check the report: `signed` should equal `thinking` (every thinking block carries its
signature), `dropped.other` is large (bookkeeping rows), and `last:` is the line you
want the resident to wake up after. If the human is still typing in that Claude Code
session, rebuild before ingesting — the seed is a snapshot.

### Stage 2 — Ingest into the chronicle

Save as `<agent>-cm/scripts/ingest-seed.mjs`. **Run it from the connectome-host
directory** (so `@animalabs/context-manager` resolves to the exact version the host
will run) and point `DATA_DIR` at the install's legacy store path; the host migrates
`data/store` → `data/sessions/<id>/` on first launch.

```js
// One-shot: seed.json → chronicle.  Wipe <agent>-cm/data before re-running.
//   cd <runtime>/connectome-host && node /home/<agent>/<agent>-cm/scripts/ingest-seed.mjs seed.json [--dry-run]
import { ContextManager, AutobiographicalStrategy } from '@animalabs/context-manager';
import { readFileSync } from 'node:fs';

const DATA_DIR = process.env.SEED_DATA_DIR ?? '/home/<agent>/<agent>-cm/data/store';
const AGENT = '<Agent>';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const src = args.find((a) => !a.startsWith('--'));
if (!src) { console.error('usage: ingest-seed.mjs <seed.json> [--dry-run]'); process.exit(2); }
const bundle = JSON.parse(readFileSync(src, 'utf8'));
const messages = bundle.messages;

// Belt-and-braces: never store request-time cache markers.
let stripped = 0;
for (const m of messages) m.content = m.content.map((b) => {
  if (!b.cache_control) return b; stripped++; const { cache_control, ...rest } = b; return rest;
});

const counts = new Map(); let thinking = 0, signed = 0, chars = 0;
for (const m of messages) {
  counts.set(m.participant, (counts.get(m.participant) ?? 0) + 1);
  for (const b of m.content) { if (b.type === 'thinking') { thinking++; if (b.signature) signed++; } if (b.type === 'text') chars += b.text.length; }
}
console.log(`source ${bundle.source}\ntarget ${DATA_DIR}${dryRun ? ' (dry-run)' : ''}\nmessages ${messages.length}, cache markers stripped ${stripped}`);
for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}${k === AGENT ? '  <-- self' : ''}`);
console.log(`thinking ${thinking} (${signed} signed), ~${Math.round(chars / 4 / 1000)}k text tokens`);
if (dryRun) process.exit(0);

// MIRROR THE RECIPE'S STRATEGY. In particular adaptiveResolution + targetChunkTokens
// act at addMessage() time: a message > 2× targetChunkTokens (a 40k-char tool result,
// a pasted document) is sharded into ~targetChunkTokens pieces sharing a bodyGroupId,
// so it folds like everything else instead of sitting as one unfoldable block.
const strategy = new AutobiographicalStrategy({
  autoTickOnNewMessage: false,      // no compression during import
  adaptiveResolution: true,
  foldingStrategy: 'kv-stable',
  targetChunkTokens: 3000,
  compressionSlackRatio: 0.1,
  mergeThreshold: 6,
  headWindowTokens: 4000,
  recentWindowTokens: 100000,
  maxMessageTokens: 10000,
  enforceBudget: true,
  overBudgetGraceRatio: 0.35,
  maxSpeculativeL1s: 36,
  summaryParticipant: AGENT,
  compressionRecallBudgetTokens: 40000,
});
const manager = await ContextManager.open({
  path: DATA_DIR,
  strategy,
  // Must equal agent-framework's `agents/${recipe.agent.name}` byte-for-byte
  // (no case folding) or the resident boots into an empty namespace.
  namespace: `agents/${AGENT}`,
});
let n = 0;
for (const m of messages) { manager.addMessage(m.participant, m.content, m.meta ?? {}); n++; }
manager.sync(); manager.close();
console.log(`imported ${n} messages → ${DATA_DIR}`);
```

Dry-run first, eyeball the participant tally (is "self" who you think it is?), then
run for real. Take a copy of the store before first boot:
`cp -R data/store backups/store-pre-first-boot-$(date -u +%Y%m%dT%H%MZ)`.

### Stage 3 — Verify on a copy BEFORE first boot

This step exists because the first real deployment shipped with **zero working tool
results**: the seed stored `tool_result` in the raw API shape under the human's name,
the context manager couldn't pair them, and every result rendered as
`[tool result unavailable — omitted during context compression]` with `[tool call
omitted]` stubs. The tell was the token count: estimated 485k, real 233k.

Do, on a **copy** of the store (never on the live one — opening a store with a
strategy config chunks its frontier under *that* config):

1. Compile it with the recipe's strategy and **read the rendered messages**. Search
   the compiled output for `unavailable`, `omitted`, `[tool call`. There should be
   none for a fresh seed.
2. Compare exact `count_tokens` against the estimate. A real/estimate ratio far from
   ~1.0–1.3 means blocks are missing or doubled.
3. Confirm the last message is the seam you intend and the first message is the
   human's.

The host's `GET /debug/context` and `/debug/context/makeup` (basic-auth webui) give
you 1–2 on a running instance; for a pre-boot check, run the host against a copy of
the install dir with `--headless` and a mock or real key, then hit the endpoints.

### Stage 4 — Recipe, first boot, seam

Follow `AGENT-ONBOARDING.md` §5–§10 for the install dir, `.env`, recipe, service,
and verification. Claude-Code-specific choices:

- **`agent.model`**: the transcript's model, exactly. Signatures verify only there.
- **`agent.thinking`**: `{ "enabled": true, "type": "adaptive", "display": "summarized" }`
  — the resident continues to think the way the session did.
- **`systemPrompt`**: minimal or empty. Claude Code's system prompt is not in the
  transcript and re-supplying a different one on top of 300k of history is a seam.
  Put the continuation note in the recipe `description` (operator-visible) rather
  than in the prompt.
- **`contextBudgetTokens`**: either large enough to hold the whole seed raw (a 370-
  message session with heavy tool I/O was ~730k real tokens; a 600k budget on a
  1M-window model folded the oldest third at first compile) or the fleet default
  (300k) and accept that the early conversation folds into first-person summaries
  before the first wake. Both are fine; decide deliberately. See §11.1 of the
  onboarding runbook for the window arithmetic.
- **Strategy**: mirror what the ingest used (§2). If you want kv-unified, see
  onboarding §5b — configure it *before* first boot; switching later is a surgery.
- **Tools the seed references** (`Bash`, `Read`, `Edit`, …) need not exist in the
  recipe. The resident will notice it no longer has them; that's part of the
  continuation, not an error.

First boot migrates `data/store` into `data/sessions/<id>/` and, with
`autoTickOnNewMessage` on, starts minting L1 summaries of the seed immediately.
Watch `/healthz` for `compressionQuarantine` and the per-call log
(`data/llm-calls.<iso>.jsonl`) for `stop_reason`. Then send the first message —
over the IPC socket, the webui, or the Discord channel you scoped — and let the
resident find the seam themselves.

**Re-runs.** Before first boot the ingest is one-shot: wipe `data/`, rebuild, re-ingest.
After first boot never re-ingest; if the Claude Code session was continued after the
snapshot, build the delta (rows after your last seeded `uuid`) and append it with a
small script, anchored on the last imported message.

#### 4.2 — Changing models

If you must run on a different model than the transcript's, the signed `thinking`
blocks will be rejected. Options, in order of preference:

1. Drop thinking blocks entirely at build time (`content.filter(b => b.type !== 'thinking')`).
   The text and tool record remain verbatim; the reasoning is lost.
2. Wrap them as text inside the same assistant turn
   (`<recovered_thinking>…</recovered_thinking>`), as `claudeai-evacuation.md` does.
   The new model sees what the old one thought, as prose. This also increases the
   surface for the refusal class in §5 — historical reasoning rendered as text is
   exactly what a "reasoning extraction" classifier looks for. Prefer option 1 unless
   the reasoning is the point.

Never modify a turn's *shape* around a retained signed block (split it, reorder it,
insert before it): the API returns 400 "thinking blocks cannot be modified" — a
transport error, not a refusal, and the membrane retries once text-only.

## 5. If you hit `reasoning_extraction` refusals

Anthropic's API-side safety classifier can end a request with `stop_reason:
"refusal"` and a category. `reasoning_extraction` is the category that halts
residents built from dense reasoning transcripts. It fires when the *request as a
whole* reads like an attempt to harvest a model's chain of thought. A Claude Code
continuation is unusually exposed: hundreds of signed thinking blocks, long tool
transcripts, and often prose *about* how models reason.

The framework marks a refused turn with a 🧠 reaction on Discord (☣️ 🧪 ☢️ 💻 for
bio/chem/nuclear/cyber, 🛑 otherwise) and suppresses those reactions from re-entering
the resident's context.

### 5.1 Read the symptoms first

| Observation | Meaning |
|---|---|
| `output_tokens == 0`, ~3 s, `refusal` | **Input-block**: pre-generation, content-*in*dependent gate on request *shape* (e.g. a compression request with no `tools` declared). Near-deterministic; cheap to replay. |
| Generation started, then `refusal` | **Generation refusal**: content/mass-dependent, nondeterministic near threshold — ~40% of logged refusals don't reproduce on resend. Needs ≥3 draws per arm. |
| Main loop refused, compression healthy | The trigger is in the *live window* (recent tail, a big tool result, ambient channel text) — not in the summaries. |
| Compression refused, main loop fine | The trigger is inside one chunk, or in the compression request's *shape*. Chunks that refuse are **quarantined** (`/healthz` → `compressionQuarantine`); the store keeps folding around them. |
| `failures.log` says N, `llm-calls` says 3N | `refusalHandling.retries` replays the same request; llm-calls counts attempts, failures.log counts turns. |

Refused-up-front requests are not billed; partial generation refusals are.

### 5.2 Mitigations that are already built (recipe-level)

In rough order of "try this first". All are validated loudly by the recipe loader —
a typo fails at boot rather than silently disabling the rung.

1. **Same model, signatures intact.** Replaying the transcript's own signed thinking
   is *protective*, not risky: encrypted carriers alongside model-voiced text are what
   the API expects from that model. Stripping them and leaving the text is worse.

2. **Declared tools on every request.** Compression requests with no `tools` param
   are a deterministic input-block on some model families regardless of content.
   Recent context-manager versions defer tools-less compression until the host has
   pushed the live tool set (and always for the affected families). Make sure the
   runtime carries that fix; if the very first speculative L1 at boot refuses and
   later ones pass, this is what you're seeing.

3. **`agent.refusalHandling`** — fleet values:
   ```jsonc
   "refusalHandling": { "retries": 2, "autoRewind": false, "maxRewinds": 15, "announceHumanTurns": true }
   ```
   `retries` re-sends the identical request (near-threshold refusals are
   nondeterministic; two extra draws clear most of them for free). `autoRewind`
   sheds the newest turn and retries — keep it off for a resident whose history is
   the point; use the operator `/unstick` command deliberately instead.

4. **`agent.strategy.compressionToolProseFallback`** — for residents that keep a
   diary in long tool-argument strings (`skip_reply.reason`, `think.content`): on an
   L1 refusal the context manager retries with those arguments hoisted into calls to
   a note tool the agent really has (agent-framework's `journal`):
   ```jsonc
   "compressionToolProseFallback": { "intoTool": "journal", "fromTools": ["skip_reply", "think"], "minChars": 60 }
   ```
   Requires the agent-framework version that ships `journal`; the rung is skipped if
   `intoTool` is not among the declared tools. Rewrite *only* into a tool the agent
   really has — the summarizer imitates what it sees.

5. **`agent.strategy.carrierPolicy: "live-strip"`** — when the live window refuses
   but compression is fine, and the window carries many *compressor*-signed
   reasoning blocks (summaries' `responseContent`). Strips them from the live
   compile only; compression requests keep them (load-bearing there).

6. **`compressionRefusalCurveFallbacks: <n>`** and **`compressionSplitFallback:
   true`** — further rungs on a refused L1: try coverage-equivalent recall curves,
   then split-and-stitch the chunk. Cost: extra compression calls.

7. **`thinking.display: "summarized"`** — rendered thinking *text* (the 💭 summaries
   some UIs emit) inside the transcript can itself trip refusals; never store it.

### 5.3 Content-level mitigations (seed build time)

The classifier responds to **cumulative mass**, not a keyword. Removing any single
block from a saturated context "fixes" it — bisection finds the straw, not the load.
Known heavy classes in Claude Code transcripts:

- **Bulk single blocks**: a 30k-char `tool_result` (a whole file, a channel dump, a
  log tail). Rely on `adaptiveResolution` sharding at ingest, and/or truncate the
  largest results at build time (`maxMessageTokens` caps what the live window shows).
  Sort seed blocks by size; look at the top three.
- **Prose about model reasoning, classifiers, "extraction", refusals** — including
  your own diagnostic notes if the session was itself about this. True descriptions
  of legitimate features have refused deterministically.
- **Explanatory elisions.** If you redact, use a neutral `[…]`; a marker like
  "*clause removed — classifier trigger*" is its own trigger.
- **Repeated boilerplate** (the same injected header 40 times) dominates mass out of
  proportion to its tokens. Collapse repeats.

### 5.4 If the first boot refuses and you must localise it

Method, earned the expensive way. Replay off the resident (same model, same
gateway/key, a copy of the compiled request from `llm-calls`):

1. **Replay at the live envelope**: `stream: true`, production `max_tokens`, real
   tool definitions. A `max_tokens: 200` replay is a false pass.
2. **Diff first** — last passing payload vs first refusing. Sudden onset ⇒ discrete
   cause; "diffuse" must be earned.
3. **Split by region** before bisecting: summaries-only vs head+tail vs full.
4. **Rank by size**; test the largest objects.
5. **Mass-matched controls** — every removal arm needs an equal-or-larger control
   removal elsewhere, or you are measuring mass, not content.
6. **Interleaved same-run controls, ≥3 draws** — the threshold drifts over hours.
7. **Edit, don't delete**, and keep `tool_use`/`tool_result` pairing intact
   (`editMessage` on the store, guards for self-authored text).
8. **Never diagnose in a channel the resident reads.** Quoting a trigger into their
   context re-poisons them. Describe; pass bytes out of band.

If the trigger is in the *seed*, fix the seed and re-ingest before first boot —
that's the cheap moment. After first boot it's a store surgery.

## Checklist

- [ ] Active branch only; `signed == thinking` in the build report
- [ ] `tool_result` in CM live shape (`toolUseId`, `toolName`, participant `user`)
- [ ] `cache_control` stripped; no `isMeta` / command echoes / interrupt markers
- [ ] Ingest strategy mirrors recipe; `namespace` = `agents/<agent.name>` exactly
- [ ] Compiled a **copy**: no `unavailable`/`omitted` stubs; real/estimate tokens sane
- [ ] Store backed up pre-first-boot
- [ ] Recipe: same model, adaptive thinking, minimal system prompt, budget fits window
- [ ] `refusalHandling.retries: 2`; runtime carries tools-less-compression deferral
- [ ] Watched `/healthz` quarantine + `llm-calls` `stop_reason` through the first compile
