- **Lesson retrieval runs local models; the LLM retrieval path is removed.**
  `modules.retrieval` no longer calls a retrieval LLM (default Haiku). Each run
  searches the lesson library with several short queries from the recent
  conversation (BM25 + Qwen3-Embedding-0.6B, merged by reciprocal rank
  fusion), then Qwen3-Reranker-0.6B scores the top `maxCandidates` (default
  16) against the conversation tail; lessons scoring ≥ `relevanceThreshold`
  (default 0.3) are injected in salience order. Models run in-process via
  `node-llama-cpp` (Metal / CUDA / Vulkan / CPU) and are downloaded on first
  use (~1.3 GB) to `CONNECTOME_MODELS_DIR` (default
  `~/.cache/connectome-host/models`); ~0.65 s per turn measured on an M5 Mac.
  **Breaking:** recipes setting `modules.retrieval.model`, `reasoningEffort`,
  or `reasoningContext` now fail at load with a migration message — delete
  those keys. Retrieval traces move to schema version 2: `conceptExtraction`,
  `relevance`, and provider-block snapshots are replaced by `queries`,
  `rerankQuery`, and per-candidate `rerankScore` / `fusedScore` /
  `lexicalRank` / `denseRank`. `scripts/retrieval-calibration/` re-derives the
  threshold from labelled turns.
