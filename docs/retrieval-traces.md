# Retrieval Traces

The retrieval module can record a bounded, per-run explanation of automatic
lesson selection. The trace shows which concepts the selector returned, which
lessons became candidates (the whole library, or a BM25 shortlist of it), which
candidates survived relevance filtering,
and the exact lesson block injected into the next compile.

Tracing is diagnostic. It does not change selection, trigger an extra model
call, or claim access to hidden chain-of-thought.

## Prerequisites

Enable lessons, retrieval, and the Web UI in the recipe:

```json
{
  "modules": {
    "lessons": true,
    "retrieval": {
      "model": "gpt-5.4-mini",
      "maxInjected": 5,
      "reasoningEffort": "high"
    },
    "webui": {
      "host": "127.0.0.1",
      "port": 7340,
      "basicAuth": {
        "username": "${WEBUI_USER}",
        "password": "${WEBUI_PASS}"
      }
    }
  }
}
```

`reasoningEffort` accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`,
or `max`. It is optional, applies to both retrieval calls, and does not inherit
the primary agent's reasoning setting. This field is supported only when
`agent.provider` is `openai-responses` or `openai-codex`; Anthropic/Claude uses
separate native thinking controls and is rejected here rather than receiving an
invalid OpenAI-shaped request.

Retrieval remains opt-in and requires the lessons module. Depending on the
candidate count, one turn can use one selector call plus an optional relevance
call.

## Operator viewer

Open:

```text
http://127.0.0.1:7340/debug/retrieval/view
```

The viewer highlights selected lessons, lists all candidates with how they were
selected and their whole-word match provenance, summarizes the relevance decision, and
keeps the retained trace JSON behind a diagnostic disclosure. Each run is
labeled with the invoking agent name. Separate Host processes retain separate
trace stores and viewers; the endpoint does not aggregate fleet children.

## JSON endpoint

```text
GET /debug/retrieval[?limit=20][&includeInputs=1]
```

| Parameter | Default | Meaning |
|---|---:|---|
| `limit` | `20` | Newest traces to return, clamped to `1..100`. |
| `includeInputs` | off | Exact recent conversation and model-stage inputs are included only when the value is the literal `1`. |

Example envelope:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "includeInputs": false,
  "traces": []
}
```

Each trace can include:

- configured model and request-level reasoning parameters;
- recent-context hash, message count, and available message IDs;
- selector prompt, raw returned text, normalized provider blocks, parsed
  concepts, and parse mode;
- `candidateSelection` (`full-library` or `bm25`, plus the eligible count),
  every candidate, lesson snapshot, and whole-word content/tag match terms
  (informational: in `full-library` mode a candidate need not match anything);
- relevance-call output or the reason validation was skipped;
- final relevant and injected lesson IDs, exact lesson snapshots, injection
  namespace/position, and rendered `## Retrieved Knowledge` block;
- cache-hit provenance, outcome, duration, and errors.

Opaque or redacted reasoning blocks are retained only as provider-returned
content blocks. The trace does not decrypt them or present them as hidden
chain-of-thought. Each lesson snapshot is a point-in-time copy of every
`Lesson` field: `id`, `content`, `confidence`, `tags`, `evidence`, `created`,
`updated`, `deprecated`, and optional `deprecationReason`.

If retrieval is disabled, the endpoint returns `enabled: false` and an empty
trace list.

## Authentication and privacy

Both routes require password-derived operator authentication, including on a
loopback bind. Web UI Basic Auth must be configured; the routes accept either
direct valid Basic Auth or a full session created by password sign-in. A
loopback-only Web UI without configured credentials returns `401` for these two
routes, while other Web UI routes retain their historical loopback behavior.
Read-only observer cookies are rejected even when they carry the `debug` scope.

Exact recent conversation and stage inputs are omitted by default because they
can contain private text. Use `includeInputs=1` deliberately; values such as
`true` or `yes` do not enable disclosure. Lesson contents, selector output,
candidate provenance, and the final injected block remain visible in the
default trace because they are the subject of the diagnostic.

Every response from either retrieval route uses `Cache-Control: no-store`,
including authentication failures, not-yet-bound responses, and internal
errors.

## Retention and failure behavior

The retrieval module retains at most the newest 100 traces and, by default, at
most 8 MiB of UTF-8 encoded trace JSON in process memory. The limits are
enforced after every active trace mutation. When the byte budget is reached,
the oldest traces are evicted until both limits are satisfied. Traces are not
written to Chronicle and disappear when the Host restarts. Cache provenance is
rewritten when a referenced source is evicted or truncated, while each
cache-hit trace keeps its own complete selected-lesson snapshots when they fit
within the budget.

If one trace alone exceeds the byte budget, it is replaced with a small record
whose `truncation.kind` is `tombstone` and whose reason and original encoded
size make clear that the detailed payload is unavailable. Tombstones are never
presented as exact traces. Payloads that fit remain complete.

Trace recording is fail-open: metadata collection and serialization failures
must not block retrieval or the primary inference. Arbitrary provider blocks
and request-level provider parameters are converted to JSON-safe snapshots
before they are exposed. Their retained representations bound recursion depth,
total nodes, array items, object keys,
individual strings, and aggregate string bytes. When a bound applies, the
stage's `responseContentTruncation` records the explicit reason and active
limits. Cycles, BigInts, nonfinite numbers, and unreadable properties remain
safe to serialize using explicit unavailable-value records.

Viewing an existing trace is read-only. Retrieval itself still performs its
normal model calls and lesson lookup when the agent gathers context.

## Response codes

| Status | Meaning |
|---:|---|
| `200` | Viewer or trace response returned. |
| `401` | Missing operator authentication, including observer-only sessions. |
| `500` | Retrieval Trace listing failed; the response remains noncacheable. |
| `503` | Host application has not bound to the Web UI yet. |

## Troubleshooting

- `enabled: false`: enable both `modules.lessons` and `modules.retrieval`, then
  restart with the updated recipe.
- Empty `traces`: no retrieval run has completed or started since this Host
  process began.
- Many candidates but few selected lessons: expected — in `full-library` mode
  the relevance stage sees every eligible lesson. `maxInjected` is a ceiling,
  not a quota.
- A relevant lesson never appears as a candidate: the library exceeds
  `maxCandidates` and BM25 found no shared whole word with the flagged
  concepts. Raise `maxCandidates`, or add a tag using the missing vocabulary.
- `sourceTraceEvicted: true`: a cache hit refers to a run older than the
  in-memory retention window; the exact selected lesson snapshots remain on the
  cache-hit trace.
- `sourceTraceTruncated: true`: the referenced source is retained only as a
  tombstone; inspect the complete snapshots on the cache-hit trace itself.
