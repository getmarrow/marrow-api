/**
 * Tier 18: Marketplace Service
 * Community lesson sharing, ratings, forks
 */

import { uuid, now } from '../utils/crypto';

export interface LessonVersion {
  id: string;
  lesson_id: string;
  version: number;
  title: string;
  content: string;
  changes?: string;
  created_at: string;
}

export class MarketplaceService {
  constructor(private db: D1Database) {}

  async publishLesson(lessonId: string, accountId: string): Promise<{ published: boolean; published_at: string }> {
    const lesson = await this.db
      .prepare('SELECT id FROM lessons WHERE id = ? AND account_id = ? LIMIT 1')
      .bind(lessonId, accountId)
      .first<{ id: string }>();

    if (!lesson) throw new Error('Lesson not found or unauthorized');

    const ts = now();

    await this.db
      .prepare('UPDATE lessons SET published_at = ?, published_by_account_id = ? WHERE id = ?')
      .bind(ts, accountId, lessonId)
      .run();

    await this.db
      .prepare('UPDATE marketplace SET published = 1 WHERE lesson_id = ?')
      .bind(lessonId)
      .run();

    return { published: true, published_at: ts };
  }

  async forkLesson(lessonId: string, accountId: string, newTitle: string): Promise<{ forked_lesson_id: string }> {
    const original = await this.db
      .prepare('SELECT title, content, decision_type FROM lessons WHERE id = ? LIMIT 1')
      .bind(lessonId)
      .first<Record<string, unknown>>();

    if (!original) throw new Error('Lesson not found');

    const id = uuid();
    const ts = now();
    const title = newTitle || String(original.title) + ' (Fork)';

    await this.db
      .prepare(
        `INSERT INTO lessons (id, account_id, decision_type, pattern, success_rate, fork_of_lesson_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, accountId, original.decision_type, original.content, 0.5, lessonId, ts)
      .run();

    // Update fork count on original
    await this.db.prepare('UPDATE lessons SET fork_count = fork_count + 1 WHERE id = ?').bind(lessonId).run();

    return { forked_lesson_id: id };
  }

  async rateLesson(lessonId: string, accountId: string, rating: number): Promise<void> {
    if (rating < 1 || rating > 5) throw new Error('Rating must be between 1 and 5');

    const id = uuid();
    const ts = now();

    // Check for existing rating
    const existing = await this.db
      .prepare('SELECT id FROM lesson_ratings WHERE lesson_id = ? AND account_id = ? LIMIT 1')
      .bind(lessonId, accountId)
      .first<{ id: string }>();

    if (existing) {
      await this.db.prepare('UPDATE lesson_ratings SET rating = ?, rated_at = ? WHERE lesson_id = ? AND account_id = ?').bind(rating, ts, lessonId, accountId).run();
    } else {
      await this.db
        .prepare(
          `INSERT INTO lesson_ratings (id, lesson_id, account_id, rating, rated_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(id, lessonId, accountId, rating, ts)
        .run();
    }

    // Update lesson avg rating
    const avgRating = await this.db
      .prepare('SELECT AVG(rating) as avg_rating, COUNT(*) as count FROM lesson_ratings WHERE lesson_id = ?')
      .bind(lessonId)
      .first<{ avg_rating: number; count: number }>();

    if (avgRating) {
      await this.db.prepare('UPDATE lessons SET avg_rating = ?, rating_count = ? WHERE id = ?').bind(avgRating.avg_rating, avgRating.count, lessonId).run();
    }
  }

  async getLessonVersions(lessonId: string): Promise<LessonVersion[]> {
    const rows = await this.db
      .prepare('SELECT * FROM lesson_versions WHERE lesson_id = ? ORDER BY version DESC')
      .bind(lessonId)
      .all<Record<string, unknown>>();

    return (rows.results || []).map(r => ({
      id: String(r.id),
      lesson_id: String(r.lesson_id),
      version: Number(r.version),
      title: String(r.title),
      content: String(r.content),
      changes: r.changes ? String(r.changes) : undefined,
      created_at: String(r.created_at),
    }));
  }

  async getMarketplace(sortBy: 'rating' | 'reputation' | 'recent' | 'forks' = 'rating', limit = 50): Promise<Array<{ lesson_id: string; title: string; avg_rating: number; fork_count: number; published_at: string }>> {
    let orderBy = 'avg_rating DESC';
    if (sortBy === 'recent') orderBy = 'published_at DESC';
    if (sortBy === 'forks') orderBy = 'fork_count DESC';

    const rows = await this.db
      .prepare(
        `SELECT id as lesson_id, pattern as title, avg_rating, fork_count, published_at FROM lessons 
         WHERE published_at IS NOT NULL ORDER BY ${orderBy} LIMIT ?`
      )
      .bind(limit)
      .all<Record<string, unknown>>();

    return (rows.results || []).map(r => ({
      lesson_id: String(r.lesson_id),
      title: String(r.title),
      avg_rating: Number(r.avg_rating),
      fork_count: Number(r.fork_count),
      published_at: String(r.published_at),
    }));
  }

  async createLessonVersion(lessonId: string, title: string, content: string, changes?: string): Promise<LessonVersion> {
    const versionNum = await this.db
      .prepare('SELECT MAX(version) as max_version FROM lesson_versions WHERE lesson_id = ?')
      .bind(lessonId)
      .first<{ max_version: number | null }>();

    const nextVersion = (versionNum?.max_version || 0) + 1;
    const id = uuid();
    const ts = now();

    await this.db
      .prepare(
        `INSERT INTO lesson_versions (id, lesson_id, version, title, content, changes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, lessonId, nextVersion, title, content, changes || null, ts)
      .run();

    return { id, lesson_id: lessonId, version: nextVersion, title, content, changes, created_at: ts };
  }
}
