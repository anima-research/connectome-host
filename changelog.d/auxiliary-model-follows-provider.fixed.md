- **The host's own small model calls go to a model the recipe's provider
  serves** (#649). The session name (synesthete) and the TUI fleet view's
  activity summaries, and, where the recipe names no model of their own,
  lesson retrieval, the reply judge and the gate's suppression review, keep
  their Claude Haiku defaults on the `anthropic` and `bedrock` routes, which
  serve them, and go to the resident's own model on every other provider;
  a recipe's new top-level `auxiliaryModel` names one for all of them.
  Before, every provider was sent `claude-haiku-4-5-20251001`: Codex and
  OpenRouter refused it, the callers swallowed the error, so a session on
  such a host was never named, each try left an error row in llm-calls, and
  retrieval injected no lessons. The naming and summary requests no longer
  carry a `temperature` (current Claude and `gpt-5`+ models refuse one),
  ask a low reasoning effort on the Responses-family routes and leave a
  reasoning model room to answer within its cap. A naming call that fails,
  or answers with no name, is said once per process on stderr: the journal
  on a headless host, `tui-error.log` (what `/bug` reads) in the TUI.
- **Recipe authors:** `sessionNaming` must now be an object with `examples`
  an array of strings, and an unknown key under it is refused by name;
  `sessionNaming: null` or `examples: "x"` loaded before (the latter failed
  inside the naming call, unseen).
