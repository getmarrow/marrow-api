import { describe, it, expect, beforeAll } from 'vitest';
import { setupTestDb } from './helpers';
import { SnapshotService } from '../services/snapshot.service';

describe('Tier 14-15: Snapshots & Restore', () => {
  let db: D1Database;
  let service: SnapshotService;
  let accountId: string;
  let snapshotId: string;

  beforeAll(async () => {
    db = await setupTestDb();
    service = new SnapshotService(db);
    accountId = 'snapshot-account-' + Date.now();

    await db.prepare('INSERT INTO accounts (id, name, email, tier) VALUES (?, ?, ?, ?)').bind(accountId, 'Test', 'test@example.com', 'free').run();
  });

  it('should create snapshot', async () => {
    const result = await service.createSnapshot(accountId, 'my snapshot', ['tag1', 'tag2']);
    expect(result).toBeDefined();
    expect(result.snapshot_id).toBeDefined();
    snapshotId = result.snapshot_id;
  });

  it('should list snapshots', async () => {
    const snapshots = await service.listSnapshots(accountId);
    expect(Array.isArray(snapshots)).toBe(true);
    expect(snapshots.length).toBeGreaterThan(0);
  });

  it('should get snapshot', async () => {
    const snapshot = await service.getSnapshot(snapshotId, accountId);
    expect(snapshot).toBeDefined();
    expect(snapshot?.id).toBe(snapshotId);
  });

  it('should enforce account isolation on get', async () => {
    const otherAccount = 'other-' + Date.now();
    await db.prepare('INSERT INTO accounts (id, name, email, tier) VALUES (?, ?, ?, ?)').bind(otherAccount, 'Other', 'other@example.com', 'free').run();

    const snapshot = await service.getSnapshot(snapshotId, otherAccount);
    expect(snapshot).toBeNull();
  });

  it('should diff snapshots', async () => {
    const snap2 = await service.createSnapshot(accountId, 'second snapshot');
    const diff = await service.diffSnapshot(snapshotId, snap2.snapshot_id, accountId);
    expect(diff).toBeDefined();
    expect(typeof diff.added).toBe('number');
    expect(typeof diff.removed).toBe('number');
  });

  it('should restore snapshot', async () => {
    const result = await service.restoreSnapshot(snapshotId, accountId);
    expect(result).toBeDefined();
    expect(result.restore_id).toBeDefined();
  });

  it('should get restore status', async () => {
    const restore = await service.restoreSnapshot(snapshotId, accountId);
    const status = await service.getRestoreStatus(restore.restore_id, accountId);
    expect(status).toBeDefined();
    expect(status?.status).toBeDefined();
  });

  it('should delete snapshot', async () => {
    const snap = await service.createSnapshot(accountId, 'to delete');
    await service.deleteSnapshot(snap.snapshot_id, accountId);
    const retrieved = await service.getSnapshot(snap.snapshot_id, accountId);
    expect(retrieved).toBeNull();
  });
});
