/**
 * Tier 1: Agent Authentication & Routing
 * Tier 11: Agent Isolation (account_id enforcement)
 */
import { Account, RequestContext } from '../types';
import { sha256, uuid, randomHex, now } from '../utils/crypto';

export class AuthService {
  constructor(private db: D1Database) {}

  async validateToken(authHeader: string | null): Promise<RequestContext | null> {
    if (!authHeader?.startsWith('Bearer ')) return null;

    const token = authHeader.slice(7).trim();
    if (!token || token.length < 32) return null;

    const keyHash = await sha256(token);

    const result = await this.db
      .prepare(`
        SELECT ak.id, ak.account_id, ak.status, a.tier
        FROM api_keys ak
        JOIN accounts a ON ak.account_id = a.id
        WHERE ak.key_hash = ? AND ak.status = 'active'
        LIMIT 1
      `)
      .bind(keyHash)
      .first<{ id: string; account_id: string; status: string; tier: string }>();

    if (!result) return null;

    // Update last_used_at (non-blocking)
    this.db
      .prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?')
      .bind(now(), result.id)
      .run()
      .catch(() => {});

    return {
      account_id: result.account_id,
      tier: result.tier as RequestContext['tier'],
      api_key_id: result.id,
    };
  }

  async createAccount(name: string, email: string, tier: 'free' | 'pro' | 'enterprise' | 'owner' = 'free'): Promise<Account> {
    const id = uuid();
    const ts = now();

    await this.db
      .prepare('INSERT INTO accounts (id, name, email, tier, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, name, email, tier, ts)
      .run();

    return { id, name, email, tier, created_at: ts };
  }

  async updateAccountTier(accountId: string, tier: 'free' | 'pro' | 'enterprise' | 'owner'): Promise<Account | null> {
    await this.db
      .prepare('UPDATE accounts SET tier = ? WHERE id = ?')
      .bind(tier, accountId)
      .run();
    return this.getAccount(accountId);
  }

  async createApiKey(accountId: string): Promise<{ key: string; keyId: string }> {
    const keyId = uuid();
    const hex = randomHex(32);
    const key = `mrw_${accountId}_${hex}`;
    const keyHash = await sha256(key);

    await this.db
      .prepare('INSERT INTO api_keys (id, account_id, key_hash, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(keyId, accountId, keyHash, 'active', now())
      .run();

    return { key, keyId };
  }

  async revokeApiKey(keyId: string, accountId: string): Promise<void> {
    await this.db
      .prepare('UPDATE api_keys SET status = ?, revoked_at = ? WHERE id = ? AND account_id = ?')
      .bind('revoked', now(), keyId, accountId)
      .run();
  }

  async getAccount(accountId: string): Promise<Account | null> {
    return this.db
      .prepare('SELECT id, name, email, tier, created_at FROM accounts WHERE id = ?')
      .bind(accountId)
      .first<Account>();
  }

  /** Tier 11: Verify resource belongs to account */
  private static readonly ALLOWED_TABLES = new Set([
    'decisions', 'patterns', 'analytics', 'webhooks', 'orgs', 'org_members',
    'lessons', 'snapshots', 'api_keys', 'priority_queue', 'audit_log',
  ]);

  async checkIsolation(accountId: string, resourceId: string, table: string): Promise<boolean> {
    if (!AuthService.ALLOWED_TABLES.has(table)) {
      throw new Error(`checkIsolation: invalid table "${table}"`);
    }
    const result = await this.db
      .prepare(`SELECT 1 FROM ${table} WHERE id = ? AND account_id = ? LIMIT 1`)
      .bind(resourceId, accountId)
      .first();
    return !!result;
  }
}
