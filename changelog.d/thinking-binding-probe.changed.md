- At start the host checks what the account does with a signed thinking block
  whose earlier conversation changed, for each model whose thinking binds
  (the agent's and its subagents' default): a few small requests mint a block
  and replay it under a changed system text. Where the account still shows
  the model such a block, the agent and its subagents now send their thinking
  as stored, without the drop control, instead of leaving out what a fold or a
  changed tool list invalidated: that reasoning was being lost. Where it
  refuses or drops the block, nothing changes. "Shows" is taken only on the
  Anthropic route for a model that takes the drop control, and a binding
  refusal later in the run (a gateway moving the agent to another account)
  turns the control on and sends the request again. A start at which the
  check can't tell uses what it last found on the same route, kept in
  `$DATA_DIR/thinking-binding.json`, or leaves such thinking out. Each
  model's outcome is logged as a `[thinking-binding]` line, and
  `THINKING_BINDING_PROBE=off` skips the check.
