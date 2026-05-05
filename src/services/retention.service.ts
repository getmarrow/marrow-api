/**
 * Retention Service — delete decisions past tier retention limit
 * Called by cron every 6 hours
 */
import { now, uuid } from '../utils/crypto';
import { safely } from '../utils/safely';

interface TierConfig {
  id: string;
  name: string;
  retention_days: number;
}

export class RetentionService {
  constructor(private db: D1Database) {}

  /**
   * Run retention cleanup for all accounts
   * Returns number of decisions deleted
   */
  async cleanup(): Promise<number> {
    // Get tier configs (skip enterprise with -1 = unlimited)
    const tiers = await this.db
      .prepare('SELECT * FROM tiers WHERE retention_days > 0')
      .all<TierConfig>();

    let totalDeleted = 0;

    for (const tier of (tiers.results || [])) {
      const cutoff = new Date(Date.now() - tier.retention_days * 24 * 60 * 60 * 1000).toISOString();

      // Count before deleting for audit
      const countRow = await this.db
        .prepare(`
          SELECT COUNT(*) as cnt FROM decisions
          WHERE account_id IN (SELECT id FROM accounts WHERE tier = ?)
          AND created_at < ?
        `)
        .bind(tier.name, cutoff)
        .first<{ cnt: number }>();

      const count = countRow?.cnt ?? 0;
      if (count === 0) continue;

      const res = await this.db
        .prepare(`
          DELETE FROM decisions
          WHERE account_id IN (SELECT id FROM accounts WHERE tier = ?)
          AND created_at < ?
        `)
        .bind(tier.name, cutoff)
        .run();

      const deleted = res.meta?.changes ?? 0;
      totalDeleted += deleted;

      // Audit log entry for retention cleanup
      if (deleted > 0) {
        const ts = now();
        await this.db
          .prepare('INSERT INTO audit_log (id, timestamp, account_id, action, resource_type, resource_id, changes, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(uuid(), ts, 'system', 'RETENTION_CLEANUP', 'decisions', tier.name, JSON.stringify({ deleted, tier: tier.name, cutoff }), uuid(), ts)
          .run()
          .catch((e) => safely(() => { console.warn('[silent-catch]', e); }, 'silent-catch'));
      }
    }

    return totalDeleted;
  }
}
