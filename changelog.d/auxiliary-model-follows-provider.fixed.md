- **The host's own small model calls go to a model the recipe's provider
  serves, with a request it accepts** (#649). The session name (synesthete)
  and the TUI fleet view's activity summaries, and, where the recipe names no
  model of their own, lesson retrieval, the reply judge and the gate's
  suppression review, keep their Claude Haiku defaults on the `anthropic` and
  `bedrock` routes, which serve them, and go to the resident's own model on
  every other provider; a recipe's new top-level `auxiliaryModel` names one
  for all of them. Before, naming, the summaries and retrieval were sent
  `claude-haiku-4-5-20251001`, and the judge and review agent-framework's
  `claude-haiku-5-5`, on every provider: Codex and OpenRouter refused the id,
  the callers swallowed the error, so a session on such a host was never
  named, each try left an error row in llm-calls, and retrieval injected no
  lessons. Off `anthropic` and `bedrock` the requests now carry what the route
  takes: no `temperature` (current Claude and `gpt-5`+ models refuse one), no
  Anthropic `output_config` for the judge and the review (`effort: 'none'`
  unless the recipe sets one), a low reasoning effort on the Responses-family
  routes where the host chose the model, and, where membrane sends a cap at
  all (Codex in subscription mode sends none), room for a model that reasons
  before it answers. These calls therefore now cost what the resident's model
  costs on such a host, where they cost nothing because they failed; the
  judge reads up to `modules.wake.judge.maxInputTokens` (90,000) per batch,
  retrieval runs up to twice a turn, and the fleet view's summaries run while
  it is open. `auxiliaryModel` is the way to make them cheaper. A naming call
  that fails, or answers with no name, is said once per process on stderr,
  which each runtime routes to its log: `headless.log`, `tui-error.log` or
  `readline-error.log`, the files `/bug` reads.
