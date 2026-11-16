- `connectome sweep unstick-fix-11-16` takes the provider's words out of the
  rewind and failed-turn notes that agent-framework 0.33.1 and earlier stored
  in an agent's context: a refusal's category in a rewind note, and the
  provider's message after "Reason:" in a failed-turn note. It rewrites each
  such note as agent-framework 0.33.2 writes it. A rewind note keeps its tag
  and its count. A failed-turn note keeps its cause, unless the cause is
  `safety`, and its advice. Run `connectome sweep unstick-fix-11-16 --write`
  once on each host after the update, and before `/unstick` for a resident
  that an old note keeps stuck, since a rewind passes over such a note. Notes that agent-framework 0.33.2 wrote
  aren't listed. A summary that a strategy wrote from an old note keeps what
  it says: the sweep rewrites the note, not the summary.
