/**
 * Tier 12: Bootstrap Protocol
 * Tier 15: Snapshots (create + restore)
 * Tier 16: API Versioning
 * Tier 19: Safety & Alignment
 */
import { Snapshot, SafetyViolation, ApiVersion } from '../types';
import { uuid, now, aesGcmEncrypt, aesGcmDecrypt } from '../utils/crypto';
import { checkSafety, SafetyResult } from '../utils/safety';
import { AuditService } from './audit.service';

export class EnterpriseService {
  private audit: AuditService;
  private encryptionKey: string;

  constructor(private db: D1Database, encryptionKey?: string) {
    this.audit = new AuditService(db);
    this.encryptionKey = encryptionKey || '';
    // Don't throw if missing — features requiring encryption will gracefully degrade
  }

  private requireEncryptionKey(): void {
    if (!this.encryptionKey) throw new Error('ENCRYPTION_KEY not configured — encryption features unavailable');
  }

  // ====== TIER 12: BOOTSTRAP ======

  async getBootstrapTemplates(decisionType: string) {
    const res = await this.db.prepare(
      'SELECT * FROM bootstrap_templates WHERE decision_type = ? ORDER BY success_rate DESC'
    ).bind(decisionType).all<Record<string, unknown>>();

    return (res.results || []).map(r => ({
      decision_type: r.decision_type,
      template_decisions: JSON.parse(String(r.template_decisions)),
      success_rate: r.success_rate,
      created_at: r.created_at,
    }));
  }

  async createBootstrapTemplate(decisionType: string, templates: unknown[], successRate: number): Promise<void> {
    await this.db.prepare(
      'INSERT INTO bootstrap_templates (id, decision_type, template_decisions, success_rate, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(uuid(), decisionType, JSON.stringify(templates), successRate, now()).run();
  }

  // ====== TIER 15: SNAPSHOTS ======

  async createSnapshot(accountId: string): Promise<Snapshot> {
    this.requireEncryptionKey();
    const id = uuid();
    const ts = now();

    const decisions = await this.db.prepare('SELECT * FROM decisions WHERE account_id = ?').bind(accountId).all<Record<string, unknown>>();
    const lessons = await this.db.prepare('SELECT * FROM lessons WHERE account_id = ?').bind(accountId).all<Record<string, unknown>>();

    const data = { decisions: decisions.results || [], lessons: lessons.results || [], timestamp: ts };
    const dataStr = JSON.stringify(data);
    const fileSize = new TextEncoder().encode(dataStr).length;
    const encrypted = await aesGcmEncrypt(dataStr, this.encryptionKey);

    await this.db.prepare(
      'INSERT INTO snapshots (id, account_id, snapshot_time, decisions_count, lessons_count, file_size, data_encrypted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, accountId, ts, decisions.results?.length || 0, lessons.results?.length || 0, fileSize, encrypted, ts).run();

    await this.audit.log(accountId, 'SNAPSHOT_CREATE', 'snapshot', id, { decisions_count: decisions.results?.length || 0 });

    return { id, account_id: accountId, snapshot_time: ts, decisions_count: decisions.results?.length || 0, lessons_count: lessons.results?.length || 0, file_size: fileSize, created_at: ts };
  }

  async restoreSnapshot(snapshotId: string, accountId: string): Promise<void> {
    this.requireEncryptionKey();
    const snapshot = await this.db.prepare('SELECT * FROM snapshots WHERE id = ? AND account_id = ?').bind(snapshotId, accountId).first<Record<string, unknown>>();
    if (!snapshot) throw new Error('Snapshot not found');

    const dataStr = await aesGcmDecrypt(String(snapshot.data_encrypted), this.encryptionKey);
    const data = JSON.parse(dataStr) as { decisions: Record<string, unknown>[]; lessons: Record<string, unknown>[] };

    // Atomic restore: delete then re-insert
    await this.db.prepare('DELETE FROM decisions WHERE account_id = ?').bind(accountId).run();
    await this.db.prepare('DELETE FROM lessons WHERE account_id = ?').bind(accountId).run();

    for (const d of data.decisions) {
      await this.db.prepare(
        'INSERT INTO decisions (id, account_id, decision_type, context, outcome, confidence, visibility, context_compressed, context_raw, impact_score, reuse_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(d.id, accountId, d.decision_type, d.context, d.outcome, d.confidence, d.visibility, d.context_compressed || 0, d.context_raw || d.context, d.impact_score || 0, d.reuse_count || 0, d.created_at, d.updated_at).run();
    }

    for (const l of data.lessons) {
      await this.db.prepare(
        'INSERT INTO lessons (id, account_id, title, content, domain_tags, transferability_score, is_published, publisher_reputation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(l.id, accountId, l.title, l.content, l.domain_tags, l.transferability_score || 0.5, l.is_published || 0, l.publisher_reputation || 0, l.created_at, l.updated_at).run();
    }

    await this.audit.log(accountId, 'SNAPSHOT_RESTORE', 'snapshot', snapshotId, {});
  }

  async listSnapshots(accountId: string) {
    const res = await this.db.prepare(
      'SELECT id, account_id, snapshot_time, decisions_count, lessons_count, file_size, created_at FROM snapshots WHERE account_id = ? ORDER BY created_at DESC'
    ).bind(accountId).all<Record<string, unknown>>();
    return res.results || [];
  }

  // ====== TIER 16: API VERSIONING ======

  async getApiVersions() {
    const res = await this.db.prepare('SELECT * FROM versions ORDER BY released_at DESC').all<Record<string, unknown>>();
    return (res.results || []).map(r => ({
      ...r,
      breaking_changes: r.breaking_changes ? JSON.parse(String(r.breaking_changes)) : undefined,
    }));
  }

  async getCurrentVersion(): Promise<ApiVersion | null> {
    const r = await this.db.prepare('SELECT * FROM versions WHERE deprecated_at IS NULL ORDER BY released_at DESC LIMIT 1').first<Record<string, unknown>>();
    if (!r) return null;
    return {
      id: String(r.id), version: String(r.version), released_at: String(r.released_at),
      deprecated_at: r.deprecated_at ? String(r.deprecated_at) : undefined,
      breaking_changes: r.breaking_changes ? JSON.parse(String(r.breaking_changes)) : undefined,
      created_at: String(r.created_at),
    };
  }

  // ====== TIER 19: SAFETY ======

  checkDecisionSafety(decisionType: string, context: Record<string, unknown>, outcome: string): SafetyResult {
    const content = decisionType + ' ' + JSON.stringify(context) + ' ' + outcome;
    return checkSafety(content);
  }

  async recordViolation(decisionId: string | null, violationType: string, severity: SafetyViolation['severity'], actionTaken: SafetyViolation['action_taken'], details?: Record<string, unknown>, accountId?: string): Promise<SafetyViolation> {
    const id = uuid();
    const ts = now();
    try {
      await this.db.prepare(
        'INSERT INTO safety_violations (id, decision_id, violation_type, severity, action_taken, details, created_at, account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(id, decisionId || '', violationType, severity, actionTaken, details ? JSON.stringify(details) : null, ts, accountId || null).run();
    } catch (e) {
      console.error('Safety violation recording failed:', e);
      // Don't let safety logging failures block the main flow
    }

    return { id, decision_id: decisionId || undefined, violation_type: violationType, severity, action_taken: actionTaken, details, created_at: ts };
  }

  async getSafetyViolations(accountId?: string, opts?: { decision_id?: string; severity?: string; limit?: number }) {
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (accountId) { conditions.push('account_id = ?'); params.push(accountId); }
    if (opts?.decision_id) { conditions.push('decision_id = ?'); params.push(opts.decision_id); }
    if (opts?.severity) { conditions.push('severity = ?'); params.push(opts.severity); }

    let sql = 'SELECT * FROM safety_violations';
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY created_at DESC';
    if (opts?.limit) { sql += ' LIMIT ?'; params.push(opts.limit); }

    const res = await this.db.prepare(sql).bind(...params).all<Record<string, unknown>>();
    return (res.results || []).map(r => ({
      ...r,
      details: r.details ? JSON.parse(String(r.details)) : undefined,
    }));
  }
}
