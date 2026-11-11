- A recipe with `modules.instructions` at `position: "beforeUser"`, deprecated
  in 0.25.0, gets a `[deprecated]` line at start saying so and what the
  position costs (a prompt-cache miss at every compile; a tool call split from
  its result), as `modules.mcplAdmin.surface` and `conversations` do. Until now
  only the changelog and the recipe type said it.
