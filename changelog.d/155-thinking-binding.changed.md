- **Agents on a model whose signed thinking binds** (Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5,
  and, as the host records them, the Mythos models and any later Claude model its record doesn't name): the
  host now records per model whether its thinking binds, whether it takes `block_binding`'s
  `drop_block` control, whether it thinks with no thinking config, and whether the provider's refusal of a longer prompt
  showed its context window, and passes agent-framework `thinkingBinding` from that record, and
  `physicalWindowTokens` from the model limits table where it did, for the resident and each
  subagent (anima-research/context-manager#155).
  - **The drop control:** on the four models that take it, streamed calls through the Anthropic API
    (agent turns) carry `block_binding: { prefix_mismatch_behavior: 'drop_block' }` in their
    thinking config, so the provider drops a signed thinking block that a change has invalidated
    instead of refusing the call. An adaptive or enabled thinking config a call already has keeps
    its fields and gains the control, unless it carries a binding control of its own: with
    reasoning on that's the setting's, and with it off, the one membrane builds from a recipe's
    `agent.thinking`, if any. A call with none is sent `{ type: 'adaptive',
    display: 'omitted' }` with the control, which goes as `'updates'` on Fable 5.1, Opus 5.5 and
    Sonnet 5.5. One-shot `complete()` calls get no control.
  - **The window:** those four get `physicalWindowTokens` on the Anthropic route, at the
    1,000,000 tokens the model limits table holds for each, under its id or a dated snapshot of it.
    With binding and a window both set, agent-framework doesn't break a turn's stream at
    `maxStreamTokens`, a recipe's or `/budget`'s: such an agent's stream breaks mid-turn for its
    size only where its next request would pass the window, and a fresh compile carries the turn
    on. `/budget` says so: its listing marks each such agent, and setting a budget names them.
  - **The system prompt:** on a binding model it ends with one more paragraph: "When your context
    folds, the reasoning behind your earlier replies leaves it, though their words stay, so a reply
    of yours that shows no reasoning may still have had some." An empty prompt gets it as its whole
    system text. No agent under an `anthropic-xml` recipe gets it: every agent there sends in XML
    mode, whose transcript carries none of a reply's reasoning into the next request, fold or none.
    On the binding models named above, such a recipe's agents can't run at all, since membrane
    refuses their assistant prefill.
  - **Bedrock and the other routes:** an agent there on a binding model binds without the control
    and has no window, since nobody has tried the control or read a window there.
    `LoggingBedrockAdapter` adds no control, as before.
- **Haiku 5.5 with reasoning on:** the host now sends it the reasoning setting's adaptive thinking
  config, as on the other 5.5 models. Before, `modelAcceptsAdaptiveThinking` didn't list it, so
  turning reasoning on for a Haiku 5.5 agent sent nothing and logged that the model "does not accept
  adaptive thinking", though it takes the config. As on every model the setting reaches, one-shot
  calls on Haiku 5.5 (its compression, and retrieval where a recipe sets that model) carry the
  setting's config too.
