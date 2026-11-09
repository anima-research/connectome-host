- **Dependencies:** `@animalabs/membrane` `^0.8.1` (was `^0.8.0`).
  `package-lock.json` and `bun.lock` move membrane and nothing else.
  `connectome update` keeps the running release's lockfile, so under
  `^0.8.0` an updated host would keep membrane 0.8.0. membrane 0.8.0 names
  neither Claude Fable 5.2 nor Claude Mythos 5.2, and 0.8.1 names both:
  - Its Anthropic adapter leaves a request's `temperature`, `top_p` and
    `top_k` out for both, as it does for Fable 5.1 and Mythos 5.1. 0.8.0 sent
    them on. membrane's source records that Fable 5.2 refuses a `temperature`
    of 0.2, a `top_k` of 40 and a `top_p` of 0.9 with a 400.
  - Its own cost estimate for a response prices both at $8 input, $40
    output, $10 for a cache write and $0.20 for a cache read per million
    tokens. 0.8.0 priced them as Fable 5 or Mythos 5. A prefix in its pricing
    table no longer names a model id that goes on from it with a digit.
