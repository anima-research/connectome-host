- A recipe with `modules.instructions` at `position: "beforeUser"`, deprecated
  in 0.25.0, gets a `[deprecated]` line at start saying so and what the
  position costs (a request rebuilt mid-turn can put the block between a tool
  call and its result; it moves as `"afterUser"` does, missing the prompt cache
  whenever a newer user message arrives), as `modules.mcplAdmin.surface` and
  `conversations` do. Until now the README, the changelog and the recipe type
  said so, but startup didn't.
