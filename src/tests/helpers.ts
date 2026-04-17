/**
 * Test helpers — D1 mock using sqlite3 in-memory
 * All tests use the REAL API key: process.env.TEST_API_KEY || ''
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

export const REAL_API_KEY = process.env.TEST_API_KEY || '';
export const REAL_ACCOUNT_ID = 'empirebuu';
export const REAL_KEY_HASH = 'f54e7036e7e926c256b227e1247be1ffd56e255e720d2e43fd1c02da34c9dd43';
export const TEST_ENCRYPTION_KEY = 'test-encryption-key-for-marrow-unit-tests';

export async function setupTestDb(): Promise<D1Database> {
  return createMockD1();
}

/**
 * In-memory D1 mock using Map-based storage
 * Simulates D1Database interface for testing
 */
class InMemoryDB {
  private tables = new Map<string, Map<string, Record<string, unknown>>>();
  private rawRows = new Map<string, Record<string, unknown>[]>();

  constructor() {
    this.initTables();
  }

  private initTables() {
    const tableNames = [
      'accounts', 'api_keys', 'decisions', 'decision_shares', 'causality_edges',
      'decision_vectors', 'patterns', 'trend_signals', 'lessons', 'priority_queue',
      'bootstrap_templates', 'audit_log', 'consensus_votes', 'snapshots',
      'api_versions', 'analytics_snapshots', 'lesson_stats', 'lesson_ratings',
      'safety_violations', 'rate_limits', 'outcomes', 'causality_stats',
      'pattern_tests', 'pattern_results', 'transfer_history', 'transfer_metrics',
      'decision_priority', 'queue_status', 'bootstrap_instances', 'consensus_analysis',
      'snapshot_metadata', 'snapshot_diffs', 'restore_jobs', 'migration_guides',
      'deprecation_warnings', 'lesson_versions', 'versions'
    ];
    for (const name of tableNames) {
      this.tables.set(name, new Map());
      this.rawRows.set(name, []);
    }
  }

  getRows(table: string): Record<string, unknown>[] {
    return this.rawRows.get(table) || [];
  }

  addRow(table: string, row: Record<string, unknown>) {
    const t = this.rawRows.get(table);
    if (t) {
      // Handle OR REPLACE / OR IGNORE for unique constraints
      const existing = t.findIndex(r => r.id === row.id);
      if (existing >= 0) {
        t[existing] = row;
      } else {
        t.push(row);
      }
    }
  }

  updateRows(table: string, predicate: (r: Record<string, unknown>) => boolean, updates: Record<string, unknown>) {
    const t = this.rawRows.get(table);
    if (t) {
      for (const row of t) {
        if (predicate(row)) {
          Object.assign(row, updates);
        }
      }
    }
  }

  deleteRows(table: string, predicate: (r: Record<string, unknown>) => boolean) {
    const t = this.rawRows.get(table);
    if (t) {
      const newRows = t.filter(r => !predicate(r));
      this.rawRows.set(table, newRows);
    }
  }

  queryRows(table: string, predicate?: (r: Record<string, unknown>) => boolean): Record<string, unknown>[] {
    const t = this.rawRows.get(table) || [];
    return predicate ? t.filter(predicate) : [...t];
  }
}

/**
 * Create a mock D1Database that works with our services
 * This implements the D1 prepare/bind/run/first/all interface
 */
export function createMockD1(): D1Database {
  const db = new InMemoryDB();

  // Seed the real API key
  db.addRow('accounts', {
    id: REAL_ACCOUNT_ID,
    name: 'Empire Buu',
    email: 'buu@getmarrow.ai',
    tier: 'enterprise',
    created_at: new Date().toISOString(),
  });

  db.addRow('api_keys', {
    id: 'key-prod-001',
    account_id: REAL_ACCOUNT_ID,
    key_hash: REAL_KEY_HASH,
    status: 'active',
    created_at: new Date().toISOString(),
    last_used_at: null,
    revoked_at: null,
  });

  // Seed bootstrap templates
  db.addRow('bootstrap_templates', {
    id: 'bt-trading',
    decision_type: 'trading',
    template_decisions: JSON.stringify([{ context: { market: 'crypto' }, outcome: 'Buy BTC', confidence: 0.8 }]),
    success_rate: 0.75,
    created_at: new Date().toISOString(),
  });

  db.addRow('api_versions', {
    id: 'v1',
    version: '1',
    released_at: new Date().toISOString(),
    deprecated_at: null,
    breaking_changes: null,
    created_at: new Date().toISOString(),
  });

  db.addRow('versions', {
    id: 'v-1',
    version: '1',
    released_at: new Date().toISOString(),
    deprecated_at: null,
    breaking_changes: null,
    changes: 'Initial release',
    created_at: new Date().toISOString(),
  });

  db.addRow('migration_guides', {
    id: 'mg-1-2',
    from_version: '1',
    to_version: '2.0.0',
    guide: 'Update all endpoints',
    breaking_changes: 'Endpoint paths changed',
    created_at: new Date().toISOString(),
  });

  return createD1Proxy(db);
}

function createD1Proxy(db: InMemoryDB): D1Database {
  const handler: D1Database = {
    prepare(sql: string) {
      return createStatement(db, sql);
    },
    dump() { return Promise.resolve(new ArrayBuffer(0)); },
    batch(statements: D1PreparedStatement[]) {
      return Promise.resolve(statements.map(() => ({ results: [], success: true, meta: {} as D1Meta })));
    },
    exec(sql: string) {
      return Promise.resolve({ count: 0, duration: 0 });
    },
  };
  return handler;
}

function createStatement(db: InMemoryDB, sql: string): D1PreparedStatement {
  let boundParams: unknown[] = [];

  const stmt: D1PreparedStatement = {
    bind(...params: unknown[]) {
      boundParams = params;
      return stmt;
    },
    async first<T>(col?: string): Promise<T | null> {
      const result = executeSql(db, sql, boundParams);
      if (result.rows.length === 0) return null;
      if (col) return result.rows[0][col] as T;
      return result.rows[0] as T;
    },
    async all<T>(): Promise<D1Result<T>> {
      const result = executeSql(db, sql, boundParams);
      return { results: result.rows as T[], success: true, meta: {} as D1Meta };
    },
    async run(): Promise<D1Response> {
      executeSql(db, sql, boundParams);
      return { success: true, meta: {} as D1Meta };
    },
    async raw<T>(): Promise<T[]> {
      const result = executeSql(db, sql, boundParams);
      return result.rows as T[];
    },
  };

  return stmt;
}

interface SqlResult {
  rows: Record<string, unknown>[];
  changes: number;
}

function executeSql(db: InMemoryDB, sql: string, params: unknown[]): SqlResult {
  const trimmed = sql.trim().replace(/\s+/g, ' ');

  // INSERT
  if (/^INSERT\s+(OR\s+(?:REPLACE|IGNORE)\s+)?INTO\s+/i.test(trimmed)) {
    return executeInsert(db, trimmed, params);
  }

  // UPDATE
  if (/^UPDATE\s+/i.test(trimmed)) {
    return executeUpdate(db, trimmed, params);
  }

  // DELETE
  if (/^DELETE\s+FROM\s+/i.test(trimmed)) {
    return executeDelete(db, trimmed, params);
  }

  // SELECT
  if (/^SELECT\s+/i.test(trimmed)) {
    return executeSelect(db, trimmed, params);
  }

  return { rows: [], changes: 0 };
}

function executeInsert(db: InMemoryDB, sql: string, params: unknown[]): SqlResult {
  const tableMatch = sql.match(/INTO\s+(\w+)\s*\(/i);
  if (!tableMatch) return { rows: [], changes: 0 };

  const table = tableMatch[1];
  const colMatch = sql.match(/\(([^)]+)\)\s*VALUES/i);
  if (!colMatch) return { rows: [], changes: 0 };

  const columns = colMatch[1].split(',').map(c => c.trim());
  const row: Record<string, unknown> = {};

  for (let i = 0; i < columns.length; i++) {
    row[columns[i]] = i < params.length ? params[i] : null;
  }

  // Handle OR REPLACE: remove existing row with same unique key
  if (/OR\s+REPLACE/i.test(sql)) {
    const existing = db.getRows(table);
    // Check for unique constraints (id, or composite unique)
    if (row.id) {
      db.deleteRows(table, r => r.id === row.id);
    }
    // For consensus_votes: unique on (decision_id, voting_agent_id)
    if (table === 'consensus_votes' && row.decision_id && row.voting_agent_id) {
      db.deleteRows(table, r => r.decision_id === row.decision_id && r.voting_agent_id === row.voting_agent_id);
    }
    // For lesson_ratings: unique on (lesson_id, account_id)
    if (table === 'lesson_ratings' && row.lesson_id && row.account_id) {
      db.deleteRows(table, r => r.lesson_id === row.lesson_id && r.account_id === row.account_id);
    }
  }

  // Handle OR IGNORE: skip if duplicate
  if (/OR\s+IGNORE/i.test(sql)) {
    const existing = db.getRows(table);
    if (row.id && existing.some(r => r.id === row.id)) {
      return { rows: [], changes: 0 };
    }
  }

  db.addRow(table, row);
  return { rows: [], changes: 1 };
}

function executeUpdate(db: InMemoryDB, sql: string, params: unknown[]): SqlResult {
  const tableMatch = sql.match(/UPDATE\s+(\w+)\s+SET/i);
  if (!tableMatch) return { rows: [], changes: 0 };

  const table = tableMatch[1];

  // Parse SET clause and WHERE clause
  const setWhereMatch = sql.match(/SET\s+(.+?)(?:\s+WHERE\s+(.+))?$/i);
  if (!setWhereMatch) return { rows: [], changes: 0 };

  const setCols = parseSetClause(setWhereMatch[1]);
  const whereClause = setWhereMatch[2];

  // Count placeholders in SET to determine where WHERE params start
  const setPlaceholders = (setWhereMatch[1].match(/\?/g) || []).length;
  // Also count expression-based updates like "fork_count = fork_count + 1"
  const setParams = params.slice(0, setPlaceholders);
  const whereParams = params.slice(setPlaceholders);

  let changes = 0;
  const rows = db.getRows(table);

  for (const row of rows) {
    if (!whereClause || matchesWhere(row, whereClause, whereParams)) {
      let paramIdx = 0;
      for (const col of setCols) {
        if (col.expr === '?') {
          row[col.name] = setParams[paramIdx++];
        } else if (col.expr.includes('+ 1')) {
          row[col.name] = (Number(row[col.name]) || 0) + 1;
        } else if (/^\d+(\.\d+)?$/.test(col.expr)) {
          // Literal number (e.g., is_published = 1)
          row[col.name] = Number(col.expr);
        } else if (/^'[^']*'$/.test(col.expr)) {
          // Literal string
          row[col.name] = col.expr.slice(1, -1);
        } else {
          row[col.name] = setParams[paramIdx++];
        }
      }
      changes++;
    }
  }

  return { rows: [], changes };
}

function executeDelete(db: InMemoryDB, sql: string, params: unknown[]): SqlResult {
  const tableMatch = sql.match(/FROM\s+(\w+)/i);
  if (!tableMatch) return { rows: [], changes: 0 };

  const table = tableMatch[1];
  const whereMatch = sql.match(/WHERE\s+(.+)$/i);

  if (whereMatch) {
    const before = db.getRows(table).length;
    db.deleteRows(table, r => matchesWhere(r, whereMatch[1], params));
    return { rows: [], changes: before - db.getRows(table).length };
  } else {
    const count = db.getRows(table).length;
    db.deleteRows(table, () => true);
    return { rows: [], changes: count };
  }
}

function executeSelect(db: InMemoryDB, sql: string, params: unknown[]): SqlResult {
  // Extract main table
  const fromMatch = sql.match(/FROM\s+(\w+)(?:\s+(\w+))?/i);
  if (!fromMatch) return { rows: [], changes: 0 };

  const table = fromMatch[1];
  let rows = [...db.getRows(table)];

  // Handle JOINs
  const joinMatches = sql.matchAll(/JOIN\s+(\w+)\s+(\w+)\s+ON\s+(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)/gi);
  for (const join of joinMatches) {
    const joinTable = join[1];
    const joinAlias = join[2];
    const leftAlias = join[3];
    const leftCol = join[4];
    const rightAlias = join[5];
    const rightCol = join[6];
    const joinRows = db.getRows(joinTable);

    const newRows: Record<string, unknown>[] = [];
    for (const row of rows) {
      for (const jRow of joinRows) {
        // Determine which side is the main table and which is the join
        const mainVal = row[leftCol] ?? row[rightCol];
        const joinVal = jRow[rightCol] ?? jRow[leftCol];
        if (mainVal === joinVal || row[leftCol] === jRow[rightCol] || row[rightCol] === jRow[leftCol]) {
          newRows.push({ ...row, ...jRow });
        }
      }
    }
    rows = newRows;
  }

  // Handle LEFT JOIN
  const leftJoinMatches = sql.matchAll(/LEFT\s+JOIN\s+(\w+)\s+(\w+)\s+ON\s+(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)/gi);
  for (const join of leftJoinMatches) {
    const joinTable = join[1];
    const joinRows = db.getRows(joinTable);
    const leftCol = join[4];
    const rightCol = join[6];

    const newRows: Record<string, unknown>[] = [];
    for (const row of rows) {
      const matches = joinRows.filter(jr =>
        row[leftCol] === jr[rightCol] || row[rightCol] === jr[leftCol]
      );
      if (matches.length > 0) {
        for (const m of matches) newRows.push({ ...row, ...m });
      } else {
        newRows.push(row);
      }
    }
    rows = newRows;
  }

  // Handle WHERE
  const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+(?:GROUP|ORDER|LIMIT)\s|$)/i);
  if (whereMatch) {
    rows = rows.filter(r => matchesWhere(r, whereMatch[1], params));
  }

  // Handle GROUP BY with aggregates
  if (/GROUP\s+BY/i.test(sql)) {
    const groupMatch = sql.match(/GROUP\s+BY\s+(\w+(?:\.\w+)?)/i);
    if (groupMatch) {
      const groupCol = groupMatch[1].split('.').pop()!;
      const groups = new Map<unknown, Record<string, unknown>[]>();
      for (const row of rows) {
        const key = row[groupCol];
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(row);
      }

      rows = [];
      for (const [key, groupRows] of groups) {
        const agg: Record<string, unknown> = { [groupCol]: key };

        // Handle COUNT(*)
        if (/COUNT\s*\(\s*\*\s*\)/i.test(sql)) {
          const countAlias = sql.match(/COUNT\s*\(\s*\*\s*\)\s+as\s+(\w+)/i);
          agg[countAlias?.[1] || 'count'] = groupRows.length;
        }

        // Handle SUM
        const sumMatches = sql.matchAll(/SUM\s*\(\s*(?:CASE\s+WHEN\s+(\w+)\s*=\s*(\d+)\s+THEN\s+(\d+)\s+ELSE\s+(\d+)\s+END|(\w+))\s*\)\s+as\s+(\w+)/gi);
        for (const sm of sumMatches) {
          if (sm[5]) {
            // Simple SUM
            agg[sm[6]] = groupRows.reduce((s, r) => s + (Number(r[sm[5]]) || 0), 0);
          } else {
            // CASE SUM
            const col = sm[1];
            const val = Number(sm[2]);
            const thenVal = Number(sm[3]);
            const elseVal = Number(sm[4]);
            agg[sm[6]] = groupRows.reduce((s, r) => s + (Number(r[col]) === val ? thenVal : elseVal), 0);
          }
        }

        // Handle AVG
        const avgMatch = sql.match(/AVG\s*\(\s*(\w+(?:\.\w+)?)\s*\)\s+as\s+(\w+)/i);
        if (avgMatch) {
          const col = avgMatch[1].split('.').pop()!;
          const vals = groupRows.map(r => Number(r[col]) || 0);
          agg[avgMatch[2]] = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
        }

        rows.push(agg);
      }
    }
  }

  // Handle simple aggregates without GROUP BY
  if (!(/GROUP\s+BY/i.test(sql)) && (/COUNT\s*\(|SUM\s*\(|AVG\s*\(/i.test(sql))) {
    const agg: Record<string, unknown> = {};

    if (/COUNT\s*\(\s*\*\s*\)/i.test(sql)) {
      const alias = sql.match(/COUNT\s*\(\s*\*\s*\)\s+as\s+(\w+)/i);
      agg[alias?.[1] || 'c'] = rows.length;
    }

    const sumMatches = sql.matchAll(/SUM\s*\(\s*CASE\s+WHEN\s+(\w+)\s*=\s*(\d+)\s+THEN\s+(\d+)\s+ELSE\s+(\d+)\s+END\s*\)\s+as\s+(\w+)/gi);
    for (const sm of sumMatches) {
      const col = sm[1];
      const val = Number(sm[2]);
      agg[sm[5]] = rows.reduce((s, r) => s + (Number(r[col]) === val ? Number(sm[3]) : Number(sm[4])), 0);
    }

    // Simple SUM
    const simpleSumMatches = sql.matchAll(/SUM\s*\(\s*(\w+)\s*\)\s+as\s+(\w+)/gi);
    for (const sm of simpleSumMatches) {
      if (!sm[1].startsWith('CASE')) {
        agg[sm[2]] = rows.reduce((s, r) => s + (Number(r[sm[1]]) || 0), 0);
      }
    }

    const avgMatch = sql.match(/AVG\s*\(\s*(\w+(?:\.\w+)?)\s*\)\s+as\s+(\w+)/i);
    if (avgMatch) {
      const col = avgMatch[1].split('.').pop()!;
      const vals = rows.map(r => Number(r[col]) || 0);
      agg[avgMatch[2]] = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    }

    if (Object.keys(agg).length > 0) {
      rows = [agg];
    }
  }

  // Handle ORDER BY
  const orderMatch = sql.match(/ORDER\s+BY\s+(\w+(?:\.\w+)?)\s+(ASC|DESC)?/i);
  if (orderMatch) {
    const col = orderMatch[1].split('.').pop()!;
    const desc = (orderMatch[2] || '').toUpperCase() === 'DESC';
    rows.sort((a, b) => {
      const va = a[col], vb = b[col];
      if (va === vb) return 0;
      if (va == null) return desc ? 1 : -1;
      if (vb == null) return desc ? -1 : 1;
      return desc ? (va > vb ? -1 : 1) : (va < vb ? -1 : 1);
    });
  }

  // Handle LIMIT
  const limitMatch = sql.match(/LIMIT\s+(\?|\d+)/i);
  if (limitMatch) {
    const limitIdx = (sql.substring(0, sql.indexOf('LIMIT')).match(/\?/g) || []).length;
    const limit = limitMatch[1] === '?' ? Number(params[limitIdx]) : Number(limitMatch[1]);
    rows = rows.slice(0, limit);
  }

  return { rows, changes: 0 };
}

function parseSetClause(setStr: string): Array<{ name: string; expr: string }> {
  const cols: Array<{ name: string; expr: string }> = [];
  // Split on comma but not inside parens
  const parts = setStr.split(/,(?![^(]*\))/);
  for (const part of parts) {
    const m = part.trim().match(/^(\w+)\s*=\s*(.+)$/);
    if (m) {
      cols.push({ name: m[1], expr: m[2].trim() });
    }
  }
  return cols;
}

function matchesWhere(row: Record<string, unknown>, where: string, params: unknown[]): boolean {
  let paramIdx = 0;

  // Simple parsing of AND/OR conditions
  const conditions = where.split(/\s+AND\s+/i);
  let result = true;

  for (const cond of conditions) {
    const trimCond = cond.trim();

    // Handle OR
    if (/\s+OR\s+/i.test(trimCond)) {
      const orParts = trimCond.split(/\s+OR\s+/i);
      let orResult = false;
      for (const part of orParts) {
        if (evalCondition(row, part.trim(), params, paramIdx)) {
          orResult = true;
        }
        paramIdx += (part.match(/\?/g) || []).length;
      }
      if (!orResult) result = false;
      continue;
    }

    if (!evalCondition(row, trimCond, params, paramIdx)) {
      result = false;
    }
    paramIdx += (trimCond.match(/\?/g) || []).length;
  }

  return result;
}

function evalCondition(row: Record<string, unknown>, cond: string, params: unknown[], startIdx: number): boolean {
  const trimCond = cond.trim().replace(/^\(|\)$/g, '');

  // Handle IN clause
  const inMatch = trimCond.match(/(\w+(?:\.\w+)?)\s+IN\s*\(([^)]+)\)/i);
  if (inMatch) {
    const col = inMatch[1].split('.').pop()!;
    const vals = inMatch[2].split(',').map(v => v.trim().replace(/'/g, ''));
    return vals.includes(String(row[col]));
  }

  // Handle IS NOT NULL
  if (/IS\s+NOT\s+NULL/i.test(trimCond)) {
    const col = trimCond.match(/(\w+(?:\.\w+)?)\s+IS/i)?.[1]?.split('.').pop();
    return col ? row[col] != null : false;
  }

  // Handle IS NULL
  if (/IS\s+NULL/i.test(trimCond)) {
    const col = trimCond.match(/(\w+(?:\.\w+)?)\s+IS/i)?.[1]?.split('.').pop();
    return col ? row[col] == null : false;
  }

  // Handle LIKE
  const likeMatch = trimCond.match(/(\w+(?:\.\w+)?)\s+LIKE\s+\?/i);
  if (likeMatch) {
    const col = likeMatch[1].split('.').pop()!;
    const pattern = String(params[startIdx] || '');
    const regex = new RegExp('^' + pattern.replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
    return regex.test(String(row[col] || ''));
  }

  // Handle datetime comparisons  
  if (/datetime\s*\(/i.test(trimCond)) {
    // Just pass — datetime filters are hard to mock precisely
    return true;
  }

  // Handle = ?
  const eqMatch = trimCond.match(/(\w+(?:\.\w+)?)\s*=\s*\?/);
  if (eqMatch) {
    const col = eqMatch[1].split('.').pop()!;
    const val = params[startIdx];
    return row[col] == val || String(row[col]) === String(val);
  }

  // Handle = 'value'
  const eqStrMatch = trimCond.match(/(\w+(?:\.\w+)?)\s*=\s*'([^']+)'/);
  if (eqStrMatch) {
    const col = eqStrMatch[1].split('.').pop()!;
    return String(row[col]) === eqStrMatch[2];
  }

  // Handle = number
  const eqNumMatch = trimCond.match(/(\w+(?:\.\w+)?)\s*=\s*(\d+)/);
  if (eqNumMatch) {
    const col = eqNumMatch[1].split('.').pop()!;
    return Number(row[col]) === Number(eqNumMatch[2]);
  }

  // Handle > ?
  const gtMatch = trimCond.match(/(\w+(?:\.\w+)?)\s*>\s*\?/);
  if (gtMatch) {
    const col = gtMatch[1].split('.').pop()!;
    return String(row[col] || '') > String(params[startIdx] || '');
  }

  // Handle >= ?
  const gteMatch = trimCond.match(/(\w+(?:\.\w+)?)\s*>=\s*\?/);
  if (gteMatch) {
    const col = gteMatch[1].split('.').pop()!;
    return String(row[col] || '') >= String(params[startIdx] || '');
  }

  // Handle <= ?
  const lteMatch = trimCond.match(/(\w+(?:\.\w+)?)\s*<=\s*\?/);
  if (lteMatch) {
    const col = lteMatch[1].split('.').pop()!;
    return String(row[col] || '') <= String(params[startIdx] || '');
  }

  return true; // Default pass for unrecognized conditions
}
