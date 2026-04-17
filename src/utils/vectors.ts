/**
 * Tier 7: Vector embedding & cosine similarity
 * Simple TF-IDF-like embedding for decision contexts
 */

const VECTOR_DIM = 64;

/**
 * Compute embedding from decision type + context keys
 * Uses a deterministic hash-based approach
 */
export function computeEmbedding(decisionType: string, contextKeys: string[]): number[] {
  const vector = new Float64Array(VECTOR_DIM);
  const tokens = [decisionType, ...contextKeys.sort().slice(0, 10)];

  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t];
    for (let i = 0; i < VECTOR_DIM; i++) {
      let h = 0;
      for (let j = 0; j < token.length; j++) {
        h = ((h << 5) - h + token.charCodeAt(j) + i * 31 + t * 17) | 0;
      }
      vector[i] += ((h & 0x7fffffff) % 1000) / 1000;
    }
  }

  // Normalize
  let norm = 0;
  for (let i = 0; i < VECTOR_DIM; i++) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < VECTOR_DIM; i++) vector[i] /= norm;
  }

  return Array.from(vector);
}

/**
 * Cosine similarity between two vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0, normA = 0, normB = 0;

  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}
