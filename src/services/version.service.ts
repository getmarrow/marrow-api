/**
 * Tier 16: Version History Service
 * Track API versions and migration guides
 */

import { uuid, now } from '../utils/crypto';

export interface ApiVersion {
  version: string;
  released_at: string;
  deprecated_at?: string;
  breaking_changes?: string;
  changes?: string;
}

export class VersionService {
  constructor(private db: D1Database) {}

  async getVersions(): Promise<ApiVersion[]> {
    const rows = await this.db
      .prepare('SELECT version, released_at, deprecated_at, breaking_changes, changes FROM versions ORDER BY released_at DESC')
      .all<Record<string, unknown>>();

    return (rows.results || []).map(r => ({
      version: String(r.version),
      released_at: String(r.released_at),
      deprecated_at: r.deprecated_at ? String(r.deprecated_at) : undefined,
      breaking_changes: r.breaking_changes ? String(r.breaking_changes) : undefined,
      changes: r.changes ? String(r.changes) : undefined,
    }));
  }

  async getCurrentVersion(): Promise<ApiVersion | null> {
    const row = await this.db
      .prepare('SELECT version, released_at, breaking_changes, changes FROM versions WHERE deprecated_at IS NULL ORDER BY released_at DESC LIMIT 1')
      .first<Record<string, unknown>>();

    if (!row) return null;
    return {
      version: String(row.version),
      released_at: String(row.released_at),
      breaking_changes: row.breaking_changes ? String(row.breaking_changes) : undefined,
      changes: row.changes ? String(row.changes) : undefined,
    };
  }

  async getMigrationGuide(fromVersion: string, toVersion: string): Promise<{ guide: string; breaking_changes?: string } | null> {
    const guide = await this.db
      .prepare('SELECT guide, breaking_changes FROM migration_guides WHERE from_version = ? AND to_version = ? LIMIT 1')
      .bind(fromVersion, toVersion)
      .first<{ guide: string; breaking_changes?: string }>();

    if (!guide) return null;
    return { guide: guide.guide, breaking_changes: guide.breaking_changes };
  }

  async addVersion(version: string, changes?: string, breakingChanges?: string): Promise<void> {
    const id = uuid();
    const ts = now();

    await this.db
      .prepare(
        `INSERT INTO versions (id, version, released_at, breaking_changes, changes, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(id, version, ts, breakingChanges || null, changes || null, ts)
      .run();
  }

  async addMigrationGuide(fromVersion: string, toVersion: string, guide: string, breakingChanges?: string): Promise<void> {
    const id = uuid();
    const ts = now();

    await this.db
      .prepare(
        `INSERT INTO migration_guides (id, from_version, to_version, guide, breaking_changes, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(id, fromVersion, toVersion, guide, breakingChanges || null, ts)
      .run();
  }

  async getDeprecationWarnings(endpoint?: string): Promise<Array<{ endpoint: string; replacement?: string; message: string; removed_in?: string }>> {
    let sql = 'SELECT endpoint, replacement_endpoint, message, removed_in FROM deprecation_warnings';
    const params: unknown[] = [];

    if (endpoint) {
      sql += ' WHERE endpoint = ?';
      params.push(endpoint);
    }

    const rows = await this.db.prepare(sql).bind(...params).all<Record<string, unknown>>();

    return (rows.results || []).map(r => ({
      endpoint: String(r.endpoint),
      replacement: r.replacement_endpoint ? String(r.replacement_endpoint) : undefined,
      message: String(r.message),
      removed_in: r.removed_in ? String(r.removed_in) : undefined,
    }));
  }
}
