const DEDUP_WINDOW_MS = 5_000;
const DEDUP_TTL_MS = 10_000;
const DEDUP_MAX_ENTRIES = 1_000;

type DedupNamespace = 'think' | 'commit';

interface DedupEntry<T> {
  value: T;
  timestamp: number;
}

const cache = new Map<string, DedupEntry<unknown>>();

function normalizeFingerprint(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function hashFingerprint(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function makeKey(namespace: DedupNamespace, actorKey: string, fingerprint: string): string {
  return `${namespace}:${actorKey}:${hashFingerprint(normalizeFingerprint(fingerprint))}`;
}

function prune(now = Date.now()): void {
  for (const [key, entry] of cache.entries()) {
    if (now - entry.timestamp > DEDUP_TTL_MS) {
      cache.delete(key);
    }
  }

  while (cache.size > DEDUP_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

export function getDedupedResponse<T>(namespace: DedupNamespace, actorKey: string, fingerprint: string): T | null {
  const now = Date.now();
  prune(now);

  const key = makeKey(namespace, actorKey, fingerprint);
  const entry = cache.get(key) as DedupEntry<T> | undefined;
  if (!entry) return null;
  if (now - entry.timestamp > DEDUP_WINDOW_MS) return null;

  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

export function storeDedupedResponse<T>(namespace: DedupNamespace, actorKey: string, fingerprint: string, value: T): void {
  const now = Date.now();
  prune(now);

  const key = makeKey(namespace, actorKey, fingerprint);
  if (cache.has(key)) cache.delete(key);
  cache.set(key, { value, timestamp: now });
  prune(now);
}

export function clearDedupCache(): void {
  cache.clear();
}
