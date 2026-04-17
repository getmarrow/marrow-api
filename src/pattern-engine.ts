/**
 * Pattern Engine — Semantic clustering, failure detection, workflow gaps, actionable insights
 */
import { ActionableInsight, Cluster } from './types';
import { uuid, now } from './utils/crypto';
import { computeEmbedding, cosineSimilarity } from './utils/vectors';
import { DEFAULT_SEQUENCES, matchesTrigger, matchesFollowup } from './workflow-sequences';

const CLUSTER_SIMILARITY_THRESHOLD = 0.75;
const FAILURE_THRESHOLD = 3;

export class PatternEngine {
  constructor(private db: D1Database) {}

  /**
   * Main entry: analyze an action and return actionable insights
   */
  async analyze(
    accountId: string,
    action: string,
    decisionType: string,
    decisionId: string
  ): Promise<{ insights: ActionableInsight[]; clusterId: string | null }> {
    const insights: ActionableInsight[] = [];

    // 1. Cluster the action
    const clusterId = await this.clusterAction(accountId, action, decisionType, decisionId);

    // 2. Failure sequence detection
    const failureInsights = await this.detectFailurePatterns(accountId, clusterId);
    insights.push(...failureInsights);

    // 3. Workflow gap detection
    const gapInsights = await this.detectWorkflowGaps(accountId, action);
    insights.push(...gapInsights);

    // 4. Track this action as a potential trigger for future gap detection
    await this.recordWorkflowTrigger(accountId, action, decisionId);

    return { insights, clusterId };
  }

  /**
   * Semantic Action Clustering
   * Embed action text and find or create a cluster
   */
  private async clusterAction(
    accountId: string,
    action: string,
    decisionType: string,
    decisionId: string
  ): Promise<string | null> {
    // Generate embedding from action text
    const tokens = this.tokenize(action);
    const embedding = computeEmbedding(decisionType, tokens);

    // Get existing clusters for this account
    const clusters = await this.db
      .prepare('SELECT id, label, centroid, decision_count, failure_count FROM clusters WHERE account_id = ?')
      .bind(accountId)
      .all<{ id: string; label: string; centroid: string | null; decision_count: number; failure_count: number }>();

    let bestCluster: { id: string; similarity: number } | null = null;

    for (const cluster of (clusters.results || [])) {
      if (!cluster.centroid) continue;
      try {
        const centroid = JSON.parse(cluster.centroid) as number[];
        const sim = cosineSimilarity(embedding, centroid);
        if (sim > CLUSTER_SIMILARITY_THRESHOLD && (!bestCluster || sim > bestCluster.similarity)) {
          bestCluster = { id: cluster.id, similarity: sim };
        }
      } catch { continue; }
    }

    let clusterId: string;

    if (bestCluster) {
      // Add to existing cluster
      clusterId = bestCluster.id;
      await this.db
        .prepare('UPDATE clusters SET decision_count = decision_count + 1, last_seen = ? WHERE id = ?')
        .bind(now(), clusterId)
        .run();
    } else {
      // Create new cluster
      clusterId = uuid();
      const label = this.generateClusterLabel(action);
      await this.db
        .prepare('INSERT INTO clusters (id, account_id, label, centroid, decision_count, failure_count, last_seen, created_at) VALUES (?, ?, ?, ?, 1, 0, ?, ?)')
        .bind(clusterId, accountId, label, JSON.stringify(embedding), now(), now())
        .run();
    }

    // Link decision to cluster (scoped to account)
    await this.db
      .prepare('UPDATE decisions SET cluster_id = ? WHERE id = ? AND account_id = ?')
      .bind(clusterId, decisionId, accountId)
      .run()
      .catch(() => {});

    return clusterId;
  }

  /**
   * Failure Sequence Detection
   * Check if same cluster has 3+ consecutive failures
   */
  private async detectFailurePatterns(accountId: string, clusterId: string | null): Promise<ActionableInsight[]> {
    if (!clusterId) return [];

    const cluster = await this.db
      .prepare('SELECT label, failure_count, decision_count FROM clusters WHERE id = ?')
      .bind(clusterId)
      .first<{ label: string; failure_count: number; decision_count: number }>();

    if (!cluster) return [];

    // Count recent failures in this cluster (scoped to account)
    const failures = await this.db
      .prepare(`
        SELECT COUNT(*) as cnt FROM decisions
        WHERE cluster_id = ? AND account_id = ? AND outcome_success = 0
        AND created_at > datetime('now', '-7 days')
      `)
      .bind(clusterId, accountId)
      .first<{ cnt: number }>();

    const failCount = failures?.cnt ?? 0;

    if (failCount >= FAILURE_THRESHOLD) {
      // Update cluster failure count
      await this.db
        .prepare('UPDATE clusters SET failure_count = ? WHERE id = ?')
        .bind(failCount, clusterId)
        .run();

      return [{
        type: 'failure_pattern',
        summary: `"${cluster.label}" has failed ${failCount}x in the last 7 days`,
        action: `Review approach for "${cluster.label}" — recurring failures suggest a systemic issue`,
        severity: failCount >= 5 ? 'critical' : 'warning',
        count: failCount,
      }];
    }

    return [];
  }

  /**
   * Workflow Gap Detection
   * Check if expected follow-up steps are missing
   */
  private async detectWorkflowGaps(accountId: string, currentAction: string): Promise<ActionableInsight[]> {
    const insights: ActionableInsight[] = [];

    // Check if this action resolves any outstanding gaps
    const openGaps = await this.db
      .prepare('SELECT id, trigger_action, expected_followup FROM workflow_gaps WHERE account_id = ? AND resolved = 0')
      .bind(accountId)
      .all<{ id: string; trigger_action: string; expected_followup: string }>();

    for (const gap of (openGaps.results || [])) {
      // Require the followup keyword to be a significant part of the action (not just incidental substring)
      const action = currentAction.toLowerCase();
      const followup = gap.expected_followup.toLowerCase();
      const words = action.split(/\s+/);
      const hasKeyword = words.some(w => w.includes(followup) || followup.includes(w));
      if (hasKeyword && matchesFollowup(currentAction, gap.expected_followup)) {
        await this.db
          .prepare('UPDATE workflow_gaps SET resolved = 1 WHERE id = ?')
          .bind(gap.id)
          .run();
      }
    }

    // Check for unresolved gaps that have expired
    for (const seq of DEFAULT_SEQUENCES) {
      const expiredGaps = await this.db
        .prepare(`
          SELECT COUNT(*) as cnt FROM workflow_gaps
          WHERE account_id = ? AND expected_followup = ? AND resolved = 0
          AND created_at < datetime('now', '-' || ? || ' minutes')
        `)
        .bind(accountId, seq.followup, seq.timeoutMinutes)
        .first<{ cnt: number }>();

      if ((expiredGaps?.cnt ?? 0) > 0) {
        insights.push({
          type: 'workflow_gap',
          summary: `"${seq.followup}" not logged after "${seq.trigger}" (${expiredGaps!.cnt} time${expiredGaps!.cnt > 1 ? 's' : ''})`,
          action: `Run ${seq.followup} step before proceeding`,
          severity: seq.severity,
          count: expiredGaps!.cnt ?? 0,
        });
      }
    }

    return insights;
  }

  /**
   * Record a workflow trigger for gap tracking
   */
  private async recordWorkflowTrigger(accountId: string, action: string, decisionId: string): Promise<void> {
    // Cap: max 50 open gaps per account
    const openCount = await this.db
      .prepare('SELECT COUNT(*) as cnt FROM workflow_gaps WHERE account_id = ? AND resolved = 0')
      .bind(accountId)
      .first<{ cnt: number }>();
    if ((openCount?.cnt ?? 0) >= 50) return;

    for (const seq of DEFAULT_SEQUENCES) {
      if (matchesTrigger(action, seq.trigger)) {
        // Check if this specific trigger already has an unresolved gap
        const existing = await this.db
          .prepare('SELECT id FROM workflow_gaps WHERE account_id = ? AND trigger_decision_id = ? LIMIT 1')
          .bind(accountId, decisionId)
          .first();

        if (!existing) {
          await this.db
            .prepare('INSERT INTO workflow_gaps (id, account_id, trigger_action, expected_followup, trigger_decision_id, detected_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .bind(uuid(), accountId, seq.trigger, seq.followup, decisionId, now(), now())
            .run()
            .catch(() => {});
        }
      }
    }
  }

  /**
   * Tokenize action text for embedding
   */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2)
      .slice(0, 20);
  }

  /**
   * Generate a human-readable cluster label from action text
   */
  private generateClusterLabel(action: string): string {
    // Take first 5 significant words
    const words = action
      .replace(/[^a-zA-Z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2 && !['the', 'and', 'for', 'with', 'from', 'that', 'this', 'was', 'not'].includes(w.toLowerCase()))
      .slice(0, 5);
    return words.join(' ').toLowerCase() || 'unlabeled';
  }
}
