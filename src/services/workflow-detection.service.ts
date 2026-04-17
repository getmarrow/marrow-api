/**
 * Feature 5: Auto-Workflow Detection
 * Detects recurring decision sequences and suggests enforced workflows.
 * C1: All queries scoped to accountId.
 */
import { DetectedWorkflow } from '../types';
import { uuid } from '../utils/crypto';

export class WorkflowDetectionService {
  constructor(private db: D1Database) {}

  /**
   * detectPatterns: Daily cron job per account.
   * Analyzes the last 200 decisions, extracts sequences of 3+ consecutive
   * decision types, hashes each unique sequence, counts occurrences.
   * Threshold: 5+ occurrences triggers a detected_workflows entry.
   */
  async detectPatterns(accountId: string): Promise<number> {
    // Get recent decisions ordered by time
    const rows = await this.db.prepare(`
      SELECT id, decision_type, created_at
      FROM decisions
      WHERE account_id = ?
      ORDER BY created_at DESC
      LIMIT 200
    `).bind(accountId).all<{ id: string; decision_type: string; created_at: string }>();

    if (rows.results && rows.results.length < 6) return 0; // Need at least 6 for a 3-step sequence

    const decisions = rows.results!.reverse(); // Oldest first for sequence detection
    const sequenceMap = new Map<string, { sequence: string[]; ids: string[] }>();

    // Extract all sequences of 3-7 consecutive decision types
    for (let i = 0; i < decisions.length - 2; i++) {
      for (let len = 3; len <= 7 && i + len <= decisions.length; len++) {
        const sequence = decisions.slice(i, i + len).map(d => d.decision_type);
        const key = sequence.join('→');
        if (!sequenceMap.has(key)) {
          sequenceMap.set(key, { sequence, ids: [] });
        }
        sequenceMap.get(key)!.ids.push(decisions[i].id);
      }
    }

    let detected = 0;
    for (const [key, data] of sequenceMap.entries()) {
      // ids.length is the number of window starting positions that matched this sequence
      const occurrenceCount = data.ids.length;

      if (occurrenceCount < 5) continue;

      const patternHash = await this.hashSequence(key);

      // Check if already exists
      const existing = await this.db.prepare(`
        SELECT id, occurrence_count FROM detected_workflows
        WHERE account_id = ? AND pattern_hash = ?
      `).bind(accountId, patternHash).first<{ id: string; occurrence_count: number }>();

      if (existing) {
        // Update count — use max to avoid decreasing on smaller sample windows
        const newCount = Math.max(existing.occurrence_count, occurrenceCount);
        await this.db.prepare(`
          UPDATE detected_workflows
          SET occurrence_count = ?, updated_at = datetime('now')
          WHERE id = ?
        `).bind(newCount, existing.id).run();
      } else {
        // Insert new detection
        await this.db.prepare(`
          INSERT INTO detected_workflows
            (id, account_id, pattern_hash, step_sequence, occurrence_count, suggested_at, accepted, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'), 0, datetime('now'), datetime('now'))
        `).bind(uuid(), accountId, patternHash, key, occurrenceCount).run();
        detected++;
      }
    }

    return detected;
  }

  /**
   * getSuggestions: Return unaccepted detected workflows for orient() response.
   */
  async getSuggestions(accountId: string): Promise<Array<{
    id: string;
    steps: string[];
    occurrences: number;
    message: string;
  }>> {
    const rows = await this.db.prepare(`
      SELECT * FROM detected_workflows
      WHERE account_id = ? AND accepted = 0 AND occurrence_count >= 5
      ORDER BY occurrence_count DESC
      LIMIT 10
    `).bind(accountId).all<{
      id: string; step_sequence: string; occurrence_count: number;
    }>();

    return (rows.results || []).map(r => {
      const steps = r.step_sequence.split('→');
      const message = `Detected pattern: you consistently follow ${steps.slice(0, -1).join(' then ')} then ${steps[steps.length - 1]}. Want to enforce this as a workflow?`;
      return {
        id: r.id,
        steps,
        occurrences: r.occurrence_count,
        message,
      };
    });
  }

  /**
   * acceptDetected: Convert a detected pattern into a registered workflow.
   * Uses the WorkflowRegistryService to register the workflow.
   * Returns the new workflow_id.
   */
  async acceptDetected(
    detectedId: string,
    accountId: string,
    workflowRegistry: { register: (input: { name: string; description?: string; steps: Array<{ step: number; description: string }> }, accountId: string) => Promise<{ workflowId: string; version: number }> }
  ): Promise<{ workflowId: string; version: number } | null> {
    const detected = await this.db.prepare(`
      SELECT * FROM detected_workflows WHERE id = ? AND account_id = ? AND accepted = 0
    `).bind(detectedId, accountId).first<{
      id: string; step_sequence: string; pattern_hash: string;
    }>();

    if (!detected) return null;

    const steps = detected.step_sequence.split('→');
    const workflowName = `Auto-detected workflow (${detected.pattern_hash.slice(0, 8)})`;

    const result = await workflowRegistry.register({
      name: workflowName,
      description: `Auto-detected from ${steps.length} recurring decision steps`,
      steps: steps.map((s, i) => ({ step: i + 1, description: s })),
    }, accountId);

    // Mark as accepted and store the workflow_id
    await this.db.prepare(`
      UPDATE detected_workflows
      SET accepted = 1, workflow_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).bind(result.workflowId, detectedId).run();

    return result;
  }

  /**
   * Deterministic SHA-256 hash for a sequence.
   * Keep the full 64-char hex digest to avoid unnecessary collision risk.
   */
  private async hashSequence(sequence: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(sequence);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }
}
