- An agent whose model call failed and is being tried again, or is held
  until a provider's limit lifts, no longer shows as failed in the Web UI's
  and the TUI's agent trees. It shows `attempt-failed`, in a colour of its
  own, until its next attempt starts or its turn ends. The Web UI shows the
  failure's error when you hover over the phase, and the TUI on a fleet
  child's agent detail. A turn that ends failed shows `failed` with its last
  error; one a stop ends shows `cancelled`. A fleet parent on an earlier
  release can show a child's `attempt-failed` agent in a plain colour and
  leave it out of its count of running agents.
