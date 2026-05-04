/**
 * Tier 1: Authentication & Routing
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AuthRateLimitError, AuthService, AuthServiceError } from '../services/auth.service';
import { createMockD1, REAL_API_KEY, REAL_ACCOUNT_ID } from './helpers';

describe('Tier 1: Authentication & Routing', () => {
  let db: D1Database;
  let auth: AuthService;

  beforeEach(() => {
    db = createMockD1();
    auth = new AuthService(db);
  });

  it('validates legacy API keys for backward compatibility', async () => {
    const ctx = await auth.validateToken(`Bearer ${REAL_API_KEY}`);
    expect(ctx).not.toBeNull();
    expect(ctx!.account_id).toBe(REAL_ACCOUNT_ID);
    expect(ctx!.tier).toBe('enterprise');
    expect(ctx!.api_key_id).toBe('key-prod-001');
  });

  it('rejects missing or malformed auth headers', async () => {
    await expect(auth.validateToken(null)).resolves.toBeNull();
    await expect(auth.validateToken('')).resolves.toBeNull();
    await expect(auth.validateToken('Basic abc123')).resolves.toBeNull();
    await expect(auth.validateToken('Bearer short')).resolves.toBeNull();
    await expect(auth.validateToken('Bearer    ')).resolves.toBeNull();
  });

  it('creates accounts with default and explicit tiers', async () => {
    const free = await auth.createAccount('Free Agent', 'free@test.com');
    const pro = await auth.createAccount('Pro Agent', 'pro@test.com', 'pro');
    expect(free.tier).toBe('free');
    expect(pro.tier).toBe('pro');
    expect(free.id).not.toBe(pro.id);
    expect(new Date(free.created_at).getTime()).toBeGreaterThan(0);
  });

  it('creates new-format managed API keys with masked display', async () => {
    const created = await auth.createApiKey(REAL_ACCOUNT_ID, {
      name: 'CI Runner',
      keyType: 'test',
      scopes: ['decisions:read', 'memories:write'],
      createdBy: 'dashboard',
    });

    expect(created.key).toMatch(/^mrw_(live|test)_[a-f0-9]{32}$/);
    expect(created.maskedKey).toMatch(/^mrw_(live|test)_[a-f0-9]{4}\.\.\.[a-f0-9]{4}$/);
    expect(created.maskedKey).not.toBe(created.key);
    expect(created.keyId).toBeTruthy();
  });

  it('listKeys and getKey return masked keys only', async () => {
    const created = await auth.createApiKey(REAL_ACCOUNT_ID, {
      name: 'Production Agent #3',
      keyType: 'live',
      scopes: ['full'],
      createdBy: 'api',
    });

    const listed = await auth.listKeys(REAL_ACCOUNT_ID);
    const found = listed.find((key) => key.id === created.keyId);
    expect(found).toBeTruthy();
    expect(found!.masked_key).toBe(created.maskedKey);
    expect(found!.masked_key).not.toBe(created.key);
    expect(found!.name).toBe('Production Agent #3');

    const single = await auth.getKey(created.keyId, REAL_ACCOUNT_ID);
    expect(single).not.toBeNull();
    expect(single!.masked_key).toBe(created.maskedKey);
    expect(single!.scopes).toEqual(['full']);
  });

  it('newly created key authenticates with type, scopes, and agent bindings', async () => {
    const account = await auth.createAccount('Key Test', 'key@test.com', 'pro');
    const created = await auth.createApiKey(account.id, {
      name: 'Read Only',
      keyType: 'test',
      scopes: ['decisions:read'],
      agentIds: ['agent-alpha', 'agent-beta'],
      createdBy: 'dashboard',
    });

    const ctx = await auth.validateToken(`Bearer ${created.key}`);
    expect(ctx).not.toBeNull();
    expect(ctx!.account_id).toBe(account.id);
    expect(ctx!.api_key_type).toBe('test');
    expect(ctx!.scopes).toEqual(['decisions:read']);
    expect(ctx!.agent_ids).toEqual(['agent-alpha', 'agent-beta']);

    const stored = await auth.getKey(created.keyId, account.id);
    expect(stored!.agent_ids).toEqual(['agent-alpha', 'agent-beta']);
  });

  it('rejects invalid scopes instead of silently upgrading them', async () => {
    const account = await auth.createAccount('Bad Scope', 'bad-scope@test.com', 'pro');
    await expect(auth.createApiKey(account.id, { scopes: ['totally:invalid'] })).rejects.toMatchObject({
      status: 400,
      message: 'Invalid scope: totally:invalid',
    });
  });

  it('enforces free-tier key limits', async () => {
    const account = await auth.createAccount('Free Fleet', 'fleet@test.com', 'free');
    await auth.createApiKey(account.id, { name: 'Key 1' });
    await auth.createApiKey(account.id, { name: 'Key 2' });
    await expect(auth.createApiKey(account.id, { name: 'Key 3' })).rejects.toMatchObject<AuthServiceError>({
      status: 403,
      message: 'Tier key limit reached (2)',
    });
  });

  it('rejects expiry on free tier but allows it on pro', async () => {
    const free = await auth.createAccount('Free Expiry', 'free-expiry@test.com', 'free');
    const pro = await auth.createAccount('Pro Expiry', 'pro-expiry@test.com', 'pro');
    const future = new Date(Date.now() + 60_000).toISOString();

    await expect(auth.createApiKey(free.id, { expiresAt: future })).rejects.toMatchObject<AuthServiceError>({
      status: 403,
    });

    const created = await auth.createApiKey(pro.id, {
      name: 'Expiring Key',
      expiresAt: future,
      scopes: ['decisions:read', 'memories:read'],
    });
    const stored = await auth.getKey(created.keyId, pro.id);
    expect(stored!.expires_at).toBe(future);
    expect(stored!.scopes).toEqual(['decisions:read', 'memories:read']);
  });

  it('revoked keys no longer authenticate', async () => {
    const account = await auth.createAccount('Revoke Test', 'revoke@test.com', 'pro');
    const created = await auth.createApiKey(account.id, { name: 'Revocable' });

    expect(await auth.validateToken(`Bearer ${created.key}`)).not.toBeNull();
    await auth.revokeApiKey(created.keyId, account.id);
    await expect(auth.validateToken(`Bearer ${created.key}`)).resolves.toBeNull();
  });

  it('rotating a key invalidates the old key and returns a new working key', async () => {
    const account = await auth.createAccount('Rotate Test', 'rotate@test.com', 'pro');
    const original = await auth.createApiKey(account.id, {
      name: 'Rotating Key',
      scopes: ['decisions:write'],
    });

    const rotated = await auth.rotateKey(original.keyId, account.id);

    expect(rotated.keyId).not.toBe(original.keyId);
    expect(rotated.key).not.toBe(original.key);
    await expect(auth.validateToken(`Bearer ${original.key}`)).resolves.toBeNull();
    const newCtx = await auth.validateToken(`Bearer ${rotated.key}`);
    expect(newCtx).not.toBeNull();
    expect(newCtx!.account_id).toBe(account.id);
  });

  it('rejects expired keys and marks them revoked', async () => {
    const account = await auth.createAccount('Expiry Test', 'expiry@test.com', 'pro');
    const past = new Date(Date.now() - 60_000).toISOString();
    const created = await auth.createApiKey(account.id, {
      name: 'Expired Key',
      expiresAt: past,
    });

    const ctx = await auth.validateToken(`Bearer ${created.key}`);
    expect(ctx).toBeNull();

    const stored = await auth.getKey(created.keyId, account.id);
    expect(stored!.status).toBe('revoked');
    expect(stored!.revoked_at).toBeTruthy();
  });

  it('logs audit events for create, auth success, revoke, rotate, and auth failure', async () => {
    const account = await auth.createAccount('Audit Test', 'audit@test.com', 'pro');
    const created = await auth.createApiKey(account.id, { name: 'Audit Key', createdBy: 'dashboard' });
    await auth.validateToken(`Bearer ${created.key}`);
    await auth.revokeApiKey(created.keyId, account.id, { ip: '1.2.3.4', userAgent: 'vitest' }, 'user');

    const second = await auth.createApiKey(account.id, { name: 'Rotate Me' });
    await auth.rotateKey(second.keyId, account.id, { ip: '5.6.7.8', userAgent: 'vitest' }, 'user');
    await auth.validateToken(`Bearer mrw_live_${'a'.repeat(32)}`);

    const auditRows = await db
      .prepare('SELECT * FROM api_key_audit_log WHERE account_id = ?')
      .bind(account.id)
      .all<Record<string, unknown>>();

    const events = (auditRows.results || []).map((row) => row.event);
    expect(events).toContain('created');
    expect(events).toContain('auth_success');
    expect(events).toContain('revoked');
    expect(events).toContain('rotated');

    const failedRows = await db
      .prepare('SELECT * FROM api_key_audit_log WHERE event = ?')
      .bind('auth_failed')
      .all<Record<string, unknown>>();
    expect((failedRows.results || []).length).toBeGreaterThan(0);
  });

  it('logs failed auth for unknown but valid-format keys', async () => {
    const token = `mrw_live_${'b'.repeat(32)}`;
    const ctx = await auth.validateToken(`Bearer ${token}`);
    expect(ctx).toBeNull();

    const auditRows = await db
      .prepare('SELECT * FROM api_key_audit_log WHERE event = ?')
      .bind('auth_failed')
      .all<Record<string, unknown>>();

    expect((auditRows.results || []).length).toBe(1);
    expect(auditRows.results?.[0]?.account_id ?? null).toBeNull();
  });

  it('enforces auth-attempt rate limits per key', async () => {
    const account = await auth.createAccount('Auth Limit', 'auth-limit@test.com', 'pro');
    const created = await auth.createApiKey(account.id, { name: 'Burst Key' });

    for (let i = 0; i < 100; i++) {
      const ctx = await auth.validateToken(`Bearer ${created.key}`);
      expect(ctx).not.toBeNull();
    }

    await expect(auth.validateToken(`Bearer ${created.key}`)).rejects.toBeInstanceOf(AuthRateLimitError);
  });

  it('enforces per-tier API rate limits per key', async () => {
    const account = await auth.createAccount('API Limit', 'api-limit@test.com', 'free');
    const created = await auth.createApiKey(account.id, { name: 'Free Key' });

    for (let i = 0; i < 60; i++) {
      await expect(auth.enforceApiRateLimit(created.keyId, 'free')).resolves.toBe(true);
    }

    await expect(auth.enforceApiRateLimit(created.keyId, 'free')).resolves.toBe(false);
  });

  it('never exposes plaintext keys in list or get results', async () => {
    const account = await auth.createAccount('Mask Test', 'mask@test.com', 'pro');
    const created = await auth.createApiKey(account.id, { name: 'Masked Key' });

    const listed = await auth.listKeys(account.id);
    const got = await auth.getKey(created.keyId, account.id);

    expect(JSON.stringify(listed)).not.toContain(created.key);
    expect(JSON.stringify(got)).not.toContain(created.key);
  });

  it('returns null for unknown accounts', async () => {
    const account = await auth.getAccount('missing-account');
    expect(account).toBeNull();
  });
});
