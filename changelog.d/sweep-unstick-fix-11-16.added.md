- `connectome sweep unstick-fix-11-16` takes the provider's words out of the
  rewind and failed-turn notes that agent-framework 0.33.1 and earlier stored
  in an agent's context: a refusal's category in a rewind note, and the
  provider's message after "Reason:" in a failed-turn note. A rewind note
  keeps its tag and its count. A failed-turn note keeps its cause, unless the
  cause is `safety`, and its advice. Run `connectome sweep unstick-fix-11-16`
  first to see what it would rewrite and whose prompt caches a write rewrites,
  then with `--write`, once in each session of each host after the update, and
  before `/unstick` for a resident that an old note keeps stuck, since a
  rewind passes over such a note. Notes that agent-framework 0.33.2 wrote
  aren't listed, and neither is a failed-turn note whose reason is one that
  agent-framework 0.33.3 writes itself, whichever release wrote it: a compile
  that context-manager refused, a stream's abort, or a progress bound's cut.
  The sweep knows these three by its own copy of 0.33.3's shapes, so a new
  kind of reason that a later agent-framework release writes itself would be
  cut by a run of this sweep. A summary that a strategy wrote from an old note
  keeps what it says: the sweep rewrites the note, not the summary.
