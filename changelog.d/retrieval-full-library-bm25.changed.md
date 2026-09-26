- **Retrieval candidates: whole-library judgment, BM25 shortlist.** Candidate
  selection no longer uses substring matching where any one keyword was enough
  (so `the` matched almost everything and `auth` matched `author`). Up to
  `modules.retrieval.maxCandidates` (default 100) eligible lessons, the
  relevance model now sees the entire library; larger libraries are
  shortlisted by BM25 (whole words, stopwords removed, IDF-weighted). Relevance
  validation always runs — the old skip for ≤3 candidates is gone — and an
  unparseable relevance answer now injects nothing instead of the top five
  candidates, after first trying to extract a bracketed array from prose.
  Relevant lessons are injected in salience order. Traces gain
  `candidateSelection`, and match provenance is whole-word.
