/**
 * Crypto utilities for Cloudflare Workers (Web Crypto API only)
 * No Node.js crypto, no Buffer
 */

/**
 * SHA-256 hash using Web Crypto API
 */
export async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate UUID v4
 */
export function uuid(): string {
  return crypto.randomUUID();
}

/**
 * Generate random hex string
 */
export function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * ISO timestamp
 */
export function now(): string {
  return new Date().toISOString();
}

/**
 * AES-256-GCM encrypt/decrypt for snapshot data
 * Uses Web Crypto API (available in CF Workers + Node 18+)
 */
async function deriveAesKey(keyStr: string): Promise<CryptoKey> {
  const keyData = new TextEncoder().encode(keyStr);
  const hash = await crypto.subtle.digest('SHA-256', keyData);
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function aesGcmEncrypt(data: string, keyStr: string): Promise<string> {
  const key = await deriveAesKey(keyStr);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(data);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

export async function aesGcmDecrypt(encoded: string, keyStr: string): Promise<string> {
  const key = await deriveAesKey(keyStr);
  const raw = atob(encoded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const iv = bytes.slice(0, 12);
  const ciphertext = bytes.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(decrypted);
}
