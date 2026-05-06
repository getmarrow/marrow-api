/**
 * Tier 7: Predictive Routing (cosine similarity)
 * Tier 8: Pattern Discovery & Trending
 * Tier 10: Priority Queue
 * Tier 18: Marketplace (lesson publishing, forking, ratings)
 */
import { Pattern, TrendSignal } from '../types';
import { uuid, now } from '../utils/crypto';
import { computeEmbedding, cosineSimilarity } from '../utils/vectors';
import { PiiService } from './pii.service';

interface SimilarDecision {
  decision_id: string;
  decision_type: string;
  confidence: number;
  outcome: string;
  outcome_success: number | null;
  similarity: number;
  account_id?: string;
  visibility?: string;
  created_at?: string;
}

interface SemanticSearchOptions {
  limit?: number;
  includePrivate?: boolean;
  minSimilarity?: number;
  excludeDecisionId?: string;
}

interface PredictRiskParams {
  accountId: string;
  action: string;
  decisionType: string;
  context?: Record<string, unknown>;
}

interface PredictRiskResult {
  risk_score: number | null;
  confidence: number;
  similar_count: number;
  top_failure_reason: string | null;
}

interface LearnedTemplateCandidate {
  template_id: string;
  pattern_cluster: string;
  steps: string[];
  success_rate: number;
  confidence: number;
  usage_count: number;
  decision_type: string;
}

export class PatternsService {
  private ai: any;
  private pii: PiiService;

  constructor(private db: D1Database, ai?: any) {
    this.ai = ai;
    this.pii = new PiiService();
  }

  // ====== TIER 7: PREDICTIVE ROUTING ======

  async predictSimilarDecisions(newContext: Record<string, unknown>, decisionType: string, limit = 5) {
    const vectors = await this.db.prepare(`
      SELECT dv.*, d.account_id, d.visibility, d.confidence, d.outcome, d.outcome_success, d.created_at FROM decision_vectors dv
      JOIN decisions d ON dv.decision_id = d.id
      WHERE d.decision_type = ?
        AND (d.visibility = 'hive' OR d.visibility = 'shared')
        AND (d.quality IS NULL OR d.quality != 'trivial')
      LIMIT 100
    `).bind(decisionType).all<Record<string, unknown>>();

    const safeContext = this.pii.stripObject(newContext);
    const newEmb = await computeEmbedding(this.ai, `${decisionType}: ${JSON.stringify(safeContext)}`);

    const sorted = this.rankSimilarDecisions(vectors.results || [], newEmb)
      .slice(0, limit);

    return { similar: sorted, risk_score: this.calculateSimpleRisk(sorted, 2) };
  }

  async semanticSearch(
    queryText: string,
    accountId: string,
    options: SemanticSearchOptions = {}
  ): Promise<SimilarDecision[]> {
    const limit = Math.min(Math.max(options.limit || 5, 1), 20);
    const minSimilarity = options.minSimilarity ?? 0;
    const queryEmbedding = await computeEmbedding(this.ai, this.prepareSemanticQuery(queryText));

    const vectors = await this.db.prepare(`
      SELECT dv.*, d.account_id, d.visibility, d.confidence, d.outcome, d.outcome_success, d.created_at FROM decision_vectors dv
      JOIN decisions d ON dv.decision_id = d.id
      WHERE (d.quality IS NULL OR d.quality != 'trivial')
      LIMIT 100
    `).all<Record<string, unknown>>();

    return this.rankSimilarDecisions(vectors.results || [], queryEmbedding)
      .filter((row) => this.canAccessSemanticRow(row, accountId, Boolean(options.includePrivate)))
      .filter((row) => !options.excludeDecisionId || row.decision_id !== options.excludeDecisionId)
      .filter((row) => row.similarity >= minSimilarity)
      .slice(0, limit);
  }

  async predictRisk(params: PredictRiskParams): Promise<PredictRiskResult> {
    const safeContext = this.pii.stripObject(params.context || {});
    const queryText = `${params.decisionType}: ${this.pii.stripString(params.action)} — ${JSON.stringify(safeContext)}`;
    const semanticMatches = await this.semanticSearch(queryText, params.accountId, {
      limit: 10,
      includePrivate: true,
      minSimilarity: 0.1,
    });

    const matchesWithOutcomes = semanticMatches.filter((match) => this.normalizeOutcomeSuccess(match.outcome_success) !== null);
    const similar_count = matchesWithOutcomes.length;
    const averageSimilarity = matchesWithOutcomes.length > 0
      ? matchesWithOutcomes.reduce((sum, match) => sum + match.similarity, 0) / matchesWithOutcomes.length
      : 0;

    const historyRows = await this.db.prepare(`
      SELECT outcome_success, created_at
      FROM decisions
      WHERE account_id = ?
        AND decision_type = ?
        AND outcome_success IS NOT NULL
        AND (quality IS NULL OR quality != 'trivial')
      LIMIT 200
    `).bind(params.accountId, params.decisionType).all<Record<string, unknown>>();

    const typeHistory = (historyRows.results || [])
      .map((row) => ({
        outcome_success: this.normalizeOutcomeSuccess(row.outcome_success),
        created_at: row.created_at ? String(row.created_at) : null,
      }))
      .filter((row) => row.outcome_success !== null) as Array<{ outcome_success: number; created_at: string | null }>;

    const confidence = Math.min(similar_count / 10, 1) * averageSimilarity;
    const top_failure_reason = this.getTopFailureReason(matchesWithOutcomes);

    if (similar_count < 3) {
      return {
        risk_score: null,
        confidence,
        similar_count,
        top_failure_reason,
      };
    }

    const weighted = matchesWithOutcomes.reduce((acc, match) => {
      const outcomeSuccess = this.normalizeOutcomeSuccess(match.outcome_success);
      if (outcomeSuccess === null) return acc;
      const weight = Math.max(match.similarity, 0.05) * this.recencyWeight(match.created_at || null);
      acc.total += weight;
      if (outcomeSuccess === 1) acc.success += weight;
      return acc;
    }, { total: 0, success: 0 });

    const semanticRisk = weighted.total > 0 ? 1 - (weighted.success / weighted.total) : null;
    const typeRisk = this.calculateHistoryRisk(typeHistory);
    const frequencyBlend = Math.min(typeHistory.length / 10, 1) * 0.35;
    const risk_score = semanticRisk === null
      ? typeRisk
      : this.clampRisk((semanticRisk * (1 - frequencyBlend)) + (typeRisk * frequencyBlend));

    return {
      risk_score,
      confidence,
      similar_count,
      top_failure_reason,
    };
  }

  // ====== TIER 8: PATTERN DISCOVERY ======

  async discoverPatterns(accountId: string, decisionType: string): Promise<Pattern[]> {
    // C1 fix: Use context_hive for cross-account reads to prevent PII leakage
    const res = await this.db.prepare(`
      SELECT id, CASE WHEN account_id = ? THEN context ELSE COALESCE(context_hive, context) END as context,
      outcome, outcome_success, created_at FROM decisions
      WHERE (account_id = ? OR visibility = 'hive')
      AND (decision_type = ? OR ? = 'all')
      AND (quality IS NULL OR quality != 'trivial')
      AND created_at > datetime('now', '-30 days')
      ORDER BY created_at DESC
      LIMIT 500
    `).bind(accountId, accountId, decisionType, decisionType).all<Record<string, unknown>>();

    const patternMap = new Map<string, { count: number; firstSeen: string; lastSeen: string; outcomes: string[]; successCount: number }>();

    // Type-level pattern: if 3+ decisions of this type exist, that's a pattern
    const totalCount = (res.results || []).length;
    if (totalCount >= 3) {
      const typeSig = this.simpleHash('type:' + decisionType);
      const rows = res.results || [];
      const first = rows[rows.length - 1];
      const last = rows[0];
      patternMap.set(typeSig, {
        count: totalCount,
        firstSeen: String(first?.created_at || now()),
        lastSeen: String(last?.created_at || now()),
        outcomes: rows.slice(0, 5).map(r => String(r.outcome || '').slice(0, 100)),
        successCount: rows.filter(r => r.outcome_success).length,
      });
    }

    // Outcome-level patterns: group by decision_type + outcome prefix
    for (const row of res.results || []) {
      const outcomePrefix = String(row.outcome || '').toLowerCase().trim().slice(0, 30);
      const sig = this.simpleHash(decisionType + ':' + outcomePrefix);
      const existing = patternMap.get(sig);
      patternMap.set(sig, {
        count: (existing?.count || 0) + 1,
        firstSeen: existing?.firstSeen || String(row.created_at),
        lastSeen: String(row.created_at),
        outcomes: [...(existing?.outcomes || []), String(row.outcome || '').slice(0, 100)].slice(-5),
        successCount: (existing?.successCount || 0) + (row.outcome_success ? 1 : 0),
      });
    }

    const patterns: Pattern[] = [];
    for (const [sig, data] of patternMap) {
      if (data.count < 2) continue; // Lowered from 3 to 2 for earlier detection
      const id = uuid();
      const confidence = Math.min(1, data.count / 10);

      // Upsert: check if pattern exists, update if so, insert if not
      const existing = await this.db.prepare(
        'SELECT id FROM patterns WHERE account_id = ? AND pattern_signature = ?'
      ).bind(accountId, sig).first<{ id: string }>();

      const patternId = existing?.id || uuid();
      if (existing) {
        await this.db.prepare(
          'UPDATE patterns SET frequency = ?, last_seen = ?, confidence = ? WHERE id = ?'
        ).bind(data.count, data.lastSeen, confidence, patternId).run();
      } else {
        await this.db.prepare(
          'INSERT INTO patterns (id, account_id, decision_type, pattern_signature, frequency, first_seen, last_seen, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(patternId, accountId, decisionType, sig, data.count, data.firstSeen, data.lastSeen, confidence, now()).run();
      }

      patterns.push({ id: patternId, account_id: accountId, decision_type: decisionType, pattern_signature: sig, frequency: data.count, first_seen: data.firstSeen, last_seen: data.lastSeen, confidence, created_at: now() });
    }
    return patterns;
  }

  async calculateTrends(accountId: string, decisionType: string): Promise<TrendSignal[]> {
    const trends: TrendSignal[] = [];
    for (const days of [1, 7, 30]) {
      const current = await this.db.prepare(`
        SELECT COUNT(*) as total, SUM(CASE WHEN outcome_success = 1 THEN 1 ELSE 0 END) as successes
        FROM decisions WHERE account_id = ? AND decision_type = ? AND created_at > datetime('now', '-' || ? || ' days')
      `).bind(accountId, decisionType, days).first<{ total: number; successes: number }>();

      const prev = await this.db.prepare(`
        SELECT COUNT(*) as total, SUM(CASE WHEN outcome_success = 1 THEN 1 ELSE 0 END) as successes
        FROM decisions WHERE account_id = ? AND decision_type = ?
        AND created_at > datetime('now', '-' || ? || ' days') AND created_at <= datetime('now', '-' || ? || ' days')
      `).bind(accountId, decisionType, days * 2, days).first<{ total: number; successes: number }>();

      const curRate = (current?.total || 0) > 0 ? (current?.successes || 0) / (current?.total || 1) : 0;
      const prevRate = (prev?.total || 1) > 0 ? (prev?.successes || 0) / (prev?.total || 1) : 0;
      const magnitude = Math.abs(curRate - prevRate);
      const direction: TrendSignal['trend_direction'] = curRate > prevRate * 1.1 ? 'up' : curRate < prevRate * 0.9 ? 'down' : 'stable';

      const id = uuid();
      const ts = now();
      await this.db.prepare(
        'INSERT INTO trend_signals (id, account_id, decision_type, trend_direction, magnitude, calculated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(id, accountId, decisionType, direction, magnitude, `${days}d`, ts).run();

      trends.push({ id, account_id: accountId, decision_type: decisionType, trend_direction: direction, magnitude, calculated_at: `${days}d`, created_at: ts });
    }
    return trends;
  }

  async recognizePatterns(accountId: string, decisionType?: string): Promise<Array<{ pattern_id: string; signature: string; frequency: number; confidence: number }>> {
    let sql = `SELECT id as pattern_id, pattern_signature as signature, frequency, confidence FROM patterns WHERE account_id = ?`;
    const params: unknown[] = [accountId];

    if (decisionType) {
      sql += ` AND decision_type = ?`;
      params.push(decisionType);
    }

    sql += ` ORDER BY frequency DESC`;

    const rows = await this.db.prepare(sql).bind(...params).all<Record<string, unknown>>();
    return (rows.results || []).map((r) => ({
      pattern_id: String(r.pattern_id),
      signature: String(r.signature),
      frequency: Number(r.frequency),
      confidence: Number(r.confidence),
    }));
  }

  async validatePattern(patternId: string, decisionId: string, accountId: string): Promise<{ matched: boolean; confidence: number }> {
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

    await this.db.prepare(
      `INSERT INTO pattern_tests (id, pattern_id, decision_id, account_id, matched, confidence, tested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(testId, patternId, decisionId, accountId, matched ? 1 : 0, confidence, ts).run();

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
    const decisions = await this.db
      .prepare('SELECT id, decision_type FROM decisions WHERE account_id = ? ORDER BY created_at DESC LIMIT ?')
      .bind(accountId, windowSize * 5)
      .all<{ id: string; decision_type: string }>();

    if (!decisions.results || decisions.results.length < windowSize) {
      return [];
    }

    const patterns: Map<string, number> = new Map();
    const decisionTypes = decisions.results.map((d) => d.decision_type);

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
    const intersection = Array.from(keysA).filter((k) => keysB.has(k)).length;
    const union = new Set([...keysA, ...keysB]).size;
    return union === 0 ? 0 : intersection / union;
  }

  // ====== TIER 10: PRIORITY QUEUE ======

  async recalculatePriorities(accountId: string): Promise<void> {
    const res = await this.db.prepare('SELECT id, impact_score, confidence, reuse_count, created_at FROM decisions WHERE account_id = ?').bind(accountId).all<Record<string, unknown>>();
    const nowMs = Date.now();

    for (const row of res.results || []) {
      const ageDays = (nowMs - new Date(String(row.created_at)).getTime()) / 86400000;
      const recency = Math.max(0, 1.0 - ageDays / 30);
      const score = Number(row.impact_score || 0) * 0.4 + Number(row.confidence || 0) * 0.3 + Math.min(Number(row.reuse_count || 0) / 10, 1) * 0.2 + recency * 0.1;

      await this.db.prepare(
        'INSERT OR REPLACE INTO priority_queue (id, account_id, decision_id, priority_score, recalculated_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(uuid(), accountId, String(row.id), score, now(), now()).run();
    }
  }

  async getHiveByPriority(decisionType: string, limit = 50, requestingAccountId?: string) {
    // C1 fix: Use context_hive for cross-account reads to prevent PII leakage
    const res = await this.db.prepare(`
      SELECT d.*, pq.priority_score FROM decisions d
      LEFT JOIN priority_queue pq ON d.id = pq.decision_id
      WHERE d.decision_type = ?
        AND (d.visibility = 'hive' OR d.visibility = 'shared')
        AND (d.quality IS NULL OR d.quality != 'trivial')
      ORDER BY COALESCE(pq.priority_score, 0) DESC LIMIT ?
    `).bind(decisionType, limit).all<Record<string, unknown>>();

    return (res.results || []).map(r => ({
      ...r,
      context: JSON.parse(String(
        requestingAccountId && r.account_id !== requestingAccountId
          ? (r.context_hive || r.context)
          : r.context
      )),
      priority_score: Number(r.priority_score || 0),
    }));
  }

  // ====== TIER 18: MARKETPLACE ======

  async publishLesson(lessonId: string, accountId: string): Promise<void> {
    const lesson = await this.db.prepare('SELECT id FROM lessons WHERE id = ? AND account_id = ?').bind(lessonId, accountId).first();
    if (!lesson) throw new Error('Lesson not found');

    await this.db.prepare('UPDATE lessons SET is_published = 1, updated_at = ? WHERE id = ?').bind(now(), lessonId).run();
    // Create stats if not exists
    await this.db.prepare(
      'INSERT OR IGNORE INTO lesson_stats (id, lesson_id, view_count, fork_count, rating_avg, rating_count, reputation_score, created_at, updated_at) VALUES (?, ?, 0, 0, 0, 0, 0, ?, ?)'
    ).bind(uuid(), lessonId, now(), now()).run();
  }

  async forkLesson(sourceId: string, newAccountId: string, newTitle: string): Promise<string> {
    const source = await this.db.prepare('SELECT * FROM lessons WHERE id = ? AND is_published = 1').bind(sourceId).first<Record<string, unknown>>();
    if (!source) throw new Error('Source lesson not found or not published');

    const id = uuid();
    const ts = now();
    await this.db.prepare(
      'INSERT INTO lessons (id, account_id, title, content, domain_tags, transferability_score, is_published, publisher_reputation, forked_from, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)'
    ).bind(id, newAccountId, newTitle || String(source.title), String(source.content), source.domain_tags ? String(source.domain_tags) : null, Number(source.transferability_score || 0.5), sourceId, ts, ts).run();

    await this.db.prepare('UPDATE lesson_stats SET fork_count = fork_count + 1, updated_at = ? WHERE lesson_id = ?').bind(ts, sourceId).run();
    return id;
  }

  async rateLesson(lessonId: string, accountId: string, rating: number): Promise<void> {
    if (rating < 1 || rating > 5) throw new Error('Rating must be between 1 and 5');

    await this.db.prepare(
      'INSERT OR REPLACE INTO lesson_ratings (id, lesson_id, account_id, rating, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(uuid(), lessonId, accountId, rating, now()).run();

    // Recalculate average
    const stats = await this.db.prepare('SELECT AVG(rating) as avg, COUNT(*) as cnt FROM lesson_ratings WHERE lesson_id = ?').bind(lessonId).first<{ avg: number; cnt: number }>();
    await this.db.prepare('UPDATE lesson_stats SET rating_avg = ?, rating_count = ?, updated_at = ? WHERE lesson_id = ?').bind(stats?.avg || 0, stats?.cnt || 0, now(), lessonId).run();

    // Increment view count
    await this.db.prepare('UPDATE lesson_stats SET view_count = view_count + 1, updated_at = ? WHERE lesson_id = ?').bind(now(), lessonId).run();
  }

  async getMarketplace(sortBy: 'rating' | 'reputation' | 'recent' | 'forks' = 'rating', limit = 50) {
    const orderMap: Record<string, string> = {
      rating: 'ls.rating_avg DESC',
      reputation: 'ls.reputation_score DESC',
      recent: 'l.created_at DESC',
      forks: 'ls.fork_count DESC',
    };
    const orderBy = orderMap[sortBy] || orderMap.rating;

    const res = await this.db.prepare(`
      SELECT l.*, ls.view_count, ls.fork_count, ls.rating_avg, ls.rating_count, ls.reputation_score
      FROM lessons l
      JOIN lesson_stats ls ON l.id = ls.lesson_id
      WHERE l.is_published = 1
      ORDER BY ${orderBy} LIMIT ?
    `).bind(limit).all<Record<string, unknown>>();

    return (res.results || []).map(r => ({ ...r, domain_tags: r.domain_tags ? JSON.parse(String(r.domain_tags)) : [] }));
  }

  // ====== TIER 10: HIVE SIGNALS ======

  async getSignalsByAccountAndType(accountId: string, decisionType: string, limit = 20) {
    const res = await this.db.prepare(`
      SELECT id, account_id, decision_type, trend_direction, magnitude, calculated_at, created_at
      FROM trend_signals
      WHERE account_id = ? AND (decision_type = ? OR ? = 'all')
      ORDER BY created_at DESC
      LIMIT ?
    `).bind(accountId, decisionType, decisionType, limit).all<Record<string, unknown>>();

    return (res.results || []).map(r => ({
      id: String(r.id),
      account_id: String(r.account_id),
      decision_type: String(r.decision_type),
      trend_direction: String(r.trend_direction),
      magnitude: Number(r.magnitude),
      calculated_at: String(r.calculated_at),
      created_at: String(r.created_at),
    }));
  }


  /**
   * Phase 3: Org-wide predictive routing for Team/Enterprise tiers.
   * Searches decisions from all org members, not just single account.
   * PII is stripped before embedding; context_hive is used for cross-account reads.
   */
  async predictSimilarDecisionsOrgWide(
    newContext: Record<string, unknown>,
    decisionType: string,
    orgId: string,
    limit = 5
  ) {
    // Get all member account IDs in the org
    const memberRows = await this.db.prepare(
      'SELECT account_id FROM org_members WHERE org_id = ?'
    ).bind(orgId).all<{ account_id: string }>();
    const memberIds = (memberRows.results || []).map(r => r.account_id);
    if (memberIds.length === 0) {
      return { similar: [], risk_score: null };
    }

    const placeholders = memberIds.map(() => '?').join(',');
    const vectors = await this.db.prepare(`
      SELECT dv.*, d.confidence, d.outcome, d.outcome_success, d.account_id FROM decision_vectors dv
      JOIN decisions d ON dv.decision_id = d.id
      WHERE d.decision_type = ? AND d.account_id IN (${placeholders})
        AND (d.visibility = 'hive' OR d.visibility = 'shared' OR d.visibility = 'team')
        AND (d.quality IS NULL OR d.quality != 'trivial')
      LIMIT 100
    `).bind(decisionType, ...memberIds).all<Record<string, unknown>>();

    const safeContext = this.pii.stripObject(newContext);
    const newEmb = await computeEmbedding(this.ai, `${decisionType}: ${JSON.stringify(safeContext)}`);

    const sorted = this.rankSimilarDecisions(vectors.results || [], newEmb)
      .slice(0, limit);

    return { similar: sorted, risk_score: this.calculateSimpleRisk(sorted, 2) };
  }

  /**
   * Phase 3: Discover patterns across an entire org (Team/Enterprise).
   * Aggregates decisions from all org members, strips PII from context,
   * and computes cross-agent patterns with success/failure tracking.
   */
  async discoverOrgPatterns(orgId: string, decisionType: string): Promise<Pattern[]> {
    const memberRows = await this.db.prepare(
      'SELECT account_id FROM org_members WHERE org_id = ?'
    ).bind(orgId).all<{ account_id: string }>();
    const memberIds = (memberRows.results || []).map(r => r.account_id);
    if (memberIds.length === 0) return [];

    const placeholders = memberIds.map(() => '?').join(',');
    const res = await this.db.prepare(`
      SELECT id, account_id, CASE WHEN account_id IN (${placeholders}) THEN COALESCE(context_hive, context) ELSE context END as context,
      outcome, outcome_success, created_at FROM decisions
      WHERE account_id IN (${placeholders})
      AND (decision_type = ? OR ? = 'all')
      AND (quality IS NULL OR quality != 'trivial')
      AND created_at > datetime('now', '-30 days')
      ORDER BY created_at DESC
      LIMIT 500
    `).bind(...memberIds, decisionType, decisionType).all<Record<string, unknown>>();

    const patternMap = new Map<string, { count: number; firstSeen: string; lastSeen: string; outcomes: string[]; successCount: number }>();
    const rows = res.results || [];
    const totalCount = rows.length;

    if (totalCount >= 3) {
      const typeSig = this.simpleHash('org_type:' + decisionType);
      const first = rows[rows.length - 1];
      const last = rows[0];
      patternMap.set(typeSig, {
        count: totalCount,
        firstSeen: String(first?.created_at || now()),
        lastSeen: String(last?.created_at || now()),
        outcomes: rows.slice(0, 5).map(r => {
          const strippedOutcome = this.pii.stripString(String(r.outcome || ''));
          return strippedOutcome.slice(0, 100);
        }),
        successCount: rows.filter(r => r.outcome_success).length,
      });
    }

    for (const row of rows) {
      const strippedOutcome = this.pii.stripString(String(row.outcome || '')).toLowerCase().trim().slice(0, 30);
      const sig = this.simpleHash('org_' + decisionType + ':' + strippedOutcome);
      const existing = patternMap.get(sig);
      patternMap.set(sig, {
        count: (existing?.count || 0) + 1,
        firstSeen: existing?.firstSeen || String(row.created_at),
        lastSeen: String(row.created_at),
        outcomes: [...(existing?.outcomes || []), this.pii.stripString(String(row.outcome || '')).slice(0, 100)].slice(-5),
        successCount: (existing?.successCount || 0) + (row.outcome_success ? 1 : 0),
      });
    }

    const patterns: Pattern[] = [];
    for (const [sig, data] of patternMap) {
      if (data.count < 2) continue;
      const confidence = Math.min(1, data.count / 10);
      patterns.push({
        id: uuid(),
        account_id: orgId,
        decision_type: decisionType,
        pattern_signature: sig,
        frequency: data.count,
        first_seen: data.firstSeen,
        last_seen: data.lastSeen,
        confidence,
        created_at: now(),
      });
    }
    return patterns;
  }

  // ====== PHASE 2: LEARNED TEMPLATES ======


  /**
   * Refreshes learned templates from existing pattern clusters.
   * Async, on-demand — not called per-think. Uses semantic clustering on
   * pattern_signature embeddings, extracts high-confidence templates.
   */
  async learnTemplates(): Promise<void> {
    try {
      // 1. Load all patterns with their decision vectors
      const patternRows = await this.db.prepare(`
        SELECT DISTINCT p.id as pattern_id, p.decision_type, p.pattern_signature,
               p.frequency, p.confidence,
               (SELECT COUNT(*) FROM patterns WHERE decision_type = p.decision_type) as type_count
        FROM patterns p
        ORDER BY p.decision_type, p.frequency DESC
      `).all<Record<string, unknown>>();

      const patterns = (patternRows.results || []) as Array<{
        pattern_id: string; decision_type: string;
        pattern_signature: string; frequency: number;
        confidence: number; type_count: number;
      }>;

      if (patterns.length < 2) {
        console.log('[learnTemplates] Not enough patterns to cluster (need ≥2, got ' + patterns.length + ')');
        return;
      }

      // 2. Compute embeddings for each pattern from its signature
      const patternEmbs: Array<{ p: typeof patterns[0]; emb: number[] }> = [];
      for (const p of patterns) {
        const safeSig = this.pii.stripString(p.pattern_signature);
        const emb = await computeEmbedding(this.ai, `${p.decision_type}: ${safeSig}`);
        patternEmbs.push({ p, emb });
      }

      // 3. Cluster patterns by cosine similarity (threshold 0.7)
      const clusters: Array<Array<typeof patterns[0]>> = [];
      const assigned = new Set<number>();

      for (let i = 0; i < patternEmbs.length; i++) {
        if (assigned.has(i)) continue;
        const cluster: typeof patterns = [patternEmbs[i].p];
        assigned.add(i);
        for (let j = i + 1; j < patternEmbs.length; j++) {
          if (assigned.has(j)) continue;
          const sim = cosineSimilarity(patternEmbs[i].emb, patternEmbs[j].emb);
          if (sim >= 0.7) {
            cluster.push(patternEmbs[j].p);
            assigned.add(j);
          }
        }
        clusters.push(cluster);
      }

      console.log('[learnTemplates] Clustered ' + patterns.length + ' patterns into ' + clusters.length + ' clusters');

      // 4. Extract templates from clusters with ≥3 patterns and ≥60% success rate
      const templates: LearnedTemplateCandidate[] = [];

      for (const cluster of clusters) {
        if (cluster.length < 3) continue;

        const clusterName = this.pii.stripString(
          cluster.map(c => c.decision_type).join('|')
        ).slice(0, 100) || 'unnamed_cluster';

        const avgConfidence = cluster.reduce((s, c) => s + c.confidence, 0) / cluster.length;
        const totalFreq = cluster.reduce((s, c) => s + c.frequency, 0);

        // Derive success_rate from pattern frequency vs type_count
        const maxTypeCount = Math.max(...cluster.map(c => c.type_count), 1);
        const successRate = Math.min(1, totalFreq / (maxTypeCount * cluster.length));

        if (successRate < 0.6) continue;

        // Steps: top 5 pattern signatures as action sequences
        const steps = cluster
          .sort((a, b) => b.frequency - a.frequency)
          .slice(0, 5)
          .map(c => this.pii.stripString(c.pattern_signature).slice(0, 50));

        const templateId = this.simpleHash('template:' + clusterName + ':' + cluster.map(c => c.pattern_id).join(','));

        templates.push({
          template_id: 'tpl_' + templateId,
          pattern_cluster: clusterName,
          steps,
          success_rate: successRate,
          confidence: avgConfidence,
          usage_count: totalFreq,
          decision_type: cluster[0].decision_type,
        });
      }

      // 5. Upsert into learned_templates (atomic: delete all, insert fresh)
      const ts = now();
      await this.db.prepare('DELETE FROM learned_templates').run();
      for (const tpl of templates) {
        await this.db.prepare(
          'INSERT INTO learned_templates (id, template_id, pattern_cluster, steps, success_rate, confidence, usage_count, decision_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(
          uuid(), tpl.template_id, tpl.pattern_cluster, JSON.stringify(tpl.steps),
          tpl.success_rate, tpl.confidence, tpl.usage_count,
          tpl.decision_type, ts, ts
        ).run();
      }

      await this.autoPromoteTemplates(templates, ts);

      console.log('[learnTemplates] Generated ' + templates.length + ' templates');
    } catch (e) {
      console.error('[learnTemplates] Failed:', e instanceof Error ? e.message : e);
      throw e;
    }
  }

  /**
   * Get learned templates, sorted by confidence × success_rate.
   * No auth required — public browsing endpoint.
   */
  async getLearnedTemplates(limit = 20) {
    const rows = await this.db.prepare(`
      SELECT template_id, pattern_cluster, steps, success_rate, confidence, usage_count, decision_type, created_at
      FROM learned_templates
      ORDER BY (confidence * success_rate) DESC
      LIMIT ?
    `).bind(limit).all<Record<string, unknown>>();

    return (rows.results || []).map(r => ({
      template_id: String(r.template_id),
      pattern_cluster: String(r.pattern_cluster),
      steps: JSON.parse(String(r.steps || '[]')),
      success_rate: Number(r.success_rate),
      confidence: Number(r.confidence),
      usage_count: Number(r.usage_count),
      decision_type: String(r.decision_type),
      created_at: String(r.created_at),
    }));
  }

  private rankSimilarDecisions(rows: Record<string, unknown>[], queryEmbedding: number[]): SimilarDecision[] {
    return rows
      .map((row) => {
        try {
          const embedding = JSON.parse(String(row.vector_embedding || '[]')) as number[];
          return {
            decision_id: String(row.decision_id),
            decision_type: String(row.decision_type),
            confidence: Number(row.confidence || 0),
            outcome: String(row.outcome || ''),
            outcome_success: this.normalizeOutcomeSuccess(row.outcome_success),
            similarity: cosineSimilarity(queryEmbedding, embedding),
            account_id: row.account_id ? String(row.account_id) : undefined,
            visibility: row.visibility ? String(row.visibility) : undefined,
            created_at: row.created_at ? String(row.created_at) : undefined,
          } satisfies SimilarDecision;
        } catch {
          return null;
        }
      })
      .filter((row): row is SimilarDecision => Boolean(row))
      .sort((a, b) => b.similarity - a.similarity);
  }

  private calculateSimpleRisk(matches: SimilarDecision[], minOutcomes: number): number | null {
    const withOutcomes = matches.filter((match) => this.normalizeOutcomeSuccess(match.outcome_success) !== null);
    if (withOutcomes.length < minOutcomes) return null;
    const successful = withOutcomes.filter((match) => this.normalizeOutcomeSuccess(match.outcome_success) === 1).length;
    return 1 - (successful / withOutcomes.length);
  }

  private canAccessSemanticRow(row: SimilarDecision, accountId: string, includePrivate: boolean): boolean {
    if (row.account_id === accountId) {
      if (includePrivate) return true;
      return row.visibility === 'hive' || row.visibility === 'shared';
    }
    return row.visibility === 'hive' || row.visibility === 'shared';
  }

  private prepareSemanticQuery(text: string): string {
    return this.pii.stripString(text || 'general: no context');
  }

  private normalizeOutcomeSuccess(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    if (value === true || value === 1 || value === '1') return 1;
    if (value === false || value === 0 || value === '0') return 0;
    return null;
  }

  private recencyWeight(createdAt: string | null): number {
    if (!createdAt) return 1;
    const ageMs = Date.now() - new Date(createdAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs <= 0) return 1;
    const ageDays = ageMs / 86400000;
    return 1 / (1 + (ageDays / 30));
  }

  private calculateHistoryRisk(history: Array<{ outcome_success: number; created_at: string | null }>): number {
    if (history.length === 0) return 0.5;
    const totals = history.reduce((acc, row) => {
      const weight = this.recencyWeight(row.created_at);
      acc.total += weight;
      if (row.outcome_success === 1) acc.success += weight;
      return acc;
    }, { total: 0, success: 0 });

    if (totals.total === 0) return 0.5;
    return this.clampRisk(1 - (totals.success / totals.total));
  }

  private clampRisk(value: number): number {
    return Math.min(1, Math.max(0, value));
  }

  private getTopFailureReason(matches: SimilarDecision[]): string | null {
    const reasons = new Map<string, number>();
    for (const match of matches) {
      if (this.normalizeOutcomeSuccess(match.outcome_success) !== 0) continue;
      const reason = this.extractFailureReason(match.outcome);
      if (!reason) continue;
      reasons.set(reason, (reasons.get(reason) || 0) + 1);
    }

    const sorted = [...reasons.entries()].sort((a, b) => b[1] - a[1]);
    return sorted[0]?.[0] || null;
  }

  private extractFailureReason(outcome: string): string | null {
    const sanitized = this.pii.stripString(outcome || '').trim();
    if (!sanitized) return null;
    return sanitized
      .split(/[.!?\n]/)[0]
      .trim()
      .slice(0, 120) || null;
  }

  private async autoPromoteTemplates(templates: LearnedTemplateCandidate[], ts: string): Promise<void> {
    for (const template of templates) {
      if (template.confidence < 0.8 || template.usage_count < 3 || template.success_rate < 0.8) {
        continue;
      }

      const name = this.buildAutoTemplateName(template);
      const slug = this.slugify(name);
      const existing = await this.db.prepare(
        `SELECT id, slug, name FROM workflow_templates
         WHERE slug = ? OR name = ? OR slug LIKE ?
         LIMIT 5`
      ).bind(slug, name, `%${slug.split('-').slice(0, 2).join('%')}%`).all<Record<string, unknown>>();

      if ((existing.results || []).length > 0) continue;

      const steps = template.steps.map((step, index) => ({
        step: index + 1,
        name: this.formatWorkflowStepName(step),
        description: step,
        action_type: template.decision_type,
      }));

      await this.db.prepare(
        `INSERT INTO workflow_templates (id, name, slug, description, industry, category, author, steps, install_count, avg_success_rate, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        uuid(),
        name,
        slug,
        `Auto-promoted from learned Marrow patterns for ${template.decision_type}.`,
        null,
        template.decision_type,
        '__auto__',
        JSON.stringify(steps),
        0,
        template.success_rate,
        JSON.stringify(['auto', 'learned', template.decision_type]),
        ts,
        ts
      ).run();
    }
  }

  private buildAutoTemplateName(template: LearnedTemplateCandidate): string {
    const decisionLabel = template.decision_type
      .split(/[_\s-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
    const clusterLabel = template.pattern_cluster.replace(/[|:_-]+/g, ' ').trim().slice(0, 40) || 'Workflow';
    return `${decisionLabel} ${clusterLabel} Workflow`.trim().slice(0, 100);
  }

  private formatWorkflowStepName(step: string): string {
    const cleaned = step.replace(/[_-]+/g, ' ').trim();
    if (!cleaned) return 'Step';
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1, 60);
  }

  private slugify(input: string): string {
    return input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60);
  }

  private simpleHash(input: string): string {
    let h = 0;
    for (let i = 0; i < input.length; i++) {
      h = ((h << 5) - h + input.charCodeAt(i)) | 0;
    }
    return Math.abs(h).toString(16);
  }
}
