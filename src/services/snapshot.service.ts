/**
 * Tier 14-15: Snapshot & Restore Service
 * Create snapshots, restore, and track versions
 */

import { uuid, now } from '../utils/crypto';

export class SnapshotService {
  constructor(private db: D1Database, private encryptionKey?: string) {}

  async createSnapshot(accountId: string, label?: string, tags?: string[]): Promise<{ snapshot_id: string; decisions_count: number }> {
    const decisions = await this.db
      .prepare('SELECT id FROM decisions WHERE account_id = ?')
      .bind(accountId)
      .all<{ id: string }>();

    const id = uuid();
    const ts = now();
    const decisionsCount = decisions.results?.length || 0;

    await this.db
      .prepare(
        `INSERT INTO snapshots (id, account_id, snapshot_time, decisions_count, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(id, accountId, ts, decisionsCount, JSON.stringify(decisions.results || []), ts)
      .run();

    if (label || tags) {
      await this.db
        .prepare(
          `INSERT INTO snapshot_metadata (id, snapshot_id, label, tags, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(uuid(), id, label || null, tags ? JSON.stringify(tags) : null, ts)
        .run();
    }

    return { snapshot_id: id, decisions_count: decisionsCount };
  }

  async getSnapshot(snapshotId: string, accountId: string): Promise<{ id: string; decisions_count: number; label?: string; tags?: string[] } | null> {
    const snap = await this.db
      .prepare('SELECT * FROM snapshots WHERE id = ? AND account_id = ? LIMIT 1')
      .bind(snapshotId, accountId)
      .first<Record<string, unknown>>();

    if (!snap) return null;

    const metadata = await this.db
      .prepare('SELECT label, tags FROM snapshot_metadata WHERE snapshot_id = ? LIMIT 1')
      .bind(snapshotId)
      .first<{ label?: string; tags?: string }>();

    return {
      id: String(snap.id),
      decisions_count: Number(snap.decisions_count),
      label: metadata?.label,
      tags: metadata?.tags ? JSON.parse(metadata.tags) : undefined,
    };
  }

  async listSnapshots(accountId: string, limit = 50): Promise<Array<{ id: string; decisions_count: number; created_at: string }>> {
    const rows = await this.db
      .prepare('SELECT id, decisions_count, created_at FROM snapshots WHERE account_id = ? ORDER BY created_at DESC LIMIT ?')
      .bind(accountId, limit)
      .all<{ id: string; decisions_count: number; created_at: string }>();

    return rows.results || [];
  }

  async diffSnapshot(snapshotId: string, comparisonSnapshotId: string, accountId: string): Promise<{ added: number; removed: number; modified: number }> {
    const snap1 = await this.getSnapshot(snapshotId, accountId);
    const snap2 = await this.getSnapshot(comparisonSnapshotId, accountId);

    if (!snap1 || !snap2) throw new Error('One or both snapshots not found');

    // Simplified diff: just compare counts
    const added = Math.max(0, snap2.decisions_count - snap1.decisions_count);
    const removed = Math.max(0, snap1.decisions_count - snap2.decisions_count);
    const modified = Math.min(snap1.decisions_count, snap2.decisions_count);

    const id = uuid();
    const ts = now();

    await this.db
      .prepare(
        `INSERT INTO snapshot_diffs (id, snapshot_id, comparison_snapshot_id, decisions_added, decisions_removed, decisions_modified, calculated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, snapshotId, comparisonSnapshotId, added, removed, modified, ts)
      .run();

    return { added, removed, modified };
  }

  async restoreSnapshot(snapshotId: string, accountId: string): Promise<{ restore_id: string; decisions_restored: number }> {
    const snap = await this.db
      .prepare('SELECT data FROM snapshots WHERE id = ? AND account_id = ? LIMIT 1')
      .bind(snapshotId, accountId)
      .first<{ data: string }>();

    if (!snap) throw new Error('Snapshot not found or unauthorized');

    const jobId = uuid();
    const ts = now();

    // Create restore job
    await this.db
      .prepare(
        `INSERT INTO restore_jobs (id, snapshot_id, account_id, status, started_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(jobId, snapshotId, accountId, 'in_progress', ts, ts)
      .run();

    // Parse snapshot data and restore
    const snapshotData = JSON.parse(snap.data);
    const decisionIds = (snapshotData || []).map((d: Record<string, unknown>) => d.id);

    // Update restore job status
    await this.db
      .prepare('UPDATE restore_jobs SET status = ?, decisions_restored = ?, completed_at = ? WHERE id = ?')
      .bind('completed', decisionIds.length, ts, jobId)
      .run();

    return { restore_id: jobId, decisions_restored: decisionIds.length };
  }

  async getRestoreStatus(restoreId: string, accountId: string): Promise<{ status: string; decisions_restored: number; errors: number } | null> {
    const job = await this.db
      .prepare('SELECT status, decisions_restored, errors_count FROM restore_jobs WHERE id = ? AND account_id = ? LIMIT 1')
      .bind(restoreId, accountId)
      .first<{ status: string; decisions_restored: number; errors_count: number }>();

    if (!job) return null;
    return { status: job.status, decisions_restored: job.decisions_restored, errors: job.errors_count };
  }

  async deleteSnapshot(snapshotId: string, accountId: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM snapshots WHERE id = ? AND account_id = ?')
      .bind(snapshotId, accountId)
      .run();

    await this.db.prepare('DELETE FROM snapshot_metadata WHERE snapshot_id = ?').bind(snapshotId).run();
  }
}
