import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { now, sha256 } from '../src/utils/crypto';

type MemoryStatus = 'active' | 'outdated' | 'superseded' | 'deleted';

type MemoryRow = {
  id: string;
  account_id: string;
  text: string;
  source: string | null;
  tags: string;
  status: MemoryStatus;
  supersedes: string | null;
  superseded_by: string | null;
  deleted_at: string | null;
  audit: string;
  created_at: string;
  updated_at: string;
};

type AgentRow = {
  id: string;
  account_id: string;
  api_key_hash: string;
  status: string;
};

class FakeD1Statement {
  private params: unknown[] = [];

  constructor(private db: FakeD1Database, private sql: string) {}

  bind(...params: unknown[]) {
    this.params = params;
    return this;
  }

  async first<T>() {
    return this.db.first<T>(this.sql, this.params);
  }

  async all<T>() {
    return this.db.all<T>(this.sql, this.params);
  }

  async run() {
    return this.db.run(this.sql, this.params);
  }

  async raw<T>() {
    const result = await this.db.all<T>(this.sql, this.params);
    return result.results;
  }
}

class FakeD1Database {
  accounts = new Map<string, { id: string; name: string; email: string; tier: string; created_at: string }>();
  apiKeys = new Map<string, { id: string; account_id: string; key_hash: string; status: string; created_at: string; last_used_at: string | null; expires_at?: string | null; scopes?: string | null; key_type?: string | null; agent_ids?: string | null; last_used_ip?: string | null; usage_count?: number | null; revoked_at?: string | null; name?: string | null; prefix?: string | null; created_by?: string | null }>();
  agents = new Map<string, AgentRow>();
  memories = new Map<string, MemoryRow>();
  memoryShares: Array<{ id: string; memory_id: string; account_id: string; agent_id: string; created_at: string }> = [];

  prepare(sql: string) {
    return new FakeD1Statement(this, sql);
  }

  async batch(statements: D1PreparedStatement[]) {
    const snapshot = this.snapshot();
    try {
      const results = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      return results;
    } catch (error) {
      this.restore(snapshot);
      throw error;
    }
  }

  async first<T>(sql: string, params: unknown[]): Promise<T | null> {
    const normalized = normalizeSql(sql);

    if (normalized.includes('from api_keys where key_hash = ? and status = \'active\'')) {
      const keyHash = String(params[0] || '');
      const apiKey = Array.from(this.apiKeys.values()).find((row) => row.key_hash === keyHash && row.status === 'active');
      if (!apiKey) return null;
      return {
        id: apiKey.id,
        account_id: apiKey.account_id,
        status: apiKey.status,
        expires_at: apiKey.expires_at || null,
        scopes: apiKey.scopes || '["full"]',
        key_type: apiKey.key_type || 'live',
        agent_ids: apiKey.agent_ids || null,
      } as T;
    }

    if (normalized.includes('from agents where api_key_hash = ? and status != \'archived\'')) {
      const keyHash = String(params[0] || '');
      const agent = Array.from(this.agents.values()).find((row) => row.api_key_hash === keyHash && row.status !== 'archived');
      if (!agent) return null;
      return {
        id: agent.id,
        account_id: agent.account_id,
      } as T;
    }

    if (normalized.startsWith('select id, name, email, tier, created_at from accounts where id = ?')) {
      const accountId = String(params[0] || '');
      const account = this.accounts.get(accountId);
      return account ? ({ ...account } as T) : null;
    }

    if (normalized.includes('select id, account_id, status, created_at, last_used_at, revoked_at, name, key_type, prefix, scopes, last_used_ip, usage_count, expires_at, created_by, agent_ids from api_keys where id = ? and account_id = ? limit 1')) {
      const keyId = String(params[0] || '');
      const accountId = String(params[1] || '');
      const key = this.apiKeys.get(keyId);
      if (!key || key.account_id !== accountId) return null;
      return ({ ...key } as T);
    }

    if (normalized.startsWith('select * from memories where id = ? and account_id = ?')) {
      const id = String(params[0] || '');
      const accountId = String(params[1] || '');
      const memory = this.memories.get(id);
      return memory && memory.account_id === accountId ? (clone(memory) as T) : null;
    }

    if (normalized.startsWith('select id from memory_shares where memory_id = ? and account_id = ? and agent_id = ? limit 1')) {
      const memoryId = String(params[0] || '');
      const accountId = String(params[1] || '');
      const agentId = String(params[2] || '');
      const share = this.memoryShares.find((row) => row.memory_id === memoryId && row.account_id === accountId && row.agent_id === agentId);
      return share ? ({ id: share.id } as T) : null;
    }

    if (normalized.startsWith("select id from memories where account_id = ? and text = ? and coalesce(source, '') = coalesce(?, '') and status != 'deleted' limit 1")) {
      const accountId = String(params[0] || '');
      const text = String(params[1] || '');
      const source = params[2] == null ? null : String(params[2]);
      const memory = Array.from(this.memories.values()).find((row) => (
        row.account_id === accountId &&
        row.text === text &&
        row.status !== 'deleted' &&
        (row.source || null) === source
      ));
      return memory ? ({ id: memory.id } as T) : null;
    }

    return null;
  }

  async all<T>(sql: string, params: unknown[]): Promise<{ results: T[]; success: true; meta: Record<string, never> }> {
    const normalized = normalizeSql(sql);

    if (normalized.startsWith('select distinct m.* from memories m')) {
      const results = this.queryMemories(normalized, params).map((row) => clone(row) as T);
      return { results, success: true, meta: {} };
    }

    if (normalized.includes('select id, account_id, status, created_at, last_used_at, revoked_at, name, key_type, prefix, scopes, last_used_ip, usage_count, expires_at, created_by, agent_ids from api_keys where account_id = ? order by created_at desc')) {
      const accountId = String(params[0] || '');
      const results = Array.from(this.apiKeys.values())
        .filter((row) => row.account_id === accountId)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .map((row) => clone(row) as T);
      return { results, success: true, meta: {} };
    }

    return { results: [], success: true, meta: {} };
  }

  async run(sql: string, params: unknown[]) {
    const normalized = normalizeSql(sql);

    if (normalized.startsWith('update api_keys set last_used_at = ?, last_used_ip = ?, usage_count = coalesce(usage_count, 0) + 1 where id = ?')) {
      const key = this.apiKeys.get(String(params[2] || ''));
      if (key) {
        key.last_used_at = String(params[0] || '');
        key.last_used_ip = params[1] == null ? null : String(params[1]);
        key.usage_count = Number(key.usage_count || 0) + 1;
      }
      return { success: true, meta: {} };
    }

    if (normalized.startsWith('update api_keys set status = ?, revoked_at = ? where id = ?')) {
      const key = this.apiKeys.get(String(params[2] || ''));
      if (key) {
        key.status = String(params[0] || 'revoked');
        key.revoked_at = params[1] == null ? null : String(params[1]);
      }
      return { success: true, meta: {} };
    }

    if (normalized.startsWith("update memories set status = 'deleted', deleted_at = ?, updated_at = ? where account_id = ? and status != 'deleted'")) {
      const deletedAt = String(params[0] || '');
      const updatedAt = String(params[1] || '');
      const accountId = String(params[2] || '');
      for (const memory of this.memories.values()) {
        if (memory.account_id === accountId && memory.status !== 'deleted') {
          memory.status = 'deleted';
          memory.deleted_at = deletedAt;
          memory.updated_at = updatedAt;
        }
      }
      return { success: true, meta: {} };
    }

    if (normalized.startsWith('insert into memories (id, account_id, text, source, tags, status, supersedes, superseded_by, deleted_at, audit, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')) {
      const [id, account_id, text, source, tags, status, supersedes, superseded_by, deleted_at, audit, created_at, updated_at] = params;
      this.memories.set(String(id), {
        id: String(id),
        account_id: String(account_id),
        text: String(text),
        source: source == null ? null : String(source),
        tags: String(tags),
        status: String(status) as MemoryStatus,
        supersedes: supersedes == null ? null : String(supersedes),
        superseded_by: superseded_by == null ? null : String(superseded_by),
        deleted_at: deleted_at == null ? null : String(deleted_at),
        audit: String(audit),
        created_at: String(created_at),
        updated_at: String(updated_at),
      });
      return { success: true, meta: {} };
    }

    if (normalized.startsWith('insert or ignore into memory_shares (id, memory_id, account_id, agent_id, created_at) values (?, ?, ?, ?, ?)')) {
      const [id, memory_id, account_id, agent_id, created_at] = params;
      const memory = this.memories.get(String(memory_id));
      if (!memory || memory.account_id !== String(account_id)) {
        throw new Error('share/account mismatch');
      }
      const exists = this.memoryShares.some((row) => (
        row.memory_id === memory_id && row.account_id === account_id && row.agent_id === agent_id
      ));
      if (!exists) {
        this.memoryShares.push({
          id: String(id),
          memory_id: String(memory_id),
          account_id: String(account_id),
          agent_id: String(agent_id),
          created_at: String(created_at),
        });
      }
      return { success: true, meta: {} };
    }

    if (normalized.startsWith('update memories set text = ?, source = ?, tags = ?, audit = ?, updated_at = ? where id = ? and account_id = ?')) {
      const memory = this.memories.get(String(params[5] || ''));
      if (memory && memory.account_id === String(params[6] || '')) {
        memory.text = String(params[0] || '');
        memory.source = params[1] == null ? null : String(params[1]);
        memory.tags = String(params[2] || '[]');
        memory.audit = String(params[3] || '[]');
        memory.updated_at = String(params[4] || '');
      }
      return { success: true, meta: {} };
    }

    if (normalized.startsWith('update memories set status = ?, deleted_at = ?, audit = ?, updated_at = ? where id = ? and account_id = ?')) {
      const memory = this.memories.get(String(params[4] || ''));
      if (memory && memory.account_id === String(params[5] || '')) {
        memory.status = String(params[0] || 'deleted') as MemoryStatus;
        memory.deleted_at = params[1] == null ? null : String(params[1]);
        memory.audit = String(params[2] || '[]');
        memory.updated_at = String(params[3] || '');
      }
      return { success: true, meta: {} };
    }

    if (normalized.startsWith('delete from memory_shares where memory_id = ? and account_id = ?')) {
      const memoryId = String(params[0] || '');
      const accountId = String(params[1] || '');
      this.memoryShares = this.memoryShares.filter((row) => !(row.memory_id === memoryId && row.account_id === accountId));
      return { success: true, meta: {} };
    }

    if (normalized.startsWith('delete from memory_shares where account_id = ?')) {
      const accountId = String(params[0] || '');
      this.memoryShares = this.memoryShares.filter((row) => row.account_id !== accountId);
      return { success: true, meta: {} };
    }

    if (normalized.startsWith('update memories set status = ?, audit = ?, updated_at = ? where id = ? and account_id = ?')) {
      const memory = this.memories.get(String(params[3] || ''));
      if (memory && memory.account_id === String(params[4] || '')) {
        memory.status = String(params[0] || 'outdated') as MemoryStatus;
        memory.audit = String(params[1] || '[]');
        memory.updated_at = String(params[2] || '');
      }
      return { success: true, meta: {} };
    }

    if (normalized.startsWith('update memories set audit = ?, updated_at = ? where id = ? and account_id = ?')) {
      const memory = this.memories.get(String(params[2] || ''));
      if (memory && memory.account_id === String(params[3] || '')) {
        memory.audit = String(params[0] || '[]');
        memory.updated_at = String(params[1] || '');
      }
      return { success: true, meta: {} };
    }

    return { success: true, meta: {} };
  }

  private queryMemories(sql: string, params: unknown[]): MemoryRow[] {
    let index = 0;
    const accountId = String(params[index++] || '');
    let rows = Array.from(this.memories.values()).filter((row) => row.account_id === accountId);

    if (sql.includes("m.status = 'active'")) {
      rows = rows.filter((row) => row.status === 'active');
    } else if (sql.includes("m.status != 'deleted'")) {
      rows = rows.filter((row) => row.status !== 'deleted');
    }

    if (sql.includes('m.status = ?')) {
      const status = String(params[index++] || '');
      rows = rows.filter((row) => row.status === status);
    }

    if (sql.includes("(lower(m.text) like ? or lower(coalesce(m.source, '')) like ? or lower(coalesce(m.tags, '[]')) like ?)")) {
      const term = String(params[index++] || '').toLowerCase().replaceAll('%', '');
      index += 2;
      rows = rows.filter((row) =>
        row.text.toLowerCase().includes(term) ||
        (row.source || '').toLowerCase().includes(term) ||
        row.tags.toLowerCase().includes(term)
      );
    }

    if (sql.includes('ms.agent_id = ?')) {
      const agentId = String(params[index++] || '');
      rows = rows.filter((row) => this.memoryShares.some((share) => share.memory_id === row.id && share.account_id === row.account_id && share.agent_id === agentId));
    }

    if (sql.includes('m.created_at >= ?')) {
      const from = String(params[index++] || '');
      rows = rows.filter((row) => row.created_at >= from);
    }

    if (sql.includes('m.created_at <= ?')) {
      const to = String(params[index++] || '');
      rows = rows.filter((row) => row.created_at <= to);
    }

    if (sql.includes('m.source = ?')) {
      const source = params[index++] == null ? null : String(params[index - 1]);
      rows = rows.filter((row) => (row.source || null) === source);
    }

    if (sql.includes('exists (select 1 from memory_shares')) {
      rows = rows.filter((row) => this.memoryShares.some((share) => share.memory_id === row.id && share.account_id === row.account_id));
    } else if (sql.includes('not exists (select 1 from memory_shares')) {
      rows = rows.filter((row) => !this.memoryShares.some((share) => share.memory_id === row.id && share.account_id === row.account_id));
    }

    const limit = Number(params[params.length - 1] || rows.length);
    return rows
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, limit);
  }

  private snapshot() {
    return {
      memories: clone(Array.from(this.memories.entries())),
      memoryShares: clone(this.memoryShares),
      apiKeys: clone(Array.from(this.apiKeys.entries())),
    };
  }

  private restore(snapshot: ReturnType<FakeD1Database['snapshot']>) {
    this.memories = new Map(snapshot.memories);
    this.memoryShares = snapshot.memoryShares;
    this.apiKeys = new Map(snapshot.apiKeys);
  }
}

function normalizeSql(sql: string) {
  return sql.trim().replace(/\s+/g, ' ').toLowerCase();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

describe('memory endpoints', () => {
  let db: FakeD1Database;
  let env: any;
  let ownerToken: string;
  let agentToken: string;
  const accountId = 'acct_test';
  const agentId = 'agent_alpha';
  const otherAgentId = 'agent_beta';

  async function seedApiKey(options: {
    id: string;
    token: string;
    scopes?: string[];
    keyType?: 'live' | 'test';
    agentIds?: string[] | null;
    name?: string | null;
    createdBy?: string | null;
  }) {
    db.apiKeys.set(options.id, {
      id: options.id,
      account_id: accountId,
      key_hash: await sha256(options.token),
      status: 'active',
      created_at: now(),
      last_used_at: null,
      expires_at: null,
      scopes: JSON.stringify(options.scopes || ['full']),
      key_type: options.keyType || 'live',
      agent_ids: options.agentIds?.length ? options.agentIds.join(',') : null,
      last_used_ip: null,
      usage_count: 0,
      revoked_at: null,
      name: options.name || null,
      prefix: `${options.token.slice(0, 13)}...${options.token.slice(-4)}`,
      created_by: options.createdBy || 'test',
    });
  }

  beforeEach(async () => {
    db = new FakeD1Database();
    ownerToken = 'mrw_acct_test_abcdefghijklmnopqrstuvwxyz1234567890';
    agentToken = 'marrow_agent_abcdefghijklmnopqrstuvwxyz1234567890';
    const agentHash = await sha256(agentToken);
    const createdAt = now();

    db.accounts.set(accountId, {
      id: accountId,
      name: 'Test Account',
      email: 'test@example.com',
      tier: 'pro',
      created_at: createdAt,
    });

    await seedApiKey({
      id: 'key_owner',
      token: ownerToken,
    });

    db.agents.set(agentId, {
      id: agentId,
      account_id: accountId,
      api_key_hash: agentHash,
      status: 'active',
    });

    db.agents.set(otherAgentId, {
      id: otherAgentId,
      account_id: accountId,
      api_key_hash: 'unused',
      status: 'active',
    });

    env = {
      DB: db,
      ENCRYPTION_KEY: 'test-encryption-key-32-bytes-long',
      INTERNAL_KEY: 'internal-secret-key-32-bytes-long',
      ENVIRONMENT: 'test',
      RESEND_API_KEY: 're_test',
      RESEND_FROM_EMAIL: 'noreply@example.com',
      APP_BASE_URL: 'https://app.example.com',
    };
  });

  function seedMemory(options: {
    id: string;
    text: string;
    source?: string | null;
    tags?: string[];
    status?: MemoryStatus;
    sharedWith?: string[];
  }) {
    const ts = now();
    db.memories.set(options.id, {
      id: options.id,
      account_id: accountId,
      text: options.text,
      source: options.source ?? null,
      tags: JSON.stringify(options.tags || []),
      status: options.status || 'active',
      supersedes: null,
      superseded_by: null,
      deleted_at: null,
      audit: '[]',
      created_at: ts,
      updated_at: ts,
    });

    for (const sharedAgentId of options.sharedWith || []) {
      db.memoryShares.push({
        id: `${options.id}:${sharedAgentId}`,
        memory_id: options.id,
        account_id: accountId,
        agent_id: sharedAgentId,
        created_at: ts,
      });
    }
  }

  async function apiFetch(path: string, init: RequestInit = {}, token = ownerToken) {
    const headers = new Headers(init.headers || {});
    headers.set('Authorization', `Bearer ${token}`);
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    return worker.fetch(
      new Request(`https://api.test${path}`, { ...init, headers }),
      env,
      { waitUntil() {}, passThroughOnException() {} } as ExecutionContext,
    );
  }

  it('returns 200 with empty collections instead of 404', async () => {
    const listRes = await apiFetch('/v1/memories');
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.data.memories).toEqual([]);
    expect(listBody.data.count).toBe(0);

    const retrieveRes = await apiFetch('/v1/memories/retrieve?q=missing');
    expect(retrieveRes.status).toBe(200);
    const retrieveBody = await retrieveRes.json();
    expect(retrieveBody.data.memories).toEqual([]);
    expect(retrieveBody.data.count).toBe(0);

    const exportRes = await apiFetch('/v1/memories/export');
    expect(exportRes.status).toBe(200);
    const exportBody = await exportRes.json();
    expect(exportBody.data.memories).toEqual([]);
    expect(exportBody.data.count).toBe(0);
  });

  it('returns a friendly 404 for a missing memory id', async () => {
    const res = await apiFetch('/v1/memories/not-real');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Memory not found');
    expect(body.details.id).toBe('not-real');
  });

  it('returns route details for unknown paths instead of a raw not found', async () => {
    const res = await worker.fetch(
      new Request('https://api.test/v1/definitely-not-a-route', { method: 'POST' }),
      env,
      { waitUntil() {}, passThroughOnException() {} } as ExecutionContext,
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Route not found');
    expect(body.details.path).toBe('/v1/definitely-not-a-route');
    expect(body.details.method).toBe('POST');
  });

  it('route policy blocks write endpoints for read-only scoped keys', async () => {
    const scopedToken = 'mrw_live_deadbeefdeadbeefdeadbeefdeadbeef';
    await seedApiKey({
      id: 'key_scoped_readonly',
      token: scopedToken,
      scopes: ['decisions:read'],
    });

    const createKeyRes = await apiFetch('/v1/auth/keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'should fail' }),
    }, scopedToken);
    expect(createKeyRes.status).toBe(403);
    await expect(createKeyRes.json()).resolves.toMatchObject({ error: 'Insufficient scope' });

    seedMemory({ id: 'shared-alpha', text: 'alpha memory', sharedWith: [agentId] });
    const patchMemoryRes = await apiFetch('/v1/memories/shared-alpha', {
      method: 'PATCH',
      body: JSON.stringify({ text: 'still nope' }),
    }, scopedToken);
    expect(patchMemoryRes.status).toBe(403);
    await expect(patchMemoryRes.json()).resolves.toMatchObject({ error: 'Insufficient scope' });
  });

  it('test keys stay trapped in the test-key sandbox', async () => {
    const testKeyToken = 'mrw_test_deadbeefdeadbeefdeadbeefdeadbeef';
    await seedApiKey({
      id: 'key_test_only',
      token: testKeyToken,
      keyType: 'test',
      scopes: ['agents:manage'],
    });

    const accountRes = await apiFetch('/v1/auth/account', {}, testKeyToken);
    expect(accountRes.status).toBe(200);
    const accountBody = await accountRes.json();
    expect(accountBody).toMatchObject({ data: { tier: 'pro' } });
    expect(accountBody.data.email).toBeUndefined();
    expect(accountBody.data.name).toBeUndefined();

    const createLiveKeyRes = await apiFetch('/v1/auth/keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'escape hatch', key_type: 'live' }),
    }, testKeyToken);
    expect(createLiveKeyRes.status).toBe(403);
    await expect(createLiveKeyRes.json()).resolves.toMatchObject({ error: 'Test keys can only manage test keys.' });

    const memoriesRes = await apiFetch('/v1/memories', {}, testKeyToken);
    expect(memoriesRes.status).toBe(403);
    await expect(memoriesRes.json()).resolves.toMatchObject({ error: 'Test keys cannot access production data.' });
  });

  it('test keys cannot revoke or rotate live keys', async () => {
    const testKeyToken = 'mrw_test_feedfacefeedfacefeedfacefeedface';
    await seedApiKey({
      id: 'key_test_admin',
      token: testKeyToken,
      keyType: 'test',
      scopes: ['agents:manage'],
    });

    const revokeRes = await apiFetch('/v1/auth/keys/key_owner/revoke', { method: 'POST' }, testKeyToken);
    expect(revokeRes.status).toBe(403);
    await expect(revokeRes.json()).resolves.toMatchObject({ error: 'Test keys can only manage test keys.' });

    const rotateRes = await apiFetch('/v1/auth/keys/key_owner/rotate', { method: 'POST' }, testKeyToken);
    expect(rotateRes.status).toBe(403);
    await expect(rotateRes.json()).resolves.toMatchObject({ error: 'Test keys can only manage test keys.' });
  });

  it('imports a memory and lists it back through the route surface', async () => {
    const importRes = await apiFetch('/v1/memories/import', {
      method: 'POST',
      body: JSON.stringify({
        mode: 'merge',
        memories: [
          {
            text: 'remember to rotate the admin token',
            source: 'incident',
            tags: ['ops', 'security'],
            sharedWith: ['barvis'],
          },
        ],
      }),
    });

    expect(importRes.status).toBe(200);
    const importBody = await importRes.json();
    expect(importBody.data.imported).toBe(1);
    expect(importBody.data.skipped).toBe(0);

    const listRes = await apiFetch('/v1/memories?query=rotate');
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.data.count).toBe(1);
    expect(listBody.data.memories[0].text).toContain('rotate the admin token');
  });

  it('agent-scoped list ignores caller-supplied agent_id and only returns shared memories', async () => {
    seedMemory({ id: 'shared-alpha', text: 'alpha memory', sharedWith: [agentId] });
    seedMemory({ id: 'shared-beta', text: 'beta memory', sharedWith: [otherAgentId] });
    seedMemory({ id: 'private', text: 'private memory' });

    const res = await apiFetch('/v1/memories?agent_id=agent_beta', {}, agentToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.count).toBe(1);
    expect(body.data.memories.map((memory: { id: string }) => memory.id)).toEqual(['shared-alpha']);
  });

  it('agent-scoped get and update are limited to that agent\'s shared memories', async () => {
    seedMemory({ id: 'shared-alpha', text: 'alpha memory', sharedWith: [agentId] });
    seedMemory({ id: 'shared-beta', text: 'beta memory', sharedWith: [otherAgentId] });

    const visible = await apiFetch('/v1/memories/shared-alpha', {}, agentToken);
    expect(visible.status).toBe(200);

    const hidden = await apiFetch('/v1/memories/shared-beta', {}, agentToken);
    expect(hidden.status).toBe(404);

    const patchAllowed = await apiFetch('/v1/memories/shared-alpha', {
      method: 'PATCH',
      body: JSON.stringify({ text: 'alpha memory updated' }),
    }, agentToken);
    expect(patchAllowed.status).toBe(200);
    expect(db.memories.get('shared-alpha')?.text).toBe('alpha memory updated');

    const patchDenied = await apiFetch('/v1/memories/shared-beta', {
      method: 'PATCH',
      body: JSON.stringify({ text: 'nope' }),
    }, agentToken);
    expect(patchDenied.status).toBe(404);
    expect(db.memories.get('shared-beta')?.text).toBe('beta memory');
  });

  it('agent-scoped delete only works on shared memories', async () => {
    seedMemory({ id: 'shared-alpha', text: 'alpha memory', sharedWith: [agentId] });
    seedMemory({ id: 'shared-beta', text: 'beta memory', sharedWith: [otherAgentId] });

    const denied = await apiFetch('/v1/memories/shared-beta', { method: 'DELETE' }, agentToken);
    expect(denied.status).toBe(404);
    expect(db.memories.get('shared-beta')?.status).toBe('active');

    const allowed = await apiFetch('/v1/memories/shared-alpha', { method: 'DELETE' }, agentToken);
    expect(allowed.status).toBe(200);
    expect(db.memories.get('shared-alpha')?.status).toBe('deleted');
    expect(db.memoryShares.some((share) => share.memory_id === 'shared-alpha')).toBe(false);
  });

  it('agent-scoped export is share-filtered and neutralizes csv formula fields', async () => {
    seedMemory({
      id: 'shared-alpha',
      text: '=SUM(1,2)',
      source: '@inbox',
      tags: ['-danger'],
      sharedWith: [agentId],
    });
    seedMemory({ id: 'shared-beta', text: 'other memory', sharedWith: [otherAgentId] });

    const res = await apiFetch('/v1/memories/export?format=csv', {}, agentToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.count).toBe(1);
    expect(body.data.csv).toContain("'=SUM(1,2)");
    expect(body.data.csv).toContain("'@inbox");
    expect(body.data.csv).toContain("'-danger");
    expect(body.data.csv).not.toContain('other memory');
  });

  it('agent-scoped tokens cannot import or share memories', async () => {
    seedMemory({ id: 'shared-alpha', text: 'alpha memory', sharedWith: [agentId] });

    const importRes = await apiFetch('/v1/memories/import', {
      method: 'POST',
      body: JSON.stringify({
        mode: 'merge',
        memories: [{ text: 'should not import' }],
      }),
    }, agentToken);
    expect(importRes.status).toBe(403);
    expect(Array.from(db.memories.values()).some((memory) => memory.text === 'should not import')).toBe(false);

    const shareRes = await apiFetch('/v1/memories/shared-alpha/share', {
      method: 'POST',
      body: JSON.stringify({ agent_ids: [otherAgentId] }),
    }, agentToken);
    expect(shareRes.status).toBe(403);
    expect(db.memoryShares.some((share) => share.memory_id === 'shared-alpha' && share.agent_id === otherAgentId)).toBe(false);
  });

  it('replace import fails closed on invalid rows and preserves existing memories', async () => {
    seedMemory({ id: 'existing', text: 'do not lose me' });

    const res = await apiFetch('/v1/memories/import', {
      method: 'POST',
      body: JSON.stringify({
        mode: 'replace',
        memories: [
          { text: 'valid replacement' },
          { text: '   ' },
        ],
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Import validation failed');
    expect(db.memories.get('existing')?.status).toBe('active');
    expect(Array.from(db.memories.values()).some((memory) => memory.text === 'valid replacement')).toBe(false);
  });

  it('replace import clears stale shares from superseded account state before inserting replacements', async () => {
    seedMemory({ id: 'existing', text: 'old memory', sharedWith: [agentId] });
    expect(db.memoryShares.some((share) => share.memory_id === 'existing')).toBe(true);

    const res = await apiFetch('/v1/memories/import', {
      method: 'POST',
      body: JSON.stringify({
        mode: 'replace',
        memories: [
          { text: 'replacement memory', sharedWith: [otherAgentId] },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(db.memoryShares.some((share) => share.memory_id === 'existing')).toBe(false);
    const replacement = Array.from(db.memories.values()).find((memory) => memory.text === 'replacement memory');
    expect(replacement).toBeTruthy();
    expect(db.memoryShares.some((share) => share.memory_id === replacement?.id && share.agent_id === otherAgentId)).toBe(true);
  });
});
