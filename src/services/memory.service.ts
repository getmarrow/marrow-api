import { MemoryAuditEntry, MemoryStatus } from '../types';
import { now, uuid } from '../utils/crypto';

type MemoryAuditAction = MemoryAuditEntry['action'];

type MemoryAccessOptions = {
  includeDeleted?: boolean;
  accessAgentId?: string;
  accessAgentIds?: string[];
};

type MemoryImportItem = {
  text?: string;
  source?: string;
  tags?: string[];
  sharedWith?: string[];
};

interface NormalizedImportItem {
  text: string;
  source: string | null;
  tags: string[];
  sharedWith: string[];
}

interface MemoryRow {
  id: string;
  account_id: string;
  text: string;
  source: string | null;
  tags: string | null;
  status: MemoryStatus;
  supersedes: string | null;
  superseded_by: string | null;
  deleted_at: string | null;
  audit: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryView {
  id: string;
  text: string;
  status: MemoryStatus;
  createdAt: string;
  updatedAt: string;
  source: string | null;
  tags: string[];
  supersedes: string | null;
  supersededBy: string | null;
  deletedAt: string | null;
  audit: MemoryAuditEntry[];
}

interface ListFilters {
  status?: MemoryStatus;
  query?: string;
  includeDeleted?: boolean;
  limit?: number;
  agentId?: string;
  agentIds?: string[];
}

interface RetrieveFilters {
  limit?: number;
  includeStale?: boolean;
  from?: string;
  to?: string;
  tags?: string;
  source?: string;
  status?: MemoryStatus;
  shared?: boolean;
  agentId?: string;
  agentIds?: string[];
}

const VALID_STATUSES = new Set<MemoryStatus>(['active', 'outdated', 'superseded', 'deleted']);

export class MemoryService {
  constructor(private db: D1Database) {}

  async listMemories(accountId: string, filters: ListFilters = {}): Promise<MemoryView[]> {
    const limit = this.clampLimit(filters.limit, 20, 100);
    const agentIds = this.resolveAgentIds(filters.agentIds, filters.agentId);
    const { sql, binds } = this.buildMemoryQuery(accountId, {
      status: filters.status,
      query: filters.query,
      includeDeleted: filters.includeDeleted,
      limit,
      agentId: agentIds.length === 1 ? agentIds[0] : undefined,
      defaultToActiveOnly: false,
    });

    const rows = await this.db.prepare(sql).bind(...binds).all<MemoryRow>();
    const filteredRows = await this.filterRowsByAgentIds(rows.results || [], accountId, agentIds);
    return filteredRows.map((row) => this.toView(row));
  }

  async getMemory(id: string, accountId: string, options: MemoryAccessOptions = {}): Promise<MemoryView | null> {
    const row = await this.getAccessibleRow(id, accountId, this.resolveAgentIds(options.accessAgentIds, options.accessAgentId));
    if (!row) return null;
    if (!options.includeDeleted && row.status === 'deleted') return null;
    return this.toView(row);
  }

  async updateMemory(
    id: string,
    accountId: string,
    patch: { text?: string; source?: string | null; tags?: string[]; actor?: string; note?: string },
    options: MemoryAccessOptions = {}
  ): Promise<MemoryView | null> {
    const resolvedAgentIds = this.resolveAgentIds(options.accessAgentIds, options.accessAgentId);
    const row = await this.getAccessibleRow(id, accountId, resolvedAgentIds);
    if (!row || row.status === 'deleted') return null;

    const ts = now();
    const nextText = patch.text !== undefined ? this.sanitizeText(patch.text) : row.text;
    if (!nextText) throw new Error('Memory text is required');

    const nextSource = patch.source !== undefined ? this.sanitizeSource(patch.source) : row.source;
    const nextTags = patch.tags !== undefined ? this.sanitizeTags(patch.tags) : this.parseTags(row.tags);
    const nextAudit = this.pushAudit(row.audit, {
      action: 'edited',
      actor: patch.actor,
      note: patch.note || 'memory updated',
      source_changed: patch.source !== undefined,
      tags_changed: patch.tags !== undefined,
      text_changed: patch.text !== undefined,
    });

    await this.db
      .prepare(
        'UPDATE memories SET text = ?, source = ?, tags = ?, audit = ?, updated_at = ? WHERE id = ? AND account_id = ?'
      )
      .bind(nextText, nextSource, JSON.stringify(nextTags), JSON.stringify(nextAudit), ts, id, accountId)
      .run();

    return this.getMemory(id, accountId, { includeDeleted: true, accessAgentIds: resolvedAgentIds });
  }

  async deleteMemory(
    id: string,
    accountId: string,
    meta: { actor?: string; note?: string } = {},
    options: MemoryAccessOptions = {}
  ): Promise<MemoryView | null> {
    const row = await this.getAccessibleRow(id, accountId, this.resolveAgentIds(options.accessAgentIds, options.accessAgentId));
    if (!row) return null;
    if (row.status === 'deleted') return this.toView(row);

    const ts = now();
    const audit = this.pushAudit(row.audit, {
      action: 'deleted',
      actor: meta.actor,
      note: meta.note || 'memory deleted',
    });

    await this.db.batch([
      this.db
        .prepare(
          'UPDATE memories SET status = ?, deleted_at = ?, audit = ?, updated_at = ? WHERE id = ? AND account_id = ?'
        )
        .bind('deleted', ts, JSON.stringify(audit), ts, id, accountId),
      this.db
        .prepare('DELETE FROM memory_shares WHERE memory_id = ? AND account_id = ?')
        .bind(id, accountId),
    ]);

    return this.toView({
      ...row,
      status: 'deleted',
      deleted_at: ts,
      updated_at: ts,
      audit: JSON.stringify(audit),
    });
  }

  async markOutdated(
    id: string,
    accountId: string,
    meta: { actor?: string; note?: string } = {},
    options: MemoryAccessOptions = {}
  ): Promise<MemoryView | null> {
    const resolvedAgentIds = this.resolveAgentIds(options.accessAgentIds, options.accessAgentId);
    const row = await this.getAccessibleRow(id, accountId, resolvedAgentIds);
    if (!row || row.status === 'deleted' || row.status === 'superseded') return null;
    if (row.status === 'outdated') return this.toView(row);

    const ts = now();
    const audit = this.pushAudit(row.audit, {
      action: 'marked_outdated',
      actor: meta.actor,
      note: meta.note || 'memory marked outdated',
    });

    await this.db
      .prepare('UPDATE memories SET status = ?, audit = ?, updated_at = ? WHERE id = ? AND account_id = ?')
      .bind('outdated', JSON.stringify(audit), ts, id, accountId)
      .run();

    return this.getMemory(id, accountId, { includeDeleted: true, accessAgentIds: resolvedAgentIds });
  }

  async supersedeMemory(
    id: string,
    accountId: string,
    replacement: { text: string; source?: string; tags?: string[]; actor?: string; note?: string },
    options: MemoryAccessOptions = {}
  ): Promise<{ old: MemoryView; replacement: MemoryView } | null> {
    const resolvedAgentIds = this.resolveAgentIds(options.accessAgentIds, options.accessAgentId);
    const row = await this.getAccessibleRow(id, accountId, resolvedAgentIds);
    if (!row || row.status === 'deleted' || row.status === 'superseded') return null;

    const ts = now();
    const replacementId = uuid();
    const replacementText = this.sanitizeText(replacement.text);
    if (!replacementText) throw new Error('Replacement memory text is required');

    const replacementSource = replacement.source !== undefined
      ? this.sanitizeSource(replacement.source)
      : row.source;
    const replacementTags = replacement.tags !== undefined
      ? this.sanitizeTags(replacement.tags)
      : this.parseTags(row.tags);

    const oldAudit = this.pushAudit(row.audit, {
      action: 'superseded',
      actor: replacement.actor,
      note: replacement.note || 'memory superseded',
      replacement_id: replacementId,
    });
    const replacementAudit = this.pushAudit(null, {
      action: 'created_as_replacement',
      actor: replacement.actor,
      note: replacement.note || `replacement for ${id}`,
      supersedes: id,
    });

    // Atomic supersede: INSERT replacement + UPDATE original in one batch.
    // Previously two separate awaits — a crash between them left an active
    // replacement with the original still in pre-supersede state (dangling
    // duplicate). db.batch makes it all-or-nothing.
    await this.db.batch([
      this.db
        .prepare(
          'INSERT INTO memories (id, account_id, text, source, tags, status, supersedes, superseded_by, deleted_at, audit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(
          replacementId,
          accountId,
          replacementText,
          replacementSource,
          JSON.stringify(replacementTags),
          'active',
          id,
          null,
          null,
          JSON.stringify(replacementAudit),
          ts,
          ts
        ),
      this.db
        .prepare(
          'UPDATE memories SET status = ?, superseded_by = ?, audit = ?, updated_at = ? WHERE id = ? AND account_id = ?'
        )
        .bind('superseded', replacementId, JSON.stringify(oldAudit), ts, id, accountId),
    ]);

    const oldMemory = await this.getMemory(id, accountId, { includeDeleted: true, accessAgentIds: resolvedAgentIds });
    const newMemory = await this.getMemory(replacementId, accountId, { includeDeleted: true, accessAgentIds: resolvedAgentIds });
    if (!oldMemory || !newMemory) throw new Error('Failed to load superseded memory state');

    return { old: oldMemory, replacement: newMemory };
  }

  async shareMemory(
    id: string,
    accountId: string,
    agentIds: string[],
    actor?: string,
    options: MemoryAccessOptions = {}
  ): Promise<MemoryView | null> {
    const resolvedAgentIds = this.resolveAgentIds(options.accessAgentIds, options.accessAgentId);
    const row = await this.getAccessibleRow(id, accountId, resolvedAgentIds);
    if (!row || row.status === 'deleted') return null;

    const normalizedAgentIds = this.normalizeSharedWith(agentIds);
    const ts = now();

    for (const agentId of normalizedAgentIds) {
      await this.db
        .prepare(
          'INSERT OR IGNORE INTO memory_shares (id, memory_id, account_id, agent_id, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .bind(uuid(), id, accountId, agentId, ts)
        .run();
    }

    if (normalizedAgentIds.length > 0) {
      const audit = this.pushAudit(row.audit, {
        action: 'edited',
        actor,
        note: `shared with ${normalizedAgentIds.join(', ')}`,
      });
      await this.db
        .prepare('UPDATE memories SET audit = ?, updated_at = ? WHERE id = ? AND account_id = ?')
        .bind(JSON.stringify(audit), ts, id, accountId)
        .run();
    }

    return this.getMemory(id, accountId, { includeDeleted: true, accessAgentIds: resolvedAgentIds });
  }

  async retrieveMemories(accountId: string, query: string, filters: RetrieveFilters = {}): Promise<{ memories: MemoryView[]; query: string; count: number }> {
    const limit = this.clampLimit(filters.limit, 20, 100);
    const agentIds = this.resolveAgentIds(filters.agentIds, filters.agentId);
    const { sql, binds } = this.buildMemoryQuery(accountId, {
      status: filters.status,
      query,
      includeDeleted: filters.status === 'deleted',
      includeStale: filters.includeStale,
      limit,
      from: filters.from,
      to: filters.to,
      source: filters.source,
      shared: filters.shared,
      agentId: agentIds.length === 1 ? agentIds[0] : undefined,
      defaultToActiveOnly: true,
    });

    const rows = await this.db.prepare(sql).bind(...binds).all<MemoryRow>();
    const accessibleRows = await this.filterRowsByAgentIds(rows.results || [], accountId, agentIds);
    const requiredTags = this.parseRequestedTags(filters.tags);
    const memories = accessibleRows
      .map((row) => this.toView(row))
      .filter((memory) => requiredTags.length === 0 || requiredTags.every((tag) => memory.tags.map((item) => item.toLowerCase()).includes(tag)));

    return {
      memories,
      query,
      count: memories.length,
    };
  }

  async exportMemories(
    accountId: string,
    options: { format?: 'json' | 'csv'; status?: MemoryStatus | 'all'; tags?: string[]; agentId?: string; agentIds?: string[] } = {}
  ): Promise<{ exported_at: string; account_id: string; count: number; memories: MemoryView[]; format: 'json' | 'csv'; csv?: string }> {
    const status = options.status && options.status !== 'all' && VALID_STATUSES.has(options.status) ? options.status : undefined;
    const memories = await this.listMemories(accountId, {
      status,
      includeDeleted: options.status === 'all' || options.status === 'deleted',
      limit: 500,
      agentId: options.agentId,
      agentIds: options.agentIds || (options.agentId ? [options.agentId] : undefined),
    });
    const requiredTags = this.sanitizeTags(options.tags || []);
    const filtered = requiredTags.length === 0
      ? memories
      : memories.filter((memory) => requiredTags.every((tag) => memory.tags.map((item) => item.toLowerCase()).includes(tag.toLowerCase())));

    const format = options.format === 'csv' ? 'csv' : 'json';
    const payload: { exported_at: string; account_id: string; count: number; memories: MemoryView[]; format: 'json' | 'csv'; csv?: string } = {
      exported_at: now(),
      account_id: accountId,
      count: filtered.length,
      memories: filtered,
      format,
    };

    if (format === 'csv') {
      payload.csv = [
        'id,status,source,tags,created_at,updated_at,text',
        ...filtered.map((memory) => [
          this.escapeCsv(memory.id),
          this.escapeCsv(memory.status),
          this.escapeCsv(memory.source || ''),
          this.escapeCsv(memory.tags.join('|')),
          this.escapeCsv(memory.createdAt),
          this.escapeCsv(memory.updatedAt),
          this.escapeCsv(memory.text),
        ].join(',')),
      ].join('\n');
    }

    return payload;
  }

  async importMemories(
    accountId: string,
    memories: MemoryImportItem[],
    mode: 'merge' | 'replace'
  ): Promise<{ imported: number; skipped: number; errors: string[] }> {
    const items = Array.isArray(memories) ? memories.slice(0, 500) : [];
    const errors: string[] = [];
    let imported = 0;
    let skipped = 0;

    if (mode === 'replace') {
      const normalized = this.normalizeImportItems(items, { requireText: true, failPrefix: 'Import validation failed' });
      const ts = now();
      const statements: D1PreparedStatement[] = [
        this.db
          .prepare('DELETE FROM memory_shares WHERE account_id = ?')
          .bind(accountId),
        this.db
          .prepare("UPDATE memories SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE account_id = ? AND status != 'deleted'")
          .bind(ts, ts, accountId),
      ];

      for (const item of normalized) {
        const id = uuid();
        const audit = this.pushAudit(null, {
          action: 'bootstrapped',
          actor: 'import',
          note: 'memory imported via replace',
        });

        statements.push(
          this.db
            .prepare(
              'INSERT INTO memories (id, account_id, text, source, tags, status, supersedes, superseded_by, deleted_at, audit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            )
            .bind(id, accountId, item.text, item.source, JSON.stringify(item.tags), 'active', null, null, null, JSON.stringify(audit), ts, ts)
        );

        for (const agentId of item.sharedWith) {
          statements.push(
            this.db
              .prepare(
                'INSERT OR IGNORE INTO memory_shares (id, memory_id, account_id, agent_id, created_at) VALUES (?, ?, ?, ?, ?)'
              )
              .bind(uuid(), id, accountId, agentId, ts)
          );
        }
      }

      await this.db.batch(statements);
      return { imported: normalized.length, skipped: 0, errors: [] };
    }

    for (const item of items) {
      try {
        const normalized = this.normalizeImportItems([item], { requireText: false });
        if (normalized.length === 0) {
          skipped++;
          continue;
        }

        const prepared = normalized[0];
        const existing = await this.db
          .prepare(
            "SELECT id FROM memories WHERE account_id = ? AND text = ? AND COALESCE(source, '') = COALESCE(?, '') AND status != 'deleted' LIMIT 1"
          )
          .bind(accountId, prepared.text, prepared.source)
          .first<{ id: string }>();
        if (existing) {
          skipped++;
          continue;
        }

        const id = uuid();
        const ts = now();
        const audit = this.pushAudit(null, {
          action: 'bootstrapped',
          actor: 'import',
          note: 'memory imported via merge',
        });

        await this.db
          .prepare(
            'INSERT INTO memories (id, account_id, text, source, tags, status, supersedes, superseded_by, deleted_at, audit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
          )
          .bind(id, accountId, prepared.text, prepared.source, JSON.stringify(prepared.tags), 'active', null, null, null, JSON.stringify(audit), ts, ts)
          .run();

        for (const agentId of prepared.sharedWith) {
          await this.db
            .prepare(
              'INSERT OR IGNORE INTO memory_shares (id, memory_id, account_id, agent_id, created_at) VALUES (?, ?, ?, ?, ?)'
            )
            .bind(uuid(), id, accountId, agentId, ts)
            .run();
        }

        imported++;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown import error';
        errors.push(message);
      }
    }

    return { imported, skipped, errors };
  }

  private async getAccessibleRow(id: string, accountId: string, accessAgentIds: string[] = []): Promise<MemoryRow | null> {
    const row = await this.getRow(id, accountId);
    if (!row) return null;
    if (accessAgentIds.length === 0) return row;

    for (const accessAgentId of accessAgentIds) {
      const share = await this.db
        .prepare('SELECT id FROM memory_shares WHERE memory_id = ? AND account_id = ? AND agent_id = ? LIMIT 1')
        .bind(id, accountId, accessAgentId)
        .first<{ id: string }>();
      if (share) return row;
    }

    return null;
  }

  private resolveAgentIds(agentIds?: string[], agentId?: string): string[] {
    const raw = agentIds && agentIds.length > 0 ? agentIds : (agentId ? [agentId] : []);
    return Array.from(new Set(raw.map((value) => String(value || '').trim()).filter(Boolean)));
  }

  private async filterRowsByAgentIds(rows: MemoryRow[], accountId: string, agentIds: string[]): Promise<MemoryRow[]> {
    if (agentIds.length === 0) return rows;

    const filtered: MemoryRow[] = [];
    for (const row of rows) {
      const accessible = await this.getAccessibleRow(row.id, accountId, agentIds);
      if (accessible) filtered.push(row);
    }
    return filtered;
  }

  private async getRow(id: string, accountId: string): Promise<MemoryRow | null> {
    return this.db
      .prepare('SELECT * FROM memories WHERE id = ? AND account_id = ? LIMIT 1')
      .bind(id, accountId)
      .first<MemoryRow>();
  }

  private buildMemoryQuery(
    accountId: string,
    filters: {
      status?: MemoryStatus;
      query?: string;
      includeDeleted?: boolean;
      includeStale?: boolean;
      limit: number;
      agentId?: string;
      from?: string;
      to?: string;
      source?: string;
      shared?: boolean;
      defaultToActiveOnly: boolean;
    }
  ): { sql: string; binds: unknown[] } {
    const binds: unknown[] = [accountId];
    const where = ['m.account_id = ?'];
    const needsJoin = Boolean(filters.agentId);
    const join = needsJoin ? 'LEFT JOIN memory_shares ms ON ms.memory_id = m.id AND ms.account_id = m.account_id' : '';

    if (filters.status && VALID_STATUSES.has(filters.status)) {
      where.push('m.status = ?');
      binds.push(filters.status);
    } else if (filters.defaultToActiveOnly && !filters.includeStale) {
      where.push("m.status = 'active'");
    } else if (!filters.includeDeleted) {
      where.push("m.status != 'deleted'");
    }

    if (filters.query) {
      const term = `%${filters.query.trim().toLowerCase()}%`;
      where.push("(LOWER(m.text) LIKE ? OR LOWER(COALESCE(m.source, '')) LIKE ? OR LOWER(COALESCE(m.tags, '[]')) LIKE ?)");
      binds.push(term, term, term);
    }

    if (filters.agentId) {
      where.push('ms.agent_id = ?');
      binds.push(filters.agentId);
    }

    if (filters.from) {
      where.push('m.created_at >= ?');
      binds.push(filters.from);
    }

    if (filters.to) {
      where.push('m.created_at <= ?');
      binds.push(filters.to);
    }

    if (filters.source) {
      where.push('m.source = ?');
      binds.push(this.sanitizeSource(filters.source));
    }

    if (filters.shared === true) {
      where.push('EXISTS (SELECT 1 FROM memory_shares ms2 WHERE ms2.memory_id = m.id AND ms2.account_id = m.account_id)');
    } else if (filters.shared === false) {
      where.push('NOT EXISTS (SELECT 1 FROM memory_shares ms2 WHERE ms2.memory_id = m.id AND ms2.account_id = m.account_id)');
    }

    binds.push(filters.limit);

    return {
      sql: `SELECT DISTINCT m.* FROM memories m ${join} WHERE ${where.join(' AND ')} ORDER BY m.updated_at DESC LIMIT ?`,
      binds,
    };
  }

  private toView(row: MemoryRow): MemoryView {
    return {
      id: row.id,
      text: row.text,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      source: row.source,
      tags: this.parseTags(row.tags),
      supersedes: row.supersedes,
      supersededBy: row.superseded_by,
      deletedAt: row.deleted_at,
      audit: this.parseAudit(row.audit),
    };
  }

  private normalizeImportItems(
    items: MemoryImportItem[],
    options: { requireText: boolean; failPrefix?: string }
  ): NormalizedImportItem[] {
    const normalized: NormalizedImportItem[] = [];

    items.forEach((item, index) => {
      const text = this.sanitizeText(item.text || '');
      if (!text) {
        if (options.requireText) {
          const prefix = options.failPrefix || 'Validation failed';
          throw new Error(`${prefix}: row ${index + 1} is missing memory text`);
        }
        return;
      }

      normalized.push({
        text,
        source: this.sanitizeSource(item.source),
        tags: this.sanitizeTags(item.tags || []),
        sharedWith: this.normalizeSharedWith(item.sharedWith || []),
      });
    });

    return normalized;
  }

  private normalizeSharedWith(agentIds: string[]): string[] {
    return Array.from(
      new Set(
        (Array.isArray(agentIds) ? agentIds : [])
          .map((agentId) => String(agentId || '').trim())
          .filter(Boolean)
      )
    ).slice(0, 100);
  }

  private parseTags(raw: string | null): string[] {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.map((value) => String(value || '').trim()).filter(Boolean)
        : [];
    } catch {
      return [];
    }
  }

  private parseRequestedTags(raw?: string): string[] {
    if (!raw) return [];
    return raw
      .split(',')
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean);
  }

  private parseAudit(raw: string | null): MemoryAuditEntry[] {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed as MemoryAuditEntry[] : [];
    } catch {
      return [];
    }
  }

  private pushAudit(
    existing: string | null,
    entry: { action: MemoryAuditAction; actor?: string; note?: string; [key: string]: unknown }
  ): MemoryAuditEntry[] {
    const audit = this.parseAudit(existing);
    audit.push({
      action: entry.action,
      timestamp: now(),
      actor: entry.actor || 'system',
      note: String(entry.note || ''),
      ...Object.fromEntries(Object.entries(entry).filter(([key]) => !['action', 'actor', 'note'].includes(key))),
    });
    return audit.slice(-50);
  }

  private escapeCsv(value: string): string {
    const normalized = this.neutralizeCsvFormula(String(value || ''));
    return `"${normalized.replace(/"/g, '""')}"`;
  }

  private neutralizeCsvFormula(value: string): string {
    return /^[=+\-@]/.test(value) ? `'${value}` : value;
  }

  private sanitizeText(text: string): string {
    return String(text || '').trim().slice(0, 10000);
  }

  private sanitizeSource(source?: string | null): string | null {
    const value = String(source || '').trim().slice(0, 500);
    return value || null;
  }

  private sanitizeTags(tags: string[]): string[] {
    return Array.from(
      new Set(
        (Array.isArray(tags) ? tags : [])
          .map((tag) => String(tag || '').trim())
          .filter(Boolean)
      )
    ).slice(0, 50);
  }

  private clampLimit(value: number | undefined, fallback: number, max: number): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
    return Math.min(Math.floor(numeric), max);
  }
}
