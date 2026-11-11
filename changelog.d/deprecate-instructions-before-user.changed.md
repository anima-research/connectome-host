- **`modules.instructions` at `position: "beforeUser"` is deprecated.** It's
  spliced in again before the newest user message at every compile, so it
  moves: a request misses the cache from there on, and it can split a tool
  call from its result (anima-research/agent-framework#171). Use
  `"afterUser"` or `"system"`; both stay supported. The recipe type and the
  README now say what each position costs: at `"system"`, the default, an edit
  to the file misses the cache from the system prompt on; at `"afterUser"`, the
  block is placed again at each start, so it moves, and on a model that binds a
  reply's thinking to everything before it, later replies lose their thinking.
  Neither calls `"afterUser"` cache-cheap any more.
