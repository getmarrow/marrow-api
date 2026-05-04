/**
 * Tiers 2-3: Decision Routing, Validation, Outcome Feedback
 * Tier 5: LZ4 Context Compression
 * Tier 7: Vector embedding on insert
 * Tier 13: Audit logging on mutations
 */
import { Decision, DecisionQuality } from '../types';
import { uuid, now } from '../utils/crypto';
import { compress, decompress } from '../utils/compression';
import { computeEmbedding } from '../utils/vectors';
import { AuditService } from './audit.service';
import { PiiService } from './pii.service';

const COMPRESSION_THRESHOLD = 4096;

export class DecisionService {
  private audit: AuditService;
  private ai: any;
  private pii: PiiService;

  constructor(private db: D1Database, ai?: any) {
    this.audit = new AuditService(db);
    this.ai = ai;
    this.pii = new PiiService();
  }

  validateDecision(data: unknown): { valid: boolean; errors?: Record<string, string> } {
    if (!data || typeof data !== 'object') {
      return { valid: false, errors: { body: 'Invalid request body' } };
    }

    const errors: Record<string, string> = {};
    const d = data as Record<string, unknown>;

    if (typeof d.decision_type !== 'string' || !d.decision_type.trim()) {
      errors.decision_type = 'Must be a non-empty string';
    } else if (d.decision_type.length > 50) {
      errors.decision_type = 'Max 50 characters';
    }
    if (!d.context || typeof d.context !== 'object' || Array.isArray(d.context)) {
      errors.context = 'Must be a valid object';
    } else if (JSON.stringify(d.context).length > 5000) {
      errors.context = 'Max 5000 characters when serialized';
    }
    if (typeof d.outcome !== 'string' || d.outcome.length < 10) {
      errors.outcome = 'Must be a string with at least 10 characters';
    } else if (d.outcome.length > 2000) {
      errors.outcome = 'Max 2000 characters';
    }
    const conf = Number(d.confidence);
    if (isNaN(conf) || conf < 0 || conf > 1) {
      errors.confidence = 'Must be a number between 0.0 and 1.0';
    }

    return Object.keys(errors).length > 0 ? { valid: false, errors } : { valid: true };
  }

  /**
   * Generate and store a semantic embedding for a decision.
   * Fire-and-forget — embedding failure must never block decision creation.
   */
  private async storeEmbedding(decisionId: string, decisionType: string, outcome: string, quality: DecisionQuality | null = null): Promise<void> {
    if (quality === 'trivial') return;

    try {
      const sanitizedOutcome = this.pii.stripString(outcome);
      const embedding = await computeEmbedding(this.ai, `${decisionType}: ${sanitizedOutcome}`);
      const dims = embedding.length;
      const model = dims === 768 ? 'bge-base-en-v1.5' : 'token-fallback';
      await this.db
        .prepare('INSERT OR IGNORE INTO decision_vectors (id, decision_id, vector_embedding, decision_type, model, dimensions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(uuid(), decisionId, JSON.stringify(embedding), decisionType, model, dims, now())
        .run();
    } catch (error) {
      console.error('DecisionService.storeEmbedding failed:', error);
      // Embedding is best-effort — never block the decision
    }
  }

  /**
   * Enforce tier visibility rules:
   * - Free: always 'hive'
   * - Pro: 'private' or 'hive'
   * - Enterprise: 'private', 'hive', or 'team'
   */
  enforceVisibility(tier: string, requested: string): Decision['visibility'] {
    switch (tier) {
      case 'free':
        return 'hive'; // Always hive, ignore requested
      case 'pro':
        if (requested === 'private' || requested === 'shared') return requested as Decision['visibility'];
        return 'hive';
      case 'enterprise':
      case 'owner':
        if (requested === 'team' || requested === 'private' || requested === 'shared') return requested as Decision['visibility'];
        return 'hive';
      default:
        return 'hive';
    }
  }

  async createDecision(
    accountId: string,
    decisionType: string,
    context: Record<string, unknown>,
    outcome: string,
    confidence: number,
    visibility: Decision['visibility'] = 'hive',
    tier: string = 'free',
    orgPiiStripTeam: boolean = false,
    sessionId: string | null = null,
    agentId: string | null = null,
    quality: DecisionQuality | null = null
  ): Promise<Decision> {
    const id = uuid();
    const ts = now();

    // Enforce tier visibility
    const effectiveVisibility = this.enforceVisibility(tier, visibility);

    const contextStr = JSON.stringify(context);

    // PII stripping — visibility-based:
    // hive → always strip (all tiers)
    // team → only if org.pii_strip_team is true
    // private → never strip
    let contextHive: string | null = null;
    if (effectiveVisibility === 'hive') {
      const pii = new PiiService();
      contextHive = JSON.stringify(pii.stripObject(context));
    } else if (effectiveVisibility === 'team' && orgPiiStripTeam) {
      const pii = new PiiService();
      contextHive = JSON.stringify(pii.stripObject(context));
    }

    let isCompressed = false;
    let contextRaw = contextStr;
    if (contextStr.length > COMPRESSION_THRESHOLD) {
      try {
        const compressed = compress(contextStr);
        if (compressed.length < contextStr.length) {
          contextRaw = compressed;
          isCompressed = true;
        }
      } catch { /* store uncompressed */ }
    }

    await this.db
      .prepare(`
        INSERT INTO decisions (id, account_id, decision_type, context, outcome, confidence, quality, visibility, context_compressed, context_raw, context_hive, impact_score, reuse_count, session_id, agent_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)
      `)
      .bind(id, accountId, decisionType, contextStr, outcome, confidence, quality, effectiveVisibility, isCompressed ? 1 : 0, contextRaw, contextHive, sessionId, agentId, ts, ts)
      .run();

    // Tier 7: semantic vector embedding (async, fire-and-forget)
    this.storeEmbedding(id, decisionType, outcome, quality).catch(() => {});

    // Tier 13: audit
    await this.audit.log(accountId, 'CREATE', 'decision', id, { decision_type: decisionType, confidence, visibility: effectiveVisibility });

    return {
      id, account_id: accountId, decision_type: decisionType, context, outcome, confidence, quality,
      visibility: effectiveVisibility, context_compressed: isCompressed,
      context_hive: contextHive ? JSON.parse(contextHive) : null,
      impact_score: 0, reuse_count: 0,
      created_at: ts, updated_at: ts,
    };
  }

  async getDecision(decisionId: string, accountId: string, orgId?: string | null): Promise<Decision | null> {
    // Tier 11: isolation — own, hive-visible, or team-visible (same org)
    let sql = `SELECT * FROM decisions WHERE id = ? AND (account_id = ? OR visibility = 'hive'`;
    const params: unknown[] = [decisionId, accountId];
    if (orgId) {
      sql += ` OR (visibility = 'team' AND account_id IN (SELECT id FROM accounts WHERE org_id = ?))`;
      params.push(orgId);
    }
    sql += `) LIMIT 1`;

    const row = await this.db
      .prepare(sql)
      .bind(...params)
      .first<Record<string, unknown>>();

    if (!row) return null;
    return this.rowToDecision(row);
  }

  async listDecisions(accountId: string, opts?: { decision_type?: string; limit?: number; offset?: number }): Promise<Decision[]> {
    const params: unknown[] = [accountId];
    let sql = 'SELECT * FROM decisions WHERE account_id = ?';
    if (opts?.decision_type) { sql += ' AND decision_type = ?'; params.push(opts.decision_type); }
    sql += ' ORDER BY created_at DESC';
    if (opts?.limit) { sql += ' LIMIT ?'; params.push(opts.limit); }
    if (opts?.offset) { sql += ' OFFSET ?'; params.push(opts.offset); }

    const res = await this.db.prepare(sql).bind(...params).all<Record<string, unknown>>();
    return (res.results || []).map(r => this.rowToDecision(r));
  }

  async recordOutcome(decisionId: string, accountId: string, success: boolean, details?: Record<string, unknown>): Promise<Decision> {
    const decision = await this.getDecision(decisionId, accountId);
    if (!decision || decision.account_id !== accountId) throw new Error('Not found or unauthorized');
    if (decision.outcome_recorded_at) throw new Error('Outcome already recorded');

    const ts = now();
    await this.db
      .prepare('UPDATE decisions SET outcome_success = ?, outcome_recorded_at = ?, outcome_details = ?, updated_at = ? WHERE id = ?')
      .bind(success ? 1 : 0, ts, details ? JSON.stringify(details) : null, ts, decisionId)
      .run();

    await this.audit.log(accountId, 'OUTCOME', 'decision', decisionId, { success });

    return { ...decision, outcome_success: success, outcome_recorded_at: ts, outcome_details: details, updated_at: ts };
  }

  private rowToDecision(row: Record<string, unknown>): Decision {
    let ctx: Record<string, unknown>;
    try {
      const raw = row.context_compressed ? String(row.context_raw || row.context) : String(row.context);
      const decompressed = row.context_compressed ? decompress(raw) : raw;
      ctx = JSON.parse(decompressed);
    } catch {
      ctx = JSON.parse(String(row.context));
    }

    return {
      id: String(row.id),
      account_id: String(row.account_id),
      decision_type: String(row.decision_type),
      context: ctx,
      outcome: String(row.outcome),
      confidence: Number(row.confidence),
      quality: row.quality ? String(row.quality) as DecisionQuality : null,
      visibility: String(row.visibility) as Decision['visibility'],
      context_compressed: Boolean(row.context_compressed),
      context_hive: row.context_hive ? JSON.parse(String(row.context_hive)) : null,
      impact_score: Number(row.impact_score || 0),
      reuse_count: Number(row.reuse_count || 0),
      last_reused_at: row.last_reused_at ? String(row.last_reused_at) : undefined,
      outcome_recorded_at: row.outcome_recorded_at ? String(row.outcome_recorded_at) : undefined,
      outcome_success: row.outcome_success != null ? Boolean(row.outcome_success) : undefined,
      outcome_details: row.outcome_details ? JSON.parse(String(row.outcome_details)) : undefined,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }
}
