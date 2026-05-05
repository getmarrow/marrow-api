/**
 * Tier 8: Pattern Recognition Service
 * Discover recurring patterns in decision sequences
 */

import { uuid, now } from '../utils/crypto';

export class PatternRecognitionService {
  constructor(private db: D1Database) {}

  async recognizePatterns(accountId: string, decisionType?: string): Promise<Array<{ pattern_id: string; signature: string; frequency: number; confidence: number }>> {
    let sql = `SELECT id as pattern_id, pattern_signature as signature, frequency, confidence FROM patterns WHERE account_id = ?`;
    const params: unknown[] = [accountId];

    if (decisionType) {
      sql += ` AND decision_type = ?`;
      params.push(decisionType);
    }

    sql += ` ORDER BY frequency DESC`;

    const rows = await this.db.prepare(sql).bind(...params).all<Record<string, unknown>>();
    return (rows.results || []).map(r => ({
      pattern_id: String(r.pattern_id),
      signature: String(r.signature),
      frequency: Number(r.frequency),
      confidence: Number(r.confidence),
    }));
  }

  async validatePattern(
    patternId: string,
    decisionId: string,
    accountId: string
  ): Promise<{ matched: boolean; confidence: number }> {
    const pattern = await this.db.prepare('SELECT pattern_signature FROM patterns WHERE id = ? LIMIT 1').bind(patternId).first<{ pattern_signature: string }>();
    if (!pattern) throw new Error('Pattern not found');

    const decision = await this.db
      .prepare('SELECT context, decision_type FROM decisions WHERE id = ? AND account_id = ? LIMIT 1')
      .bind(decisionId, accountId)
      .first<{ context: string; decision_type: string }>();

    if (!decision) throw new Error('Decision not found or unauthorized');

    const ctx = JSON.parse(decision.context);
    const signature = Object.keys(ctx).sort().join('|');
    const matched = signature === pattern.pattern_signature;
    const confidence = matched ? 0.95 : 0.2;

    const testId = uuid();
    const ts = now();

    await this.db
      .prepare(
        `INSERT INTO pattern_tests (id, pattern_id, decision_id, account_id, matched, confidence, tested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(testId, patternId, decisionId, accountId, matched ? 1 : 0, confidence, ts)
      .run();

    return { matched, confidence };
  }

  async getPatternStats(patternId: string, accountId: string): Promise<{ accuracy: number; total_tests: number; successful_tests: number }> {
    const stats = await this.db
      .prepare('SELECT total_tests, successful_tests, accuracy FROM pattern_results WHERE pattern_id = ? AND account_id = ? LIMIT 1')
      .bind(patternId, accountId)
      .first<{ total_tests: number; successful_tests: number; accuracy: number }>();

    if (!stats) return { accuracy: 0, total_tests: 0, successful_tests: 0 };
    return { accuracy: stats.accuracy, total_tests: stats.total_tests, successful_tests: stats.successful_tests };
  }

  async discoverSequentialPatterns(accountId: string, windowSize = 3): Promise<Array<{ signature: string; frequency: number }>> {
    // Get recent decisions
    const decisions = await this.db
      .prepare('SELECT id, decision_type FROM decisions WHERE account_id = ? ORDER BY created_at DESC LIMIT ?')
      .bind(accountId, windowSize * 5)
      .all<{ id: string; decision_type: string }>();

    if (!decisions.results || decisions.results.length < windowSize) {
      return [];
    }

    // Find sequential patterns
    const patterns: Map<string, number> = new Map();
    const decisionTypes = decisions.results.map(d => d.decision_type);

    for (let i = 0; i <= decisionTypes.length - windowSize; i++) {
      const window = decisionTypes.slice(i, i + windowSize).join('→');
      patterns.set(window, (patterns.get(window) || 0) + 1);
    }

    return Array.from(patterns.entries())
      .map(([signature, frequency]) => ({ signature, frequency }))
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 10);
  }

  async calculateSimilarity(contextA: Record<string, unknown>, contextB: Record<string, unknown>): Promise<number> {
    const keysA = new Set(Object.keys(contextA));
    const keysB = new Set(Object.keys(contextB));
    const intersection = Array.from(keysA).filter(k => keysB.has(k)).length;
    const union = new Set([...keysA, ...keysB]).size;
    return union === 0 ? 0 : intersection / union;
  }
}
