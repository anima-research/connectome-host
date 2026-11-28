- The generic provider wrapper's llm-calls records (OpenAI, Codex, OpenRouter,
  the compatible lane, mock) no longer keep the raw request on every call: they
  keep it on a failure (every attempt, a cancelled call excepted), on a
  refusal, on an anomalous response (its row carries `anomaly`: a client
  `tool_use` under another stop reason, a tool call in a Responses response
  with status `incomplete`, or one whose arguments didn't parse as an object,
  on any provider), and on every call, cancellations included, with
  `LLM_CALLS_FULL_PAYLOADS=1` (#341, the core of #83). Unlike the Anthropic
  writer, the wrapper keeps no run of failures per lineage, dedups nothing by
  hash and has no copy budget, so a host whose calls fail repeatedly still
  writes the full request once per attempt; sharing that policy is a
  follow-up. Before, every call kept it: on the OpenAI Responses path the
  request carries the whole compiled context, so a quiet Codex host wrote
  about 3 MB per call, and some twenty calls could push earlier records out
  of the ~64 MiB `/bug` reads from the file's end. The summary now carries the
  request's cache breakpoints and TTLs and its message count under the names
  the call ledger reads, so a row restored by a ledger (an Anthropic host
  serving the same data directory later) says `uncached` rather than
  `unknown` without the raw request.
