/**
 * Tier 13: Immutable Audit Logs with SHA-256 hash chain
 */
import { AuditLogEntry } from '../types';
import { sha256, uuid, now } from '../utils/crypto';

export class AuditService {
  constructor(private db: D1Database) {}

  async log(
    accountId: string,
    action: string,
    resourceType: string,
    resourceId: string,
    changes?: Record<string, unknown>
  ): Promise<void> {
    try {
      const id = uuid();
      const ts = now();

      // Get previous hash for chain
      const prev = await this.db
        .prepare('SELECT hash FROM audit_log ORDER BY created_at DESC LIMIT 1')
        .first<{ hash: string }>();
      const prevHash = prev?.hash || 'genesis';

      const hashInput = prevHash + ts + action + JSON.stringify(changes || {});
      const hash = await sha256(hashInput);

      await this.db
        .prepare('INSERT INTO audit_log (id, timestamp, account_id, action, resource_type, resource_id, changes, hash, prev_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, ts, accountId, action, resourceType, resourceId, changes ? JSON.stringify(changes) : null, hash, prevHash, ts)
        .run();
    } catch (e) {
      console.error('Audit log error:', e);
    }
  }

  async getAuditLog(opts: {
    account_id?: string;
    start_time?: string;
    end_time?: string;
    resource_type?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ entries: AuditLogEntry[]; chain_valid: boolean }> {
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (opts.account_id) { conditions.push('account_id = ?'); params.push(opts.account_id); }
    if (opts.start_time) { conditions.push('timestamp >= ?'); params.push(opts.start_time); }
    if (opts.end_time) { conditions.push('timestamp <= ?'); params.push(opts.end_time); }
    if (opts.resource_type) { conditions.push('resource_type = ?'); params.push(opts.resource_type); }

    let sql = 'SELECT * FROM audit_log';
    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY created_at ASC';
    if (opts.limit) { sql += ' LIMIT ?'; params.push(opts.limit); }
    if (opts.offset) { sql += ' OFFSET ?'; params.push(opts.offset); }

    const res = await this.db.prepare(sql).bind(...params).all<Record<string, unknown>>();
    const entries = (res.results || []).map(r => this.rowToEntry(r));

    // Verify chain integrity
    let chainValid = true;
    for (let i = 1; i < entries.length; i++) {
      if (entries[i].prev_hash !== entries[i - 1].hash) {
        chainValid = false;
        break;
      }
    }

    return { entries, chain_valid: chainValid };
  }

  async verifyChain(): Promise<{ valid: boolean; broken_at?: number; total_entries: number }> {
    const res = await this.db.prepare('SELECT * FROM audit_log ORDER BY created_at ASC').all<Record<string, unknown>>();
    const entries = (res.results || []).map(r => this.rowToEntry(r));

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const expectedPrev = i === 0 ? 'genesis' : entries[i - 1].hash;
      if (entry.prev_hash !== expectedPrev) {
        return { valid: false, broken_at: i, total_entries: entries.length };
      }

      // Verify hash itself
      const hashInput = entry.prev_hash + entry.timestamp + entry.action + JSON.stringify(entry.changes || {});
      const expectedHash = await sha256(hashInput);
      if (entry.hash !== expectedHash) {
        return { valid: false, broken_at: i, total_entries: entries.length };
      }
    }

    return { valid: true, total_entries: entries.length };
  }

  private rowToEntry(row: Record<string, unknown>): AuditLogEntry {
    return {
      id: String(row.id),
      timestamp: String(row.timestamp),
      account_id: String(row.account_id),
      action: String(row.action),
      resource_type: String(row.resource_type),
      resource_id: String(row.resource_id),
      changes: row.changes ? JSON.parse(String(row.changes)) : undefined,
      hash: String(row.hash),
      prev_hash: row.prev_hash ? String(row.prev_hash) : undefined,
      created_at: String(row.created_at),
    };
  }
}
