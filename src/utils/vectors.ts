/**
 * Tier 7: Vector embedding & cosine similarity
 * Uses CF Workers AI for semantic embeddings (@cf/baai/bge-base-en-v1.5, 768-dim, free)
 * Falls back to token-based hashing if AI binding is unavailable
 */

export const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
export const VECTOR_DIM = 768;
export const MAX_EMBED_TEXT_CHARS = 512;
const FALLBACK_DIM = 64;

/**
 * Compute semantic embedding for a decision using CF Workers AI.
 * Falls back to token-based embedding if AI binding is not available.
 *
 * @param ai - CF Workers AI binding (env.AI), or null/undefined
 * @param text - The semantic content to embed (decision_type + outcome text)
 */
export async function computeEmbedding(ai: any, text: string): Promise<number[]> {
  const normalizedText = prepareEmbeddingText(text);

  // Try real semantic embeddings via CF Workers AI
  if (ai && typeof ai.run === 'function') {
    try {
      const result = await ai.run(EMBEDDING_MODEL, { text: [normalizedText] });
      if (result?.data?.[0] && Array.isArray(result.data[0]) && result.data[0].length >= 256) {
        return normalize(result.data[0]);
      }
    } catch (error) {
      console.error('computeEmbedding AI fallback:', error);
      // CF AI failed — fall through to token-based embedding
    }
  }

  // Fallback: token-based embedding using actual content (still better than field-name hashing)
  return tokenEmbedding(normalizedText);
}

/**
 * Token-based fallback embedding — uses the actual text content,
 * not just field names. Better than the old approach, but not semantic.
 */
function tokenEmbedding(text: string): number[] {
  const vector = new Float64Array(FALLBACK_DIM);
  const words = text.toLowerCase().split(/\s+/).slice(0, 20);

  for (let w = 0; w < words.length; w++) {
    const word = words[w];
    for (let i = 0; i < FALLBACK_DIM; i++) {
      let h = 0;
      for (let j = 0; j < word.length; j++) {
        h = ((h << 5) - h + word.charCodeAt(j) + i * 31 + w * 17) | 0;
      }
      vector[i] += ((h & 0x7fffffff) % 1000) / 1000;
    }
  }

  return normalize(Array.from(vector));
}

function prepareEmbeddingText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_EMBED_TEXT_CHARS);
}

/** L2-normalize a vector to unit length */
function normalize(vec: number[]): number[] {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  }
  return vec;
}

/**
 * Cosine similarity between two vectors.
 * Cross-dimension comparisons return 0 to avoid bogus similarity scores.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length !== b.length) {
    console.error('cosineSimilarity dimension mismatch:', { a: a.length, b: b.length });
    return 0;
  }

  const len = a.length;
  let dot = 0, normA = 0, normB = 0;

  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}
