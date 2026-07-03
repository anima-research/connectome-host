# Debug Context API

`GET /debug/context` returns the **membrane-normalized request that would be
emitted if an agent were activated right now** — without activating it. It is a
read-only window into exactly what the model would see on its next turn: the
compiled message history, the assembled system prompt, the generation config,
and the filtered tool set.

Use it to answer questions like:

- "What does the agent's context actually look like after compression?"
- "Is my system prompt / injected content showing up the way I expect?"
- "Which tools is this agent allowed to call right now?"
- "How many messages survived the context strategy's selection?"

It is served by the `webui` module over the same HTTP server as the web UI, so
it inherits that module's auth and bind configuration. If you haven't set up
`webui` yet, read [`webui-deployment.md`](./webui-deployment.md) first.

## Prerequisites

1. **`webui` is enabled** in your recipe (`"webui": true` or an object form).
2. **Auth is configured.** The default bind is `0.0.0.0`, which *requires*
   `basicAuth` — the host refuses to start otherwise. Every request to
   `/debug/context` must carry those Basic-Auth credentials. (A loopback-only
   bind, `host: "127.0.0.1"`, skips the auth requirement for local dev.)

```jsonc
// recipe.json
{
  "modules": {
    "webui": {
      "basicAuth": { "username": "${WEBUI_USER}", "password": "${WEBUI_PASS}" }
    }
  }
}
```

> **Treat the response as sensitive.** It contains the full system prompt and
> the entire compiled conversation. It is gated by the same Basic-Auth as the
> rest of the surface — don't expose it more widely than the web UI itself.

## The endpoint

```
GET /debug/context
```

| Query param   | Default        | Meaning                                                              |
|---------------|----------------|----------------------------------------------------------------------|
| `agent`       | recipe's root agent | Which agent to preview. Use a subagent's name for a child.      |
| `injections`  | *(off)*        | `1`/`true` to gather dynamic injections too. **Not transparent** — see below. |
| `pretty`      | *(off)*        | `1` to pretty-print the JSON (2-space indent).                       |

### Responses

- **`200`** — JSON body (see [Response shape](#response-shape)).
- **`404`** — `{ "error": "Agent not found: <name>" }` for an unknown `agent`.
- **`401`** — missing/wrong Basic-Auth.
- **`503`** — server up but no agent session bound yet (e.g. mid-restart).

## Transparent by default

This is the important part. By default the endpoint is **side-effect-free**:

- runs **no inference** (spends no tokens),
- writes **nothing** to Chronicle,
- contacts **no** external MCPL server.

It does only read-only work — compile the context, assemble the system prompt,
filter tools — and leaves system state exactly as it found it. You can poll it
as often as you like.

The trade-off is fidelity: the default response **omits the dynamically
gathered injections** (lessons, retrieval results, MCPL `beforeInference`
context), because gathering those is *not* free or transparent:

- module `gatherContext` can run inference — e.g. the retrieval module makes
  Haiku calls, which cost tokens and add latency;
- MCPL `beforeInference` hooks are arbitrary RPCs to external servers with
  side effects, and a preview never sends the paired `afterInference`, which
  can leave a stateful server half-open.

To opt into a byte-faithful preview that includes those injections, pass
`?injections=1` and accept the side effects. The response's `"transparent"`
field tells you which mode actually ran.

## Examples

Transparent preview of the root agent (the common case):

```sh
curl -fsSL -u "$WEBUI_USER:$WEBUI_PASS" \
  'https://admin.example.internal/debug/context?pretty=1'
```

A specific subagent:

```sh
curl -fsSL -u "$WEBUI_USER:$WEBUI_PASS" \
  'https://admin.example.internal/debug/context?agent=researcher-3&pretty=1'
```

Full-fidelity preview (spends tokens, fires MCPL hooks):

```sh
curl -fsSL -u "$WEBUI_USER:$WEBUI_PASS" \
  'https://admin.example.internal/debug/context?injections=1&pretty=1'
```

Local dev against a loopback bind (no auth needed):

```sh
curl -fsSL 'http://127.0.0.1:7340/debug/context?pretty=1'
```

### Handy `jq` recipes

```sh
BASE='https://admin.example.internal/debug/context'
AUTH=(-u "$WEBUI_USER:$WEBUI_PASS")

# Confirm the call was transparent
curl -fsS "${AUTH[@]}" "$BASE" | jq '.transparent'

# Count compiled messages and show who said what
curl -fsS "${AUTH[@]}" "$BASE" | jq '.request.messages | length'
curl -fsS "${AUTH[@]}" "$BASE" | jq -r '.request.messages[].participant'

# Read the assembled system prompt
curl -fsS "${AUTH[@]}" "$BASE" | jq -r '.request.system'

# List the tools this agent may call
curl -fsS "${AUTH[@]}" "$BASE" | jq -r '.request.tools[].name'

# Just the model + token config
curl -fsS "${AUTH[@]}" "$BASE" | jq '.request.config'
```

## Response shape

```jsonc
{
  "agent": "agent",          // the agent previewed
  "injections": false,       // whether dynamic injections were gathered
  "transparent": true,       // true => this call had no side effects
  "request": {               // the membrane NormalizedRequest
    "messages": [
      {
        "participant": "user",
        "content": [{ "type": "text", "text": "..." }],
        "cacheBreakpoint": true            // present where a cache marker was placed
      },
      { "participant": "agent", "content": [ /* ... */ ] }
    ],
    "system": "…full system prompt…",
    "config": {
      "model": "<model-id>",
      "maxTokens": 16384,
      "temperature": 0.7                    // omitted if the recipe doesn't set one
    },
    "tools": [
      { "name": "send", "description": "…", "inputSchema": { /* … */ } }
    ],
    "promptCaching": true,
    "assistantParticipant": "agent"
  }
}
```

`request` is the literal `NormalizedRequest` the membrane would receive. The
fields that matter for debugging:

- **`messages`** — the compiled history *after* the context strategy has run
  its selection/compression. This is not your raw Chronicle log; it's what
  survives into the window. A trailing `[Continue]` user message may be
  appended if the last turn was the agent's (some providers reject a trailing
  assistant message).
- **`system`** — the recipe system prompt with any `system`-position
  injections appended (only when `injections=1`).
- **`config`** — model, `maxTokens`, and `temperature` (omitted when unset).
- **`tools`** — only the tools this agent is *allowed* to use (after
  `canUseTool` filtering), or absent if it has none.

## What it does (and doesn't) mirror

The preview reuses the exact request-builder the live activation path uses
(`Agent.buildActivationRequest`), so the messages, system prompt, tool set, and
config are identical to a real turn.

With `?injections=1` it additionally mirrors the real activation's injection
gathering (module `gatherContext` + MCPL `beforeInference`), making it
byte-faithful. The one thing it never does — by design — is run the inference
itself, so there is no model output in the response.

## Troubleshooting

- **`401 Unauthorized`** — add `-u user:pass`. On the default `0.0.0.0` bind
  the endpoint always requires Basic-Auth.
- **`404 Agent not found`** — check the `agent` name. Omit the param to target
  the recipe's root agent; use the exact subagent name otherwise.
- **`503 Not ready`** — the HTTP server is up but no session is bound yet
  (common during a restart/session switch). Retry shortly.
- **`"transparent": false` when you didn't expect it** — you passed
  `injections=1` (or `injections=true`). Drop it for a side-effect-free call.
- **The response seems to be costing tokens** — only the `injections=1` path
  spends tokens. The default never does.
```
