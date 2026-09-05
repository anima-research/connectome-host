- Depend on `@animalabs/agent-framework` ^0.12.0 and `@animalabs/membrane` ^0.5.82 —
  the published versions that implement the active-turn trigger and the
  lane-aware `dynamicHeaders` the wake-cause stamp (#113) relies on; the
  compatibility cast and optional lookup are gone, and an adapter-level test
  proves a stream call carries the origin trio while a complete call carries
  debt only.
