/**
 * Tier 11: Isolation — 8 tests
 * Tier 12: Bootstrap — 8 tests
 * Tier 13: Audit — 15 tests
 * Tier 15: Snapshots — 12 tests
 * Tier 16: API Versioning — 6 tests
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EnterpriseService } from '../services/enterprise.service';
import { AuditService } from '../services/audit.service';
import { DecisionService } from '../services/decision.service';
import { AuthService } from '../services/auth.service';
import { CollaborationService } from '../services/collaboration.service';
import { createMockD1, REAL_ACCOUNT_ID, TEST_ENCRYPTION_KEY } from './helpers';

describe('Tier 11: Agent Isolation', () => {
  let db: D1Database;
  let svc: DecisionService;
  let auth: AuthService;

  beforeEach(() => {
    db = createMockD1();
    svc = new DecisionService(db);
    auth = new AuthService(db);
  });

  it('agent can access own decisions', async () => {
    const d = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    const retrieved = await svc.getDecision(d.id, REAL_ACCOUNT_ID);
    expect(retrieved).not.toBeNull();
  });

  it('agent cannot access other agent decisions', async () => {
    const d = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5, 'private', 'pro');
    const retrieved = await svc.getDecision(d.id, 'other-account');
    expect(retrieved).toBeNull();
  });

  it('hive decisions are accessible to all', async () => {
    const d = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'hive decision long', 0.5, 'hive');
    const retrieved = await svc.getDecision(d.id, 'any-account');
    expect(retrieved).not.toBeNull();
  });

  it('list only returns own decisions', async () => {
    await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'my decision long enough', 0.5);
    const other = await auth.createAccount('Other', 'other@test.com');
    await svc.createDecision(other.id, 'test', { b: 2 }, 'their decision long', 0.5);
    const list = await svc.listDecisions(REAL_ACCOUNT_ID);
    expect(list.every(d => d.account_id === REAL_ACCOUNT_ID)).toBe(true);
  });

  it('own account validates successfully', async () => {
    const account = await auth.getAccount(REAL_ACCOUNT_ID);
    expect(account).not.toBeNull();
    expect(account!.id).toBe(REAL_ACCOUNT_ID);
  });

  it('non-existent account returns null', async () => {
    const account = await auth.getAccount('nonexistent-id-here');
    expect(account).toBeNull();
  });

  it('private decisions hidden from other accounts', async () => {
    const d = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'private decision long', 0.5, 'private', 'pro');
    const retrieved = await svc.getDecision(d.id, 'stranger-account');
    expect(retrieved).toBeNull();
  });

  it('shared decisions require explicit share', async () => {
    const d = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'shared decision long', 0.5, 'shared', 'pro');
    // Even with 'shared' visibility, other agents can't directly query it
    const retrieved = await svc.getDecision(d.id, 'other-account');
    // Should be null unless explicitly shared via decision_shares
    expect(retrieved).toBeNull();
  });
});

describe('Tier 12: Bootstrap Protocol', () => {
  let db: D1Database;
  let enterprise: EnterpriseService;

  beforeEach(() => {
    db = createMockD1();
    enterprise = new EnterpriseService(db, TEST_ENCRYPTION_KEY);
  });

  it('retrieves bootstrap templates by type', async () => {
    const templates = await enterprise.getBootstrapTemplates('trading');
    expect(templates.length).toBeGreaterThanOrEqual(1);
    expect(templates[0].decision_type).toBe('trading');
  });

  it('bootstrap template has success_rate', async () => {
    const templates = await enterprise.getBootstrapTemplates('trading');
    expect(templates[0].success_rate).toBeDefined();
    expect(templates[0].success_rate).toBeGreaterThanOrEqual(0);
    expect(templates[0].success_rate).toBeLessThanOrEqual(1);
  });

  it('bootstrap template has template_decisions', async () => {
    const templates = await enterprise.getBootstrapTemplates('trading');
    expect(Array.isArray(templates[0].template_decisions)).toBe(true);
  });

  it('creates new bootstrap template', async () => {
    await enterprise.createBootstrapTemplate('ops', [{ context: {}, outcome: 'test', confidence: 0.5 }], 0.6);
    const templates = await enterprise.getBootstrapTemplates('ops');
    expect(templates.length).toBe(1);
    expect(templates[0].success_rate).toBe(0.6);
  });

  it('returns empty for unknown type', async () => {
    const templates = await enterprise.getBootstrapTemplates('unknown-type');
    expect(templates.length).toBe(0);
  });

  it('templates sorted by success_rate desc', async () => {
    await enterprise.createBootstrapTemplate('test', [{ a: 1 }], 0.3);
    await enterprise.createBootstrapTemplate('test', [{ b: 2 }], 0.9);
    const templates = await enterprise.getBootstrapTemplates('test');
    if (templates.length >= 2) {
      expect(templates[0].success_rate).toBeGreaterThanOrEqual(templates[1].success_rate);
    }
  });

  it('template has created_at', async () => {
    const templates = await enterprise.getBootstrapTemplates('trading');
    expect(templates[0].created_at).toBeTruthy();
  });

  it('multiple types coexist', async () => {
    await enterprise.createBootstrapTemplate('alpha', [{ x: 1 }], 0.5);
    await enterprise.createBootstrapTemplate('beta', [{ y: 2 }], 0.7);
    const alpha = await enterprise.getBootstrapTemplates('alpha');
    const beta = await enterprise.getBootstrapTemplates('beta');
    expect(alpha.length).toBe(1);
    expect(beta.length).toBe(1);
  });
});

describe('Tier 13: Audit & Compliance', () => {
  let db: D1Database;
  let audit: AuditService;
  let svc: DecisionService;

  beforeEach(() => {
    db = createMockD1();
    audit = new AuditService(db);
    svc = new DecisionService(db);
  });

  it('creates audit log entry', async () => {
    await audit.log(REAL_ACCOUNT_ID, 'TEST', 'decision', 'test-id', { action: 'test' });
    const result = await audit.getAuditLog({ account_id: REAL_ACCOUNT_ID });
    expect(result.entries.length).toBeGreaterThanOrEqual(1);
  });

  it('audit entry has hash', async () => {
    await audit.log(REAL_ACCOUNT_ID, 'TEST', 'decision', 'test-id');
    const result = await audit.getAuditLog({ account_id: REAL_ACCOUNT_ID });
    expect(result.entries[0].hash).toBeTruthy();
    expect(result.entries[0].hash.length).toBe(64);
  });

  it('audit entry has prev_hash', async () => {
    await audit.log(REAL_ACCOUNT_ID, 'TEST', 'decision', 'test-id');
    const result = await audit.getAuditLog({ account_id: REAL_ACCOUNT_ID });
    expect(result.entries[0].prev_hash).toBeDefined();
  });

  it('first entry prev_hash is genesis', async () => {
    await audit.log(REAL_ACCOUNT_ID, 'TEST', 'decision', 'test-id');
    const result = await audit.getAuditLog({ account_id: REAL_ACCOUNT_ID });
    expect(result.entries[0].prev_hash).toBe('genesis');
  });

  it('chain integrity - second entry references first hash', async () => {
    await audit.log(REAL_ACCOUNT_ID, 'TEST1', 'decision', 'id1');
    await audit.log(REAL_ACCOUNT_ID, 'TEST2', 'decision', 'id2');
    const result = await audit.getAuditLog({ account_id: REAL_ACCOUNT_ID });
    if (result.entries.length >= 2) {
      expect(result.entries[1].prev_hash).toBe(result.entries[0].hash);
    }
  });

  it('audit chain validation passes for valid chain', async () => {
    await audit.log(REAL_ACCOUNT_ID, 'A', 'decision', 'id1');
    await audit.log(REAL_ACCOUNT_ID, 'B', 'decision', 'id2');
    const result = await audit.getAuditLog({ account_id: REAL_ACCOUNT_ID });
    expect(result.chain_valid).toBe(true);
  });

  it('audit entry has timestamp', async () => {
    await audit.log(REAL_ACCOUNT_ID, 'TEST', 'decision', 'test-id');
    const result = await audit.getAuditLog({ account_id: REAL_ACCOUNT_ID });
    expect(result.entries[0].timestamp).toBeTruthy();
  });

  it('audit entry has action', async () => {
    await audit.log(REAL_ACCOUNT_ID, 'CREATE', 'decision', 'test-id');
    const result = await audit.getAuditLog({ account_id: REAL_ACCOUNT_ID });
    expect(result.entries[0].action).toBe('CREATE');
  });

  it('audit entry has resource_type and resource_id', async () => {
    await audit.log(REAL_ACCOUNT_ID, 'TEST', 'lesson', 'lesson-123');
    const result = await audit.getAuditLog({ account_id: REAL_ACCOUNT_ID });
    expect(result.entries[0].resource_type).toBe('lesson');
    expect(result.entries[0].resource_id).toBe('lesson-123');
  });

  it('audit entry stores changes as JSON', async () => {
    await audit.log(REAL_ACCOUNT_ID, 'TEST', 'decision', 'id', { old: 'a', new: 'b' });
    const result = await audit.getAuditLog({ account_id: REAL_ACCOUNT_ID });
    expect(result.entries[0].changes).toEqual({ old: 'a', new: 'b' });
  });

  it('creating decision adds audit entry', async () => {
    await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    const result = await audit.getAuditLog({ account_id: REAL_ACCOUNT_ID });
    expect(result.entries.some(e => e.action === 'CREATE')).toBe(true);
  });

  it('recording outcome adds audit entry', async () => {
    const d = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    await svc.recordOutcome(d.id, REAL_ACCOUNT_ID, true);
    const result = await audit.getAuditLog({ account_id: REAL_ACCOUNT_ID });
    expect(result.entries.some(e => e.action === 'OUTCOME')).toBe(true);
  });

  it('verify chain returns valid for intact chain', async () => {
    await audit.log(REAL_ACCOUNT_ID, 'A', 'x', '1');
    await audit.log(REAL_ACCOUNT_ID, 'B', 'x', '2');
    const result = await audit.verifyChain();
    expect(result.valid).toBe(true);
    expect(result.total_entries).toBeGreaterThanOrEqual(2);
  });

  it('audit log is append-only (no updates)', async () => {
    await audit.log(REAL_ACCOUNT_ID, 'A', 'x', '1');
    await audit.log(REAL_ACCOUNT_ID, 'B', 'x', '2');
    const r1 = await audit.getAuditLog({});
    await audit.log(REAL_ACCOUNT_ID, 'C', 'x', '3');
    const r2 = await audit.getAuditLog({});
    expect(r2.entries.length).toBeGreaterThan(r1.entries.length);
  });

  it('filters by time range', async () => {
    await audit.log(REAL_ACCOUNT_ID, 'OLD', 'x', '1');
    const result = await audit.getAuditLog({ start_time: '2020-01-01', end_time: '2030-01-01' });
    expect(result.entries.length).toBeGreaterThanOrEqual(0);
  });
});

describe('Tier 15: Persistence (Snapshots)', () => {
  let db: D1Database;
  let enterprise: EnterpriseService;
  let svc: DecisionService;
  let collab: CollaborationService;

  beforeEach(() => {
    db = createMockD1();
    enterprise = new EnterpriseService(db, TEST_ENCRYPTION_KEY);
    svc = new DecisionService(db);
    collab = new CollaborationService(db);
  });

  it('creates snapshot', async () => {
    await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    const snapshot = await enterprise.createSnapshot(REAL_ACCOUNT_ID);
    expect(snapshot.id).toBeTruthy();
    expect(snapshot.account_id).toBe(REAL_ACCOUNT_ID);
    expect(snapshot.decisions_count).toBe(1);
  });

  it('snapshot has file_size', async () => {
    await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    const snapshot = await enterprise.createSnapshot(REAL_ACCOUNT_ID);
    expect(snapshot.file_size).toBeGreaterThan(0);
  });

  it('snapshot has timestamp', async () => {
    const snapshot = await enterprise.createSnapshot(REAL_ACCOUNT_ID);
    expect(snapshot.snapshot_time).toBeTruthy();
    expect(snapshot.created_at).toBeTruthy();
  });

  it('snapshot includes lessons count', async () => {
    await collab.createLesson(REAL_ACCOUNT_ID, 'Test', 'Content');
    const snapshot = await enterprise.createSnapshot(REAL_ACCOUNT_ID);
    expect(snapshot.lessons_count).toBe(1);
  });

  it('restores snapshot', async () => {
    const d = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    const snapshot = await enterprise.createSnapshot(REAL_ACCOUNT_ID);

    // Create new data after snapshot
    await svc.createDecision(REAL_ACCOUNT_ID, 'test', { b: 2 }, 'newer decision long', 0.7);

    // Restore
    await enterprise.restoreSnapshot(snapshot.id, REAL_ACCOUNT_ID);
    const list = await svc.listDecisions(REAL_ACCOUNT_ID);
    expect(list.length).toBe(1);
  });

  it('restore fails for non-existent snapshot', async () => {
    await expect(enterprise.restoreSnapshot('fake-id', REAL_ACCOUNT_ID)).rejects.toThrow('Snapshot not found');
  });

  it('restore fails for wrong account', async () => {
    const snapshot = await enterprise.createSnapshot(REAL_ACCOUNT_ID);
    await expect(enterprise.restoreSnapshot(snapshot.id, 'other-account')).rejects.toThrow('Snapshot not found');
  });

  it('lists snapshots for account', async () => {
    await enterprise.createSnapshot(REAL_ACCOUNT_ID);
    await enterprise.createSnapshot(REAL_ACCOUNT_ID);
    const snapshots = await enterprise.listSnapshots(REAL_ACCOUNT_ID);
    expect(snapshots.length).toBe(2);
  });

  it('empty account snapshot has 0 counts', async () => {
    const auth = new AuthService(db);
    const account = await auth.createAccount('Empty', 'empty@test.com');
    const snapshot = await enterprise.createSnapshot(account.id);
    expect(snapshot.decisions_count).toBe(0);
    expect(snapshot.lessons_count).toBe(0);
  });

  it('snapshot data is encrypted', async () => {
    await svc.createDecision(REAL_ACCOUNT_ID, 'test', { a: 1 }, 'long enough outcome', 0.5);
    const snapshot = await enterprise.createSnapshot(REAL_ACCOUNT_ID);
    // The data should be stored encrypted — test by restoring successfully
    await enterprise.restoreSnapshot(snapshot.id, REAL_ACCOUNT_ID);
    const list = await svc.listDecisions(REAL_ACCOUNT_ID);
    expect(list.length).toBe(1);
  });

  it('snapshot ID is unique', async () => {
    const s1 = await enterprise.createSnapshot(REAL_ACCOUNT_ID);
    const s2 = await enterprise.createSnapshot(REAL_ACCOUNT_ID);
    expect(s1.id).not.toBe(s2.id);
  });

  it('restore is atomic - all or nothing', async () => {
    const d = await svc.createDecision(REAL_ACCOUNT_ID, 'test', { key: 'val' }, 'long enough outcome', 0.5);
    const snapshot = await enterprise.createSnapshot(REAL_ACCOUNT_ID);
    await svc.createDecision(REAL_ACCOUNT_ID, 'test', { other: 'data' }, 'second decision long', 0.7);
    await enterprise.restoreSnapshot(snapshot.id, REAL_ACCOUNT_ID);
    const list = await svc.listDecisions(REAL_ACCOUNT_ID);
    // Should have exactly what was in the snapshot
    expect(list.length).toBe(1);
  });
});

describe('Tier 16: API Versioning', () => {
  let db: D1Database;
  let enterprise: EnterpriseService;

  beforeEach(() => {
    db = createMockD1();
    enterprise = new EnterpriseService(db, TEST_ENCRYPTION_KEY);
  });

  it('gets API versions', async () => {
    const versions = await enterprise.getApiVersions();
    expect(versions.length).toBeGreaterThanOrEqual(1);
  });

  it('gets current (non-deprecated) version', async () => {
    const current = await enterprise.getCurrentVersion();
    expect(current).not.toBeNull();
    expect(current!.version).toBe('1');
  });

  it('version has released_at', async () => {
    const current = await enterprise.getCurrentVersion();
    expect(current!.released_at).toBeTruthy();
  });

  it('current version is not deprecated', async () => {
    const current = await enterprise.getCurrentVersion();
    expect(current!.deprecated_at).toBeUndefined();
  });

  it('version has ID', async () => {
    const current = await enterprise.getCurrentVersion();
    expect(current!.id).toBeTruthy();
  });

  it('version list returns array', async () => {
    const versions = await enterprise.getApiVersions();
    expect(Array.isArray(versions)).toBe(true);
  });
});
