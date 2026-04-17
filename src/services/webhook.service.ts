/**
 * Webhook Service — delivery with 3x retry + exponential backoff
 * Deactivates after 3 consecutive failures
 */
import { uuid, now } from '../utils/crypto';

// H3 fix: AES-GCM encryption for webhook secrets at rest
async function encryptSecret(plaintext: string, encryptionKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = new Uint8Array(encryptionKey.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  const key = await crypto.subtle.importKey('raw', keyData, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext));
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  return btoa(String.fromCharCode(...combined));
}

async function decryptSecret(ciphertext: string, encryptionKey: string): Promise<string> {
  const combined = new Uint8Array(atob(ciphertext).split('').map(c => c.charCodeAt(0)));
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);
  const keyData = new Uint8Array(encryptionKey.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  const key = await crypto.subtle.importKey('raw', keyData, 'AES-GCM', false, ['decrypt']);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(decrypted);
}

interface Webhook {
  id: string;
  account_id: string;
  url: string;
  secret: string;
  decision_types: string | null;
  active: number;
  consecutive_failures: number;
  created_at: string;
}

interface WebhookPayload {
  event: string;
  decision_type: string;
  pattern?: string;
  confidence?: number;
  timestamp: string;
}

const MAX_CONSECUTIVE_FAILURES = 3;

const BLOCKED_HOSTS = [
  'localhost', '127.0.0.1', '0.0.0.0', '169.254.169.254',
  'metadata.google.internal', 'metadata.google',
];
const BLOCKED_PREFIXES = ['10.', '172.16.', '172.17.', '172.18.', '172.19.', '172.20.', '172.21.', '172.22.', '172.23.', '172.24.', '172.25.', '172.26.', '172.27.', '172.28.', '172.29.', '172.30.', '172.31.', '192.168.', '169.254.'];

function isBlockedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (BLOCKED_HOSTS.includes(host)) return true;
    if (BLOCKED_PREFIXES.some(p => host.startsWith(p))) return true;
    // IPv6 loopback and IPv4-mapped IPv6
    if (host === '[::1]' || host === '::1') return true;
    if (host.includes('::ffff:')) return true;
    if (host.startsWith('[') && host.includes(':')) return true; // Block all IPv6 literals
    if (parsed.protocol !== 'https:') return true; // HTTPS only
    return false;
  } catch { return true; }
}

export class WebhookService {
  constructor(private db: D1Database, private encryptionKey?: string) {}

  async create(accountId: string, url: string, secret: string, decisionTypes?: string[]): Promise<Webhook> {
    if (url.length > 500) throw new Error('Webhook URL max 500 characters');
    if (isBlockedUrl(url)) throw new Error('Webhook URL not allowed: internal/private addresses blocked');
    const id = uuid();
    const ts = now();
    // H3 fix: encrypt webhook secret before storing
    const storedSecret = this.encryptionKey ? await encryptSecret(secret, this.encryptionKey) : secret;
    await this.db
      .prepare('INSERT INTO webhooks (id, account_id, url, secret, decision_types, active, consecutive_failures, created_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?)')
      .bind(id, accountId, url, storedSecret, decisionTypes ? JSON.stringify(decisionTypes) : null, ts)
      .run();
    return { id, account_id: accountId, url, secret, decision_types: decisionTypes ? JSON.stringify(decisionTypes) : null, active: 1, consecutive_failures: 0, created_at: ts };
  }

  async list(accountId: string): Promise<Webhook[]> {
    const res = await this.db
      .prepare('SELECT * FROM webhooks WHERE account_id = ? ORDER BY created_at DESC')
      .bind(accountId)
      .all<Webhook>();
    return res.results || [];
  }

  async delete(id: string, accountId: string): Promise<boolean> {
    const res = await this.db
      .prepare('DELETE FROM webhooks WHERE id = ? AND account_id = ?')
      .bind(id, accountId)
      .run();
    return (res.meta?.changes ?? 0) > 0;
  }

  /**
   * Find matching webhooks for a decision type and deliver payload
   */
  async deliverToSubscribers(decisionType: string, payload: WebhookPayload): Promise<number> {
    const hooks = await this.db
      .prepare('SELECT * FROM webhooks WHERE active = 1')
      .all<Webhook>();

    let delivered = 0;
    for (const hook of (hooks.results || [])) {
      // Check if webhook subscribes to this decision type
      if (hook.decision_types) {
        try {
          const types = JSON.parse(hook.decision_types) as string[];
          if (!types.includes(decisionType)) continue;
        } catch { continue; }
      }

      const success = await this.deliver(hook, payload);
      if (success) delivered++;
    }
    return delivered;
  }

  private async deliver(hook: Webhook, payload: WebhookPayload): Promise<boolean> {
    const body = JSON.stringify(payload);
    const delays = [0, 1000, 5000]; // 3 attempts: immediate, 1s, 5s

    // H3 fix: decrypt webhook secret before sending
    let plainSecret: string;
    try {
      plainSecret = this.encryptionKey ? await decryptSecret(hook.secret, this.encryptionKey) : hook.secret;
    } catch {
      // If decryption fails (e.g. legacy plaintext secret), use as-is
      plainSecret = hook.secret;
    }

    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt] > 0) {
        await new Promise(r => setTimeout(r, delays[attempt]));
      }

      try {
        const res = await fetch(hook.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Secret': plainSecret,
            'X-Webhook-Id': hook.id,
          },
          body,
          signal: AbortSignal.timeout(5000),
        });

        if (res.ok) {
          // Reset failure counter
          await this.db
            .prepare('UPDATE webhooks SET consecutive_failures = 0 WHERE id = ?')
            .bind(hook.id)
            .run();
          return true;
        }
      } catch { /* retry */ }
    }

    // All retries failed — increment failures
    const newFailures = (hook.consecutive_failures || 0) + 1;
    if (newFailures >= MAX_CONSECUTIVE_FAILURES) {
      await this.db
        .prepare('UPDATE webhooks SET active = 0, consecutive_failures = ? WHERE id = ?')
        .bind(newFailures, hook.id)
        .run();
    } else {
      await this.db
        .prepare('UPDATE webhooks SET consecutive_failures = ? WHERE id = ?')
        .bind(newFailures, hook.id)
        .run();
    }
    return false;
  }
}
