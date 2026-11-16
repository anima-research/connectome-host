- **connectome-host takes agent-framework 0.33.2 or later in the 0.33 line**
  (it took 0.33.0). With it, every host gets what 0.33.1 and 0.33.2
  changed:
  - **0.33.2:** the rewind marker, `/unstick`'s give-up report and a failed
    turn's `[inference-failed]` note no longer put a provider's words where
    an agent reads them: no refusal category and no failure message. The
    note names the error's type and HTTP status when it has them, as
    before, and a safety failure's note names neither. Rows already stored
    keep their text.
  - **0.33.1:** the first start of a store that has a `gate.json` and no
    `wake-decisions.json` records the MCPL servers it is configured with as
    predating wake onboarding, and settles each as `unasked` at its first
    event, with no `[wake onboarding]` notice and no wake. On 0.33.0, a host
    updated from agent-framework 0.32.0 or earlier got that notice, and for
    an event that waits on the agent a wake, for every server whose events
    one of its catch-all rules lets by. A store that already has a
    `wake-decisions.json` is not affected. A Go back that keeps the newer
    data, to a release on agent-framework 0.33.0, drops the `unasked`
    records, and the servers recorded as predating onboarding are offered.
