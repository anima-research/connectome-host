- Depend on released `@animalabs/agent-framework` 0.18.0 and
  `@animalabs/context-manager` 0.11.0. kv-unified compiles no longer grow with
  the summary forest once a provider cache is relevant (CM #105/#110): on a
  production store, turn 2 went from out-of-memory at 6 GB to about 200 ms.
