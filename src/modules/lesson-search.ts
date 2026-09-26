/**
 * Lexical search over lessons: one tokenizer shared by the near-duplicate
 * gate and retrieval's shortlist, plus Okapi BM25.
 *
 * Lexical search is only the shortlist for libraries too large to show the
 * relevance model whole; the semantic judgment is always the model's.
 */

import type { Lesson } from './lessons-module.js';

const STOPWORDS = new Set([
  'an', 'as', 'at', 'be', 'by', 'do', 'he', 'if', 'in', 'is', 'it', 'me', 'my',
  'no', 'of', 'on', 'or', 'so', 'to', 'up', 'us', 'we',
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'has', 'his', 'how', 'its', 'may', 'new',
  'now', 'see', 'two', 'way', 'who', 'did', 'get', 'let', 'say', 'she', 'too',
  'use', 'that', 'with', 'have', 'this', 'will', 'your', 'from', 'they', 'been',
  'were', 'when', 'what', 'which', 'their', 'there', 'than', 'then', 'them',
  'these', 'those', 'into', 'also', 'should', 'would', 'could', 'about',
]);

/** Lowercased content words (letters/digits, length >= 2, no stopwords), in order, with repeats. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 2 && !STOPWORDS.has(w));
}

export function lexicalSimilarity(a: string, b: string): number {
  const wa = new Set(tokenize(a));
  const wb = new Set(tokenize(b));
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared);
}

function lessonTokens(lesson: Lesson): string[] {
  return tokenize(`${lesson.content} ${lesson.tags.join(' ')}`);
}

const K1 = 1.2;
const B = 0.75;

/** BM25 score of every lesson against the query, in input order. Zero = no shared term. */
export function bm25Scores(query: string, lessons: Lesson[]): number[] {
  const queryTerms = [...new Set(tokenize(query))];
  const docs = lessons.map(lessonTokens);
  if (queryTerms.length === 0 || docs.length === 0) return docs.map(() => 0);

  const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / docs.length;
  const docFreq = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(doc)) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
  }

  return docs.map(doc => {
    const termFreq = new Map<string, number>();
    for (const term of doc) termFreq.set(term, (termFreq.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of queryTerms) {
      const tf = termFreq.get(term);
      if (!tf) continue;
      const df = docFreq.get(term)!;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      score += idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * doc.length / Math.max(avgLength, 1)));
    }
    return score;
  });
}
