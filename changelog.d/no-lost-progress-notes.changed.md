- **Agents on Fable 5/5.1, Mythos 5.1, Opus 5.5 and Sonnet 5.5:** the notes these models write between
  tool calls ("found X, checking Y next") come back as signed `thinking` blocks, empty under thinking
  display `'omitted'`, which is also what the API applies when no thinking config is sent. On these
  models (dated snapshot IDs included) the host now sends `thinking: { type: 'adaptive', display:
  'updates' }` on streamed calls through the Anthropic API (agent turns, and an MCPL server's streamed
  inference) wherever it would have left display at `'omitted'`: with reasoning off (these models think anyway), with
  `reasoning_display` set to `'omitted'`, and, with reasoning off, with a recipe's `agent.thinking.display`
  set to `'omitted'` (with reasoning on, `reasoning_display` decides). This step leaves
  one-shot `complete()` calls alone, since they make no tool calls; the reasoning setting still applies
  to them as before. Reasoning stays hidden as before, and the notes come back as text, in stores,
  logs and the web UI. A `'summarized'` config, which already returns them (mixed with reasoning
  summaries), goes as it is, and other models are unchanged. With reasoning off, a recipe's
  `agent.thinking.display` reaches the host only in the thinking config membrane builds from the
  recipe's `thinking`. Where membrane builds none, as for a display alone on Fable and Mythos, the call
  goes as `'updates'` like any other without a config, a recipe's `'summarized'` included.
  Needs membrane 0.7.0 or later, which adds the `thinking-display-updates-2026-08-18` beta that
  `'updates'` requires.
  - **Cache:** the first call after upgrading sends a thinking config where none or `'omitted'` went
    before, so the cached message prefix may be written again, once.
  - **Bedrock:** an agent on `provider: 'bedrock'` goes through `LoggingBedrockAdapter`, which
    applies none of `agent_settings`' reasoning fields, this step included: its requests carry the
    thinking config membrane builds from the recipe, as before.
- `agent_settings`' `reasoning_display` description no longer tells the agent its reasoning is lost
  to it on replay under `'omitted'`: a thinking block sent back gives the model its full reasoning
  either way, and the setting changes only what is recorded as readable text.
