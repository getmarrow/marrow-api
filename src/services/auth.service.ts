/**
 * Tier 1: Agent Authentication & Routing
 * Tier 11: Agent Isolation (account_id enforcement)
 */
import {
  Account,
  AccountTier,
  ApiKeyAuditEvent,
  ApiKeyAuditLogEntry,
  ApiKeyScope,
  ApiKeyType,
  ManagedApiKey,
  RequestContext,
} from '../types';
import { sha256, uuid, randomHex, now } from '../utils/crypto';
import { checkRateLimit } from '../utils/rate-limit';

const NEW_KEY_RE = /^mrw_(live|test)_([a-f0-9]{32})$/;
const OLD_KEY_RE = /^mrw_[A-Za-z0-9_-]+_[A-Za-z0-9_-]{16,}$/;
const LEGACY_KEY_RE = /^mrw_[A-Za-z0-9]+$/;
const DEFAULT_SCOPES: ApiKeyScope[] = ['full'];
const ALLOWED_SCOPES = new Set<ApiKeyScope>([
  'full',
  'decisions:read',
  'decisions:write',
  'memories:read',
  'memories:write',
  'memories:import',
  'memories:export',
  'patterns:read',
  'agents:manage',
  'webhooks:manage',
  'billing:read',
]);
const DUMMY_AUTH_HASH = '3bb46fd721d2ecf1fd8d06f6f7054f76f2d367dae6a4f6d0aa83f96d5465a7ca';

export class AuthRateLimitError extends Error {
  status = 429;
  constructor(message = 'Too many auth attempts') {
    super(message);
    this.name = 'AuthRateLimitError';
  }
}

export class AuthServiceError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'AuthServiceError';
  }
}

interface AuthMeta {
  ip?: string | null;
  userAgent?: string | null;
}

interface CreateApiKeyInput {
  name?: string | null;
  keyType?: ApiKeyType;
  scopes?: ApiKeyScope[] | string[] | null;
  expiresAt?: string | null;
  createdBy?: string | null;
  agentIds?: string[] | null;
}

interface StoredApiKeyRow {
  id: string;
  account_id: string;
  status: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  name: string | null;
  key_type: string | null;
  prefix: string | null;
  scopes: string | null;
  last_used_ip: string | null;
  usage_count: number | null;
  expires_at: string | null;
  created_by: string | null;
  agent_ids: string | null;
}

export class AuthService {
  constructor(private db: D1Database) {}

  async validateToken(authHeader: string | null, meta: AuthMeta = {}): Promise<RequestContext | null> {
    if (!authHeader?.startsWith('Bearer ')) return null;

    const token = authHeader.slice(7).trim();
    if (!token || token.length < 16) return null;

    await this.enforceAuthAttemptLimit(token);

    const keyHash = await sha256(token);

    const invalidFormat = !NEW_KEY_RE.test(token) && !OLD_KEY_RE.test(token) && !LEGACY_KEY_RE.test(token) && !token.startsWith('marrow_agent_');
    if (invalidFormat) {
      await this.constantTimeMissCompare(keyHash);
      await this.recordKeyAudit(null, null, 'auth_failed', 'system', {
        ...meta,
        details: { reason: 'invalid_prefix' },
      });
      return null;
    }

    const result = await this.db
      .prepare(`
        SELECT id, account_id, status, expires_at, scopes, key_type, agent_ids
        FROM api_keys
        WHERE key_hash = ? AND status = 'active'
        LIMIT 1
      `)
      .bind(keyHash)
      .first<{ id: string; account_id: string; status: string; expires_at: string | null; scopes: string | null; key_type: string | null; agent_ids: string | null }>();

    if (!result) {
      if (token.startsWith('marrow_agent_')) {
        const agentResult = await this.db
          .prepare(`
            SELECT id, account_id
            FROM agents
            WHERE api_key_hash = ? AND status != 'archived'
            LIMIT 1
          `)
          .bind(keyHash)
          .first<{ id: string; account_id: string }>();

        if (agentResult) {
          const agentAccount = await this.getAccount(agentResult.account_id);
          if (!agentAccount) return null;
          return {
            account_id: agentResult.account_id,
            tier: agentAccount.tier,
            api_key_id: `agent:${agentResult.id}`,
            agent_id: agentResult.id,
          };
        }
      }

      await this.constantTimeMissCompare(keyHash);
      await this.recordKeyAudit(null, null, 'auth_failed', 'system', {
        ...meta,
        details: { reason: 'not_found' },
      });
      return null;
    }

    const account = await this.getAccount(result.account_id);
    if (!account) {
      await this.recordKeyAudit(null, result.id, 'auth_failed', 'system', {
        ...meta,
        details: { reason: 'account_missing' },
      });
      return null;
    }

    if (result.expires_at && new Date(result.expires_at).getTime() <= Date.now()) {
      await this.db
        .prepare('UPDATE api_keys SET status = ?, revoked_at = ? WHERE id = ?')
        .bind('revoked', now(), result.id)
        .run();
      await this.recordKeyAudit(result.account_id, result.id, 'auth_failed', 'system', {
        ...meta,
        details: { reason: 'expired' },
      });
      return null;
    }

    this.db
      .prepare('UPDATE api_keys SET last_used_at = ?, last_used_ip = ?, usage_count = COALESCE(usage_count, 0) + 1 WHERE id = ?')
      .bind(now(), meta.ip || null, result.id)
      .run()
      .catch(() => {});

    await this.recordKeyAudit(result.account_id, result.id, 'auth_success', 'system', {
      ...meta,
      details: { key_type: result.key_type || 'live' },
    });

    return {
      account_id: result.account_id,
      tier: account.tier,
      api_key_id: result.id,
      api_key_type: (result.key_type as ApiKeyType) || 'live',
      scopes: this.parseScopes(result.scopes),
      agent_ids: this.parseAgentIds(result.agent_ids),
    };
  }

  async createAccount(name: string, email: string, tier: AccountTier = 'free'): Promise<Account> {
    const id = uuid();
    const ts = now();

    await this.db
      .prepare('INSERT INTO accounts (id, name, email, tier, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, name, email, tier, ts)
      .run();

    return { id, name, email, tier, created_at: ts };
  }

  async updateAccountTier(accountId: string, tier: AccountTier): Promise<Account | null> {
    await this.db
      .prepare('UPDATE accounts SET tier = ? WHERE id = ?')
      .bind(tier, accountId)
      .run();
    return this.getAccount(accountId);
  }

  async createApiKey(accountId: string, input: CreateApiKeyInput = {}, meta: AuthMeta = {}): Promise<{ key: string; keyId: string; maskedKey: string }> {
    const account = await this.getAccount(accountId);
    if (!account) throw new AuthServiceError(404, 'Account not found');

    const keyId = uuid();
    const keyType = this.normalizeKeyType(input.keyType);
    const scopes = this.normalizeScopes(input.scopes);
    const expiresAt = this.normalizeExpiry(input.expiresAt, account.tier);
    const createdAt = now();
    const createdBy = input.createdBy || 'dashboard';
    const name = this.normalizeName(input.name);
    const agentIds = this.normalizeAgentIds(input.agentIds);
    const key = this.generatePlaintextKey(keyType);
    const keyHash = await sha256(key);
    const maskedKey = this.maskKey(key);

    await this.checkKeyLimit(accountId, account.tier);

    const inserted = await this.insertManagedKey({
      keyId,
      accountId,
      keyHash,
      createdAt,
      name,
      keyType,
      maskedKey,
      scopes,
      expiresAt,
      createdBy,
      agentIds,
      tier: account.tier,
    });

    if (!inserted) {
      throw new AuthServiceError(403, `Tier key limit reached (${this.getKeyLimit(account.tier)})`);
    }

    await this.recordKeyAudit(accountId, keyId, 'created', createdBy, {
      ...meta,
      details: {
        name,
        key_type: keyType,
        scopes,
        expires_at: expiresAt,
        agent_ids: agentIds,
      },
    });

    return { key, keyId, maskedKey };
  }

  async listKeys(accountId: string): Promise<ManagedApiKey[]> {
    const rows = await this.db
      .prepare(`
        SELECT id, account_id, status, created_at, last_used_at, revoked_at, name, key_type, prefix, scopes, last_used_ip, usage_count, expires_at, created_by, agent_ids
        FROM api_keys
        WHERE account_id = ?
        ORDER BY created_at DESC
      `)
      .bind(accountId)
      .all<StoredApiKeyRow>();

    return (rows.results || []).map((row) => this.toManagedKey(row));
  }

  async getKey(keyId: string, accountId: string): Promise<ManagedApiKey | null> {
    const row = await this.db
      .prepare(`
        SELECT id, account_id, status, created_at, last_used_at, revoked_at, name, key_type, prefix, scopes, last_used_ip, usage_count, expires_at, created_by, agent_ids
        FROM api_keys
        WHERE id = ? AND account_id = ?
        LIMIT 1
      `)
      .bind(keyId, accountId)
      .first<StoredApiKeyRow>();

    return row ? this.toManagedKey(row) : null;
  }

  async revokeApiKey(keyId: string, accountId: string, meta: AuthMeta = {}, actor = 'user', skipAudit = false): Promise<void> {
    const existing = await this.getStoredKey(keyId, accountId);
    if (!existing) throw new AuthServiceError(404, 'API key not found');
    if (existing.status === 'revoked') return;

    await this.db
      .prepare('UPDATE api_keys SET status = ?, revoked_at = ? WHERE id = ? AND account_id = ?')
      .bind('revoked', now(), keyId, accountId)
      .run();

    if (!skipAudit) {
      await this.recordKeyAudit(accountId, keyId, 'revoked', actor, {
        ...meta,
        details: { key_type: existing.key_type || 'live' },
      });
    }
  }

  async rotateKey(keyId: string, accountId: string, meta: AuthMeta = {}, actor = 'user'): Promise<{ key: string; keyId: string; maskedKey: string }> {
    const existing = await this.getStoredKey(keyId, accountId);
    if (!existing) throw new AuthServiceError(404, 'API key not found');

    await this.revokeApiKey(keyId, accountId, meta, actor, false);

    const rotated = await this.createApiKey(
      accountId,
      {
        name: existing.name,
        keyType: this.normalizeKeyType(existing.key_type as ApiKeyType | undefined),
        scopes: this.parseScopes(existing.scopes),
        expiresAt: existing.expires_at,
        createdBy: actor,
        agentIds: this.parseAgentIds(existing.agent_ids),
      },
      meta,
    );

    await this.recordKeyAudit(accountId, rotated.keyId, 'rotated', actor, {
      ...meta,
      details: { previous_key_id: keyId, new_key_id: rotated.keyId },
    });

    return rotated;
  }

  async listKeyAudit(accountId: string, page = 1, pageSize = 20): Promise<{ entries: ApiKeyAuditLogEntry[]; page: number; page_size: number; total: number }> {
    const limit = Math.max(1, Math.min(pageSize, 100));
    const safePage = Math.max(1, page);
    const rows = await this.db
      .prepare(`
        SELECT id, account_id, key_id, event, actor, ip, user_agent, details, created_at
        FROM api_key_audit_log
        WHERE account_id = ?
        ORDER BY created_at DESC
      `)
      .bind(accountId)
      .all<{ id: string; account_id: string | null; key_id: string | null; event: ApiKeyAuditEvent; actor: string | null; ip: string | null; user_agent: string | null; details: string | null; created_at: string }>();

    const allEntries = (rows.results || []).map((row) => ({
      id: row.id,
      account_id: row.account_id,
      key_id: row.key_id,
      event: row.event,
      actor: row.actor,
      ip: row.ip,
      user_agent: row.user_agent,
      details: row.details ? JSON.parse(row.details) : null,
      created_at: row.created_at,
    }));

    const start = (safePage - 1) * limit;
    return {
      entries: allEntries.slice(start, start + limit),
      page: safePage,
      page_size: limit,
      total: allEntries.length,
    };
  }

  async checkKeyLimit(accountId: string, tier: AccountTier): Promise<void> {
    const limit = this.getKeyLimit(tier);
    if (!Number.isFinite(limit)) return;

    const row = await this.db
      .prepare(`
        SELECT COUNT(*) as cnt
        FROM api_keys
        WHERE account_id = ? AND status = 'active'
      `)
      .bind(accountId)
      .first<{ cnt: number }>();

    if ((row?.cnt || 0) >= limit) {
      throw new AuthServiceError(403, `Tier key limit reached (${limit})`);
    }
  }

  async enforceApiRateLimit(apiKeyId: string, tier: AccountTier): Promise<boolean> {
    const maxPerMinute = this.getApiRateLimit(tier);
    return checkRateLimit(this.db, `api_key:${apiKeyId}`, maxPerMinute, 60 * 1000);
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
    'lessons', 'memories', 'snapshots', 'api_keys', 'api_key_audit_log', 'priority_queue', 'audit_log',
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

  private async enforceAuthAttemptLimit(token: string): Promise<void> {
    const key = `auth_key:${(await sha256(token)).slice(0, 16)}`;
    const allowed = await checkRateLimit(this.db, key, 100, 60 * 1000);
    if (!allowed) throw new AuthRateLimitError();
  }

  private generatePlaintextKey(keyType: ApiKeyType): string {
    return `mrw_${keyType}_${randomHex(16)}`;
  }

  private maskKey(key: string): string {
    return `${key.slice(0, 13)}...${key.slice(-4)}`;
  }

  private normalizeKeyType(keyType?: ApiKeyType): ApiKeyType {
    return keyType === 'test' ? 'test' : 'live';
  }

  private normalizeName(name?: string | null): string | null {
    if (!name) return null;
    const trimmed = name.trim();
    return trimmed ? trimmed.slice(0, 120) : null;
  }

  private normalizeScopes(scopes?: ApiKeyScope[] | string[] | null): ApiKeyScope[] {
    if (!scopes || scopes.length === 0) return [...DEFAULT_SCOPES];

    const normalized = scopes.map((scope) => String(scope).trim()).filter(Boolean);
    const invalid = normalized.find((scope) => !ALLOWED_SCOPES.has(scope as ApiKeyScope));
    if (invalid) throw new AuthServiceError(400, `Invalid scope: ${invalid}`);

    return Array.from(new Set(normalized as ApiKeyScope[]));
  }

  private normalizeExpiry(expiresAt: string | null | undefined, tier: AccountTier): string | null {
    if (!expiresAt) return null;
    if (tier === 'free') throw new AuthServiceError(403, 'Expiry support requires Pro tier or above');
    const parsed = new Date(expiresAt);
    if (Number.isNaN(parsed.getTime())) throw new AuthServiceError(400, 'Invalid expires_at');
    return parsed.toISOString();
  }

  private parseScopes(raw: string | null | undefined): ApiKeyScope[] {
    if (!raw) return [...DEFAULT_SCOPES];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [...DEFAULT_SCOPES];
      return parsed.filter((scope): scope is ApiKeyScope => ALLOWED_SCOPES.has(scope));
    } catch {
      return [...DEFAULT_SCOPES];
    }
  }

  private normalizeAgentIds(agentIds?: string[] | null): string[] {
    return Array.from(
      new Set(
        (Array.isArray(agentIds) ? agentIds : [])
          .map((agentId) => String(agentId || '').trim())
          .filter(Boolean)
      )
    ).slice(0, 100);
  }

  private parseAgentIds(raw: string | null | undefined): string[] {
    if (!raw) return [];
    return raw
      .split(',')
      .map((agentId) => agentId.trim())
      .filter(Boolean);
  }

  private toManagedKey(row: StoredApiKeyRow): ManagedApiKey {
    return {
      id: row.id,
      account_id: row.account_id,
      name: row.name,
      key_type: (row.key_type as ApiKeyType) || 'live',
      masked_key: row.prefix || 'mrw_legacy_****',
      scopes: this.parseScopes(row.scopes),
      status: row.status === 'revoked' ? 'revoked' : 'active',
      created_at: row.created_at,
      last_used_at: row.last_used_at || null,
      last_used_ip: row.last_used_ip || null,
      usage_count: Number(row.usage_count || 0),
      expires_at: row.expires_at || null,
      created_by: row.created_by || null,
      agent_ids: this.parseAgentIds(row.agent_ids),
      revoked_at: row.revoked_at || null,
    };
  }

  private getKeyLimit(tier: AccountTier): number {
    switch (tier) {
      case 'free':
        return 2;
      case 'pro':
        return 10;
      case 'enterprise':
        return 50;
      case 'owner':
        return Number.POSITIVE_INFINITY;
    }
  }

  private getApiRateLimit(tier: AccountTier): number {
    switch (tier) {
      case 'free':
        return 60;
      case 'pro':
        return 300;
      case 'enterprise':
        return 1000;
      case 'owner':
        return 5000;
    }
  }

  private async getStoredKey(keyId: string, accountId: string): Promise<StoredApiKeyRow | null> {
    return this.db
      .prepare(`
        SELECT id, account_id, status, created_at, last_used_at, revoked_at, name, key_type, prefix, scopes, last_used_ip, usage_count, expires_at, created_by, agent_ids
        FROM api_keys
        WHERE id = ? AND account_id = ?
        LIMIT 1
      `)
      .bind(keyId, accountId)
      .first<StoredApiKeyRow>();
  }

  private async insertManagedKey(input: {
    keyId: string;
    accountId: string;
    keyHash: string;
    createdAt: string;
    name: string | null;
    keyType: ApiKeyType;
    maskedKey: string;
    scopes: ApiKeyScope[];
    expiresAt: string | null;
    createdBy: string;
    agentIds: string[];
    tier: AccountTier;
  }): Promise<boolean> {
    const limit = this.getKeyLimit(input.tier);

    if (!Number.isFinite(limit)) {
      await this.db
        .prepare(`
          INSERT INTO api_keys
            (id, account_id, key_hash, status, created_at, last_used_at, revoked_at, name, key_type, prefix, scopes, last_used_ip, usage_count, expires_at, created_by, agent_ids)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          input.keyId,
          input.accountId,
          input.keyHash,
          'active',
          input.createdAt,
          null,
          null,
          input.name,
          input.keyType,
          input.maskedKey,
          JSON.stringify(input.scopes),
          null,
          0,
          input.expiresAt,
          input.createdBy,
          input.agentIds.join(','),
        )
        .run();
      return true;
    }

    const result = await this.db
      .prepare(`
        INSERT INTO api_keys
          (id, account_id, key_hash, status, created_at, last_used_at, revoked_at, name, key_type, prefix, scopes, last_used_ip, usage_count, expires_at, created_by, agent_ids)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE (
          SELECT COUNT(*)
          FROM api_keys
          WHERE account_id = ? AND status = 'active'
        ) < ?
      `)
      .bind(
        input.keyId,
        input.accountId,
        input.keyHash,
        'active',
        input.createdAt,
        null,
        null,
        input.name,
        input.keyType,
        input.maskedKey,
        JSON.stringify(input.scopes),
        null,
        0,
        input.expiresAt,
        input.createdBy,
        input.agentIds.join(','),
        input.accountId,
        limit,
      )
      .run();

    return Number((result.meta as { changes?: number } | undefined)?.changes ?? 0) > 0;
  }

  private async constantTimeMissCompare(candidateHash: string): Promise<void> {
    const a = new TextEncoder().encode(candidateHash.padEnd(DUMMY_AUTH_HASH.length, '0').slice(0, DUMMY_AUTH_HASH.length));
    const b = new TextEncoder().encode(DUMMY_AUTH_HASH);
    let diff = 0;
    for (let i = 0; i < b.length; i++) diff |= a[i] ^ b[i];
    if (diff === 256) console.debug('unreachable');
  }

  private async recordKeyAudit(
    accountId: string | null,
    keyId: string | null,
    event: ApiKeyAuditEvent,
    actor: string | null,
    input: AuthMeta & { details?: Record<string, unknown> },
  ): Promise<void> {
    await this.db
      .prepare(`
        INSERT INTO api_key_audit_log (id, account_id, key_id, event, actor, ip, user_agent, details, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        uuid(),
        accountId,
        keyId,
        event,
        actor,
        input.ip || null,
        input.userAgent || null,
        JSON.stringify(input.details || {}),
        now(),
      )
      .run();
  }
}
