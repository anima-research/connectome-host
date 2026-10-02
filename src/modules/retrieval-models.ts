/**
 * Local models for lesson retrieval, run in-process through node-llama-cpp
 * (Metal / CUDA / Vulkan / CPU, chosen automatically).
 *
 *   - Qwen3-Embedding-0.6B: dense first-stage search
 *   - Qwen3-Reranker-0.6B: pointwise relevance, P(yes) in [0, 1]
 *
 * GGUF files are downloaded from Hugging Face on first use into
 * CONNECTOME_MODELS_DIR (default ~/.cache/connectome-host/models), ~1.3 GB.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Llama, LlamaEmbeddingContext, LlamaRankingContext } from 'node-llama-cpp';

/** What RetrievalModule needs from its models; tests substitute a fake. */
export interface RetrievalModels {
  readonly embeddingModel: string;
  readonly rerankerModel: string;
  /** Unit-normalized embeddings. Queries get the retrieval instruction; documents are embedded raw. */
  embed(texts: string[], kind: 'query' | 'document'): Promise<Float32Array[]>;
  /** Relevance of each document to the query, in [0, 1], in input order. */
  rerank(query: string, documents: string[]): Promise<number[]>;
  dispose(): Promise<void>;
}

export const EMBEDDING_MODEL_URI = 'hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf';
export const RERANKER_MODEL_URI = 'hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf';

const EMBEDDING_INSTRUCTION =
  "Given recent conversation from an AI agent's session, retrieve lessons the agent learned earlier that bear on it";

const RERANK_INSTRUCTION =
  "Given recent conversation from an AI agent's session, judge whether this lesson the agent learned earlier "
  + 'would help it with what is being discussed now';

// Qwen3-Reranker's built-in template with the web-search instruction replaced.
const RERANK_TEMPLATE =
  '<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. '
  + 'Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n'
  + `<Instruct>: ${RERANK_INSTRUCTION}\n<Query>: {{query}}\n<Document>: {{document}}<|im_end|>\n`
  + '<|im_start|>assistant\n<think>\n\n</think>\n\n' as `${string}{{query}}${string}{{document}}${string}`;

/** Token budgets; RetrievalModule caps its inputs well below these. */
const EMBEDDING_CONTEXT = 2048;
const RERANK_CONTEXT = 2048;

export function defaultModelsDir(): string {
  return process.env.CONNECTOME_MODELS_DIR ?? join(homedir(), '.cache', 'connectome-host', 'models');
}

interface Loaded {
  llama: Llama;
  embedding: LlamaEmbeddingContext;
  ranking: LlamaRankingContext;
}

export class LlamaRetrievalModels implements RetrievalModels {
  readonly embeddingModel = EMBEDDING_MODEL_URI;
  readonly rerankerModel = RERANKER_MODEL_URI;
  private loaded: Promise<Loaded> | null = null;

  constructor(private readonly modelsDir: string = defaultModelsDir()) {}

  /** Start downloading/loading without waiting; the first embed/rerank awaits it. */
  prepare(): Promise<void> {
    return this.load().then(() => undefined);
  }

  private load(): Promise<Loaded> {
    this.loaded ??= (async () => {
      const { getLlama, resolveModelFile } = await import('node-llama-cpp');
      const [embeddingPath, rerankerPath] = [
        await resolveModelFile(EMBEDDING_MODEL_URI, { directory: this.modelsDir, cli: false }),
        await resolveModelFile(RERANKER_MODEL_URI, { directory: this.modelsDir, cli: false }),
      ];
      const llama = await getLlama();
      const embedding = await (await llama.loadModel({ modelPath: embeddingPath }))
        .createEmbeddingContext({ contextSize: EMBEDDING_CONTEXT });
      const ranking = await (await llama.loadModel({ modelPath: rerankerPath }))
        .createRankingContext({ contextSize: RERANK_CONTEXT, template: RERANK_TEMPLATE });
      return { llama, embedding, ranking };
    })();
    return this.loaded;
  }

  async embed(texts: string[], kind: 'query' | 'document'): Promise<Float32Array[]> {
    const { embedding } = await this.load();
    const vectors: Float32Array[] = [];
    // One context evaluates one sequence at a time; sequential is as fast as Promise.all here.
    for (const text of texts) {
      const input = kind === 'query' ? `Instruct: ${EMBEDDING_INSTRUCTION}\nQuery: ${text}` : text;
      vectors.push(normalize((await embedding.getEmbeddingFor(input)).vector));
    }
    return vectors;
  }

  async rerank(query: string, documents: string[]): Promise<number[]> {
    const { ranking } = await this.load();
    return ranking.rankAll(query, documents);
  }

  async dispose(): Promise<void> {
    if (!this.loaded) return;
    const { llama } = await this.loaded;
    await llama.dispose();
  }
}

function normalize(vector: readonly number[]): Float32Array {
  let norm = 0;
  for (const x of vector) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) throw new Error('embedding model returned a zero vector');
  return Float32Array.from(vector, x => x / norm);
}

export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
