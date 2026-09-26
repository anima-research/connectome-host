- **Lessons: near-duplicate gate, supersession, usage strength, and no-loss
  edits.** `create` now refuses content that closely restates a live lesson
  (content-word Jaccard ≥ 0.5), listing the matches so the agent can
  `supersedes: [ids]` (old lessons are deprecated and linked, not deleted),
  `update`, or `force: true`. RetrievalModule records every fresh injection;
  an FSRS-shaped spacing rule turns that into a per-lesson stability, and
  candidates are ranked by confidence discounted by at most half for disuse.
  Usage only changes ranking — it never hides or deletes a lesson. `update`
  keeps prior wording in `previousContents`, and `query` gains
  `includeDeprecated` for searching the archive. All new fields are optional,
  so existing lesson stores load unchanged.
