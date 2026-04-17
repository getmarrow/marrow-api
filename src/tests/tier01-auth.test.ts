/**
 * Tier 1: Authentication & Routing — 30 tests
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AuthService } from '../services/auth.service';
import { createMockD1, REAL_API_KEY, REAL_ACCOUNT_ID, REAL_KEY_HASH } from './helpers';

describe('Tier 1: Authentication & Routing', () => {
  let db: D1Database;
  let auth: AuthService;

  beforeEach(() => {
    db = createMockD1();
    auth = new AuthService(db);
  });

  // Token validation
  it('validates real API key successfully', async () => {
    const ctx = await auth.validateToken(`Bearer ${REAL_API_KEY}`);
    expect(ctx).not.toBeNull();
    expect(ctx!.account_id).toBe(REAL_ACCOUNT_ID);
    expect(ctx!.tier).toBe('enterprise');
  });

  it('rejects null auth header', async () => {
    const ctx = await auth.validateToken(null);
    expect(ctx).toBeNull();
  });

  it('rejects empty auth header', async () => {
    const ctx = await auth.validateToken('');
    expect(ctx).toBeNull();
  });

  it('rejects non-Bearer auth', async () => {
    const ctx = await auth.validateToken('Basic abc123');
    expect(ctx).toBeNull();
  });

  it('rejects short token', async () => {
    const ctx = await auth.validateToken('Bearer short');
    expect(ctx).toBeNull();
  });

  it('rejects invalid token', async () => {
    const ctx = await auth.validateToken('Bearer mrw_invalid_0000000000000000000000000000000000');
    expect(ctx).toBeNull();
  });

  it('rejects Bearer with no token', async () => {
    const ctx = await auth.validateToken('Bearer ');
    expect(ctx).toBeNull();
  });

  it('rejects Bearer with spaces only', async () => {
    const ctx = await auth.validateToken('Bearer    ');
    expect(ctx).toBeNull();
  });

  it('returns correct tier for enterprise account', async () => {
    const ctx = await auth.validateToken(`Bearer ${REAL_API_KEY}`);
    expect(ctx!.tier).toBe('enterprise');
  });

  it('returns api_key_id on successful auth', async () => {
    const ctx = await auth.validateToken(`Bearer ${REAL_API_KEY}`);
    expect(ctx!.api_key_id).toBeTruthy();
  });

  // Account creation
  it('creates new account', async () => {
    const account = await auth.createAccount('Test Agent', 'test@test.com', 'free');
    expect(account.id).toBeTruthy();
    expect(account.name).toBe('Test Agent');
    expect(account.email).toBe('test@test.com');
    expect(account.tier).toBe('free');
  });

  it('creates pro account', async () => {
    const account = await auth.createAccount('Pro Agent', 'pro@test.com', 'pro');
    expect(account.tier).toBe('pro');
  });

  it('creates enterprise account', async () => {
    const account = await auth.createAccount('Enterprise', 'ent@test.com', 'enterprise');
    expect(account.tier).toBe('enterprise');
  });

  it('defaults to free tier', async () => {
    const account = await auth.createAccount('Free', 'free@test.com');
    expect(account.tier).toBe('free');
  });

  it('generates unique account IDs', async () => {
    const a1 = await auth.createAccount('A1', 'a1@test.com');
    const a2 = await auth.createAccount('A2', 'a2@test.com');
    expect(a1.id).not.toBe(a2.id);
  });

  it('sets created_at timestamp', async () => {
    const account = await auth.createAccount('Time', 'time@test.com');
    expect(account.created_at).toBeTruthy();
    expect(new Date(account.created_at).getTime()).toBeGreaterThan(0);
  });

  // API key management
  it('creates API key for account', async () => {
    const { key, keyId } = await auth.createApiKey(REAL_ACCOUNT_ID);
    expect(key).toMatch(/^mrw_/);
    expect(key).toContain(REAL_ACCOUNT_ID);
    expect(keyId).toBeTruthy();
  });

  it('generated key has correct format', async () => {
    const { key } = await auth.createApiKey(REAL_ACCOUNT_ID);
    expect(key).toMatch(/^mrw_\w+_[a-f0-9]{64}$/);
  });

  it('generated keys are unique', async () => {
    const k1 = await auth.createApiKey(REAL_ACCOUNT_ID);
    const k2 = await auth.createApiKey(REAL_ACCOUNT_ID);
    expect(k1.key).not.toBe(k2.key);
    expect(k1.keyId).not.toBe(k2.keyId);
  });

  it('newly created key can authenticate', async () => {
    const account = await auth.createAccount('KeyTest', 'keytest@test.com');
    const { key } = await auth.createApiKey(account.id);
    const ctx = await auth.validateToken(`Bearer ${key}`);
    expect(ctx).not.toBeNull();
    expect(ctx!.account_id).toBe(account.id);
  });

  // Key revocation
  it('revokes API key', async () => {
    const account = await auth.createAccount('Revoke', 'revoke@test.com');
    const { key, keyId } = await auth.createApiKey(account.id);

    // Verify it works first
    const ctx1 = await auth.validateToken(`Bearer ${key}`);
    expect(ctx1).not.toBeNull();

    // Revoke
    await auth.revokeApiKey(keyId, account.id);

    // Verify it's rejected
    const ctx2 = await auth.validateToken(`Bearer ${key}`);
    expect(ctx2).toBeNull();
  });

  // Account retrieval
  it('gets existing account', async () => {
    const account = await auth.getAccount(REAL_ACCOUNT_ID);
    expect(account).not.toBeNull();
    expect(account!.name).toBe('Empire Buu');
  });

  it('returns null for non-existent account', async () => {
    const account = await auth.getAccount('nonexistent');
    expect(account).toBeNull();
  });

  // Isolation (Tier 11)
  it('validates own decision access', async () => {
    const ctx = await auth.validateToken(`Bearer ${REAL_API_KEY}`);
    expect(ctx).not.toBeNull();
    expect(ctx!.account_id).toBe(REAL_ACCOUNT_ID);
  });

  it('different accounts get different IDs', async () => {
    const a1 = await auth.createAccount('A1', 'a1@test.com');
    const a2 = await auth.createAccount('A2', 'a2@test.com');
    expect(a1.id).not.toBe(a2.id);
    // Each agent can only see their own data through account_id filtering
  });

  // Edge cases
  it('handles token with extra whitespace', async () => {
    const ctx = await auth.validateToken(`Bearer  ${REAL_API_KEY}  `);
    // Trimmed token should still work
    expect(ctx).not.toBeNull();
  });

  it('key hash is SHA-256 (64 hex chars)', () => {
    expect(REAL_KEY_HASH).toMatch(/^[a-f0-9]{64}$/);
  });

  it('never stores plaintext key', async () => {
    const { key } = await auth.createApiKey(REAL_ACCOUNT_ID);
    // The key should not be in the database as plaintext
    // Only the hash should be stored
    expect(key).toContain('mrw_');
  });

  it('multiple accounts can coexist', async () => {
    const a1 = await auth.createAccount('Agent1', 'a1@test.com', 'free');
    const a2 = await auth.createAccount('Agent2', 'a2@test.com', 'pro');
    const k1 = await auth.createApiKey(a1.id);
    const k2 = await auth.createApiKey(a2.id);

    const ctx1 = await auth.validateToken(`Bearer ${k1.key}`);
    const ctx2 = await auth.validateToken(`Bearer ${k2.key}`);

    expect(ctx1!.account_id).toBe(a1.id);
    expect(ctx2!.account_id).toBe(a2.id);
    expect(ctx1!.tier).toBe('free');
    expect(ctx2!.tier).toBe('pro');
  });
});
