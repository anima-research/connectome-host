- **Recipe authors who set `engine`, `latentDemandMode` or
  `policy.ageBandSteps` under `agent.strategy.kvUnified`:** the host now
  types and validates context-manager 0.17's keys (#346). `engine` takes
  `"auto"`, `"subtree"` or `"dag"`, `latentDemandMode` takes `"individual"`
  or `"joint"`, and `policy.ageBandSteps` takes an integer from 0 to 64.
  Any other value stops the recipe loading with an error naming the key,
  where the host passed it on and context-manager read an unknown engine as
  `auto` and any mode but `"joint"` as individual ranking. Leaving a key out
  keeps context-manager's default. Keys under `kvUnified` and its `policy`
  that the host doesn't read are now named in the unknown-key warning, with
  the key each was probably meant to be.
