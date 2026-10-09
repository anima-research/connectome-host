- Recipes can set membrane `MockAdapter`'s timing and scripted replies under
  `agent.mock`: `completeDelayMs`, `streamChunkDelayMs` (non-negative
  numbers), `streamChunkSize` (positive integer) and `responseQueue` (non-empty
  strings, returned one per provider call before the echo or
  `defaultResponse`). Offline runs can now reproduce delay-sensitive behavior
  such as event coalescing during a slow turn. Unknown keys under
  `agent.mock` join the recipe's unknown-key warning.
