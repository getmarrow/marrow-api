/**
 * D1 query helper — thin wrapper around Cloudflare D1 with observability.
 *
 * Every query is timed. Queries slower than 500ms are logged to stderr.
 * Queries that throw are logged to stderr with timing.
 *
 * Usage:
 *   const db = createDb(env);
 *   const rows = await db.query<MemoryRow>('SELECT * FROM memories WHERE id = ?', [id]);
 *   const row  = await db.first<MemoryRow>('SELECT * FROM memories WHERE id = ?', [id]);
 *   await db.execute('INSERT INTO memories (...) VALUES (...)');
 */

import type { D1Database, D1Result } from '@cloudflare/workers-types';
import type { Env } from '../types';

export interface Db {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  first<T>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<D1Result>;
}

export function createDb(env: Env): Db {
  const rawDb: D1Database = env.DB;

  async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const start = Date.now();
    try {
      const result = await rawDb.prepare(sql).bind(...params).all<T>();
      const elapsed = Date.now() - start;
      if (elapsed > 500) {
        console.warn(`[db] Slow query (${elapsed}ms): ${sql.slice(0, 120)}`);
      }
      return (result.results || []) as T[];
    } catch (error) {
      const elapsed = Date.now() - start;
      console.error(`[db] Query failed (${elapsed}ms): ${sql.slice(0, 120)}`, error);
      throw error;
    }
  }

  async function first<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const results = await query<T>(sql, params);
    return results[0] ?? null;
  }

  async function execute(sql: string, params: unknown[] = []): Promise<D1Result> {
    const start = Date.now();
    try {
      const result = await rawDb.prepare(sql).bind(...params).run();
      const elapsed = Date.now() - start;
      if (elapsed > 500) {
        console.warn(`[db] Slow execute (${elapsed}ms): ${sql.slice(0, 120)}`);
      }
      return result;
    } catch (error) {
      const elapsed = Date.now() - start;
      console.error(`[db] Execute failed (${elapsed}ms): ${sql.slice(0, 120)}`, error);
      throw error;
    }
  }

  return { query, first, execute };
}
