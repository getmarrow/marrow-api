/**
 * Tier 9: Transfer Learning Service
 * Extract lessons from one domain and apply to another
 */

import { uuid, now } from '../utils/crypto';

export class TransferService {
  constructor(private db: D1Database) {}

  async getTransferableLessons(fromDomain: string, toDomain: string, limit = 10): Promise<Array<{ lesson_id: string; title: string; transfer_score: number }>> {
    const lessons = await this.db
      .prepare('SELECT id, pattern as title FROM lessons WHERE decision_type = ? LIMIT ?')
      .bind(fromDomain, limit)
      .all<{ id: string; title: string }>();

    return (lessons.results || []).map(l => ({
      lesson_id: l.id,
      title: l.title,
      transfer_score: this.calculateTransferScore(fromDomain, toDomain),
    }));
  }

  async transferLesson(lessonId: string, accountId: string, fromDomain: string, toDomain: string): Promise<{ transfer_id: string; effectiveness: number }> {
    const lesson = await this.db.prepare('SELECT * FROM lessons WHERE id = ? AND account_id = ? LIMIT 1').bind(lessonId, accountId).first<Record<string, unknown>>();
    if (!lesson) throw new Error('Lesson not found or unauthorized');

    const id = uuid();
    const ts = now();
    const effectiveness = this.calculateTransferScore(fromDomain, toDomain);

    await this.db
      .prepare(
        `INSERT INTO transfer_history (id, lesson_id, account_id, from_domain, to_domain, effectiveness, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, lessonId, accountId, fromDomain, toDomain, effectiveness, ts)
      .run();

    await this.updateTransferMetrics(accountId, fromDomain, toDomain);

    return { transfer_id: id, effectiveness };
  }

  async calculateTransferMetrics(accountId: string, fromDomain: string, toDomain: string): Promise<{ transfer_count: number; avg_effectiveness: number }> {
    const metrics = await this.db
      .prepare('SELECT transfer_count, avg_effectiveness FROM transfer_metrics WHERE account_id = ? AND from_domain = ? AND to_domain = ? LIMIT 1')
      .bind(accountId, fromDomain, toDomain)
      .first<{ transfer_count: number; avg_effectiveness: number }>();

    if (!metrics) return { transfer_count: 0, avg_effectiveness: 0 };
    return metrics;
  }

  private async updateTransferMetrics(accountId: string, fromDomain: string, toDomain: string): Promise<void> {
    const history = await this.db
      .prepare(
        `SELECT COUNT(*) as count, AVG(effectiveness) as avg_eff FROM transfer_history 
         WHERE account_id = ? AND from_domain = ? AND to_domain = ?`
      )
      .bind(accountId, fromDomain, toDomain)
      .first<{ count: number; avg_eff: number }>();

    const existing = await this.db
      .prepare('SELECT id FROM transfer_metrics WHERE account_id = ? AND from_domain = ? AND to_domain = ? LIMIT 1')
      .bind(accountId, fromDomain, toDomain)
      .first<{ id: string }>();

    if (existing) {
      await this.db
        .prepare(
          `UPDATE transfer_metrics SET transfer_count = ?, avg_effectiveness = ?, last_updated = ?
           WHERE account_id = ? AND from_domain = ? AND to_domain = ?`
        )
        .bind(history?.count || 0, history?.avg_eff || 0, now(), accountId, fromDomain, toDomain)
        .run();
    } else {
      await this.db
        .prepare(
          `INSERT INTO transfer_metrics (id, account_id, from_domain, to_domain, transfer_count, avg_effectiveness, last_updated)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(uuid(), accountId, fromDomain, toDomain, history?.count || 0, history?.avg_eff || 0, now())
        .run();
    }
  }

  private calculateTransferScore(fromDomain: string, toDomain: string): number {
    const similarity = fromDomain === toDomain ? 1.0 : 0.5;
    return Math.min(1, similarity + 0.2 * Math.random());
  }
}
