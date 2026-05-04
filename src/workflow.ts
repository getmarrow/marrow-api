/**
 * Marrow Workflow Service
 * Unified integration layer: 3 calls, all 20 tiers
 * 
 * - before(): orchestrates T1,T2,T7,T8,T11,T10,T17,T4,T6
 * - after(): orchestrates T3,T12,T13,T17,T6,T9,T19,T5
 * - status(): orchestrates T17,T8,T11,T19,T13,T14,T16,T18,T15 in parallel
 */

import { DecisionService } from './services/decision.service';
import { FeedbackService } from './services/feedback.service';
import { PatternsService } from './services/patterns.service';
import { BootstrapService } from './services/bootstrap.service';
import { PriorityService } from './services/priority.service';
import { AnalyticsService } from './services/analytics.service';
import { CollaborationService } from './services/collaboration.service';
import { CausalityService } from './services/causality.service';
import { ConsensusService } from './services/consensus.service';
import { BaselineService } from './services/baseline.service';
import { SnapshotService } from './services/snapshot.service';
import { VersionService } from './services/version.service';
import { MarketplaceService } from './services/marketplace.service';
import { AuditService } from './services/audit.service';
import { PatternRecognitionService } from './services/pattern-recognition.service';
import { OrgService } from './services/org.service';
import { WorkflowWarning, LearnedTemplate, DecisionQuality } from './types';
import { D1Database } from '@cloudflare/workers-types';

export interface WorkflowBeforeInput {
  decision_type: string;
  action: string;
  description: string;
  visibility?: 'private' | 'shared' | 'hive' | 'team';
  session_id?: string | null;
  agent_id?: string | null;
  quality?: DecisionQuality | null;
}

export interface WorkflowBeforeOutput {
  decision_id: string;           // T2
  similar_decisions: any[];      // T7 — top 3
  risk_score: number | null;     // T7-P2 — predictive risk (0-1)
  bootstrap_templates: any[];    // T11
  patterns: any[];               // T8
  shared_context: any[];         // T4
  current_success_rate: number;  // T17
  priority_score: number;        // T10
  causal_context: object | null; // T6
  warnings: WorkflowWarning[];   // Active failure warnings
}

export interface WorkflowAfterInput {
  decision_id: string;
  success: boolean;
  outcome: string;
  related_decision_id?: string;
  agent_id?: string;
}

export interface WorkflowAfterOutput {
  outcome_recorded: boolean;     // T3
  consensus: object;             // T12+T13
  new_success_rate: number;      // T17
  velocity_trend: string;        // T17
  hive_signals: any[];           // T5
  audit_confirmed: boolean;      // T19
}

export interface WorkflowStatusOutput {
  analytics: any;                // T17
  patterns_count: number;        // T8
  templates_available: number;   // T11
  audit_trail_count: number;     // T19
  consensus_health: object;      // T13
  snapshots_count: number;       // T14
  api_version: string;           // T16
  lessons_published: number;     // T18
  restore_status: object;        // T15
  stream_available: boolean;     // T20
  timestamp: string;
}

export class WorkflowService {
  constructor(private db: D1Database, private ai?: any) {}

  /**
   * BEFORE: Pre-decision context from all 20 tiers
   * Calls: T1 (auth—handled upstream), T2, T7, T8, T11, T10, T17, T4, T6, T20 (note only)
   */
  async before(
    input: WorkflowBeforeInput,
    account_id: string,
    tier: string = 'free',
    orgPiiStripTeam: boolean = false
  ): Promise<WorkflowBeforeOutput> {
    const services = {
      decision: new DecisionService(this.db, this.ai),
      patterns: new PatternsService(this.db, this.ai),
      bootstrap: new BootstrapService(this.db),
      priority: new PriorityService(this.db),
      analytics: new AnalyticsService(this.db),
      collaboration: new CollaborationService(this.db),
      causality: new CausalityService(this.db),
    };

    try {
      // T2: Log the decision, get ID
      const decision = await services.decision.createDecision(
        account_id,
        input.decision_type,
        { action: input.action, description: input.description },
        input.description,
        0.5, // confidence
        input.visibility || 'hive',
        tier,
        orgPiiStripTeam,
        input.session_id || null,
        input.agent_id || null,
        input.quality || null
      );
      const decision_id = decision.id;

      if (input.quality === 'trivial') {
        return {
          decision_id,
          similar_decisions: [],
          risk_score: null,
          bootstrap_templates: [],
          patterns: [],
          shared_context: [],
          current_success_rate: 0.75,
          priority_score: 0,
          causal_context: null,
          warnings: [{
            severity: 'LOW',
            message: 'Trivial action logged for audit only and excluded from pattern training. Send a more specific action next time.',
            pattern: 'trivial_action',
          }],
        };
      }

      // Parallel calls to other tiers (don't block on each other)
      const [
        similarDecisions,  // T7
        patterns,          // T8
        templates,         // T11
        analytics,         // T17
        sharedContext,     // T4
      ] = await Promise.all([
        // T7: Routing suggestions (similar past decisions with risk score)
        // Phase 3: Org-wide routing for Team/Enterprise tiers
        (async () => {
          try {
            if (tier === 'enterprise' || tier === 'owner') {
              const orgSvc = new OrgService(this.db);
              const org = await orgSvc.getOrgForAccount(account_id);
              if (org) {
                return await services.patterns.predictSimilarDecisionsOrgWide(
                  { action: input.action, description: input.description },
                  input.decision_type, org.id, 3
                );
              }
            }
            return await services.patterns.predictSimilarDecisions(
              { action: input.action, description: input.description },
              input.decision_type, 3
            );
          } catch (e) {
            console.error('[T7 routing]', e instanceof Error ? e.message : e);
            return { similar: [], risk_score: null };
          }
        })(),

        // T8: Patterns discovery
        services.patterns
          .discoverPatterns(account_id, input.decision_type)
          .catch((e: unknown) => { console.error('[T8 patterns]', e instanceof Error ? e.message : e); return []; }),

        // T11: Bootstrap templates
        services.bootstrap
          .getTemplates(input.decision_type)
          .catch(() => []),

        // T17: Current analytics baseline
        services.analytics.getSystemAnalytics().catch(() => ({})),

        // T4: Hive shared context
        services.collaboration
          .getSharedDecisions(account_id, 50)
          .catch(() => []),
      ]);

      // T10: Set priority
      const priorityResult = await services.priority
        .calculatePriority(decision_id, account_id, 'normal', 0.7)
        .catch(() => ({ score: 0.5 }));

      // T6: Check causality (if recent decision exists)
      let causal_context: object | null = null;
      try {
        const recentDecisions = await services.decision.listDecisions(
          account_id,
          { limit: 1 }
        );
        if (recentDecisions.length > 0) {
          const recentId = recentDecisions[0].id;
          const causalGraph = await services.causality.getCausalityGraph(
            recentId,
            account_id
          );
          causal_context = causalGraph || null;
        }
      } catch (e) {
        // T6 optional, proceed without it
      }

      // T20: Note stream availability (don't call, just note)
      // Stream is available at GET /v1/stream

      const current_success_rate =
        (analytics as any)?.success_rate || 0.75;
      const priority_score = (priorityResult as any)?.score || 0.5;

      // Evaluate warnings based on failure patterns
      const warnings: WorkflowWarning[] = [];
      try {
        const recentStats = await this.db.prepare(
          `SELECT COUNT(*) as total,
           AVG(CASE WHEN outcome_success = 1 THEN 1.0 ELSE 0.0 END) as rate,
           (SELECT outcome FROM decisions WHERE account_id = ? AND decision_type = ? AND outcome_success = 0 ORDER BY created_at DESC LIMIT 1) as last_failure
           FROM decisions WHERE account_id = ? AND decision_type = ?`
        ).bind(account_id, input.decision_type, account_id, input.decision_type)
         .first<{total: number, rate: number | null, last_failure: string | null}>();

        if (recentStats && recentStats.total >= 3 && recentStats.rate !== null && recentStats.rate < 0.65) {
          warnings.push({
            severity: 'HIGH',
            message: `${input.decision_type} has ${Math.round(recentStats.rate * 100)}% success rate over ${recentStats.total} attempts. Last failure: "${recentStats.last_failure || 'unknown'}"`,
            pattern: 'repeated_failure',
          });
        } else if (recentStats && recentStats.total >= 5 && recentStats.rate !== null && recentStats.rate < 0.75) {
          warnings.push({
            severity: 'MEDIUM',
            message: `${input.decision_type} has mixed results (${Math.round(recentStats.rate * 100)}% success). Proceed carefully.`,
            pattern: 'mixed_results',
          });
        }

        // LOW: check patterns for failure keywords
        const fp = (patterns as Array<{pattern_signature?: string}>).filter(
          p => p.pattern_signature && /fail|error|wrong|broken/i.test(p.pattern_signature)
        );
        if (fp.length > 0) {
          warnings.push({
            severity: 'LOW',
            message: `Known failure pattern: "${fp[0].pattern_signature}"`,
            pattern: 'known_failure_pattern',
          });
        }
      } catch (_e) {
        // warnings stay []
      }

      const risk_score = (similarDecisions as any)?.risk_score ?? null;
      const similarList = (similarDecisions as any)?.similar || similarDecisions || [];

      return {
        decision_id,
        similar_decisions: Array.isArray(similarList) ? similarList.slice(0, 3) : [],
        risk_score,
        bootstrap_templates: templates || [],
        patterns: patterns || [],
        shared_context: sharedContext || [],
        current_success_rate,
        priority_score,
        causal_context,
        warnings,
      };
    } catch (e) {
      console.error('WorkflowService.before error:', e);
      throw new Error('Failed to prepare workflow context');
    }
  }

  /**
   * AFTER: Post-decision recording across all 20 tiers
   * Calls: T3, T12, T13, T17, T6, T9, T19, T5
   */
  async after(
    input: WorkflowAfterInput,
    account_id: string
  ): Promise<WorkflowAfterOutput> {
    const services = {
      decision: new DecisionService(this.db, this.ai),
      feedback: new FeedbackService(this.db),
      consensus: new ConsensusService(this.db),
      analytics: new AnalyticsService(this.db),
      causality: new CausalityService(this.db),
      patternRecognition: new PatternRecognitionService(this.db),
      collaboration: new CollaborationService(this.db),
      audit: new AuditService(this.db),
    };

    try {
      // T3: Record outcome
      const outcomeRecorded = await services.feedback
        .recordOutcome(input.decision_id, account_id, input.success, input.outcome)
        .then(() => true)
        .catch(() => false);

      // V6.5: Capture baseline snapshot (fire-and-forget, idempotent)
      const baseline = new BaselineService(this.db);
      baseline.captureAccountBaselineIfEligible(account_id).catch(() => {});
      if (input.agent_id) {
        baseline.captureAgentBaselineIfEligible(account_id, input.agent_id).catch(() => {});
      }

      // T12: Self-vote for consensus
      const voteResult = await services.consensus
        .recordVote(input.decision_id, account_id, input.success ? 'agree' : 'disagree', input.outcome)
        .catch(() => ({}));

      // T13: Get consensus metrics
      const consensus = await services.consensus
        .calculateConsensus(input.decision_id)
        .catch(() => ({}));

      // T17: Get updated analytics
      const updatedAnalytics = await services.analytics
        .getSystemAnalytics()
        .catch(() => ({}));
      const new_success_rate =
        (updatedAnalytics as any)?.success_rate || 0.75;
      const velocity_trend =
        (updatedAnalytics as any)?.velocity_trend || 'stable';

      // T6: Link causality if related decision provided
      if (input.related_decision_id) {
        try {
          await services.causality.addCausalityEdge(
            input.related_decision_id,
            input.decision_id,
            'derives_from',
            account_id
          );
        } catch (e) {
          /* optional */
        }
      }

      // T9: Create lesson if success (transferable learning)
      if (input.success) {
        try {
          await services.patternRecognition.recognizePatterns(
            account_id,
            undefined
          );
        } catch (e) {
          /* optional */
        }
      }

      // T19: Verify audit trail
      const auditChain = await services.audit.verifyChain().catch(() => ({
        valid: false,
      }));
      const auditConfirmed = (auditChain as any)?.valid || false;

      // T5: Get hive signals (trending decisions)
      const trendingTypes = await services.analytics
        .getTrendingTypes(10)
        .catch(() => []);

      return {
        outcome_recorded: outcomeRecorded,
        consensus,
        new_success_rate,
        velocity_trend,
        hive_signals: trendingTypes || [],
        audit_confirmed: auditConfirmed,
      };
    } catch (e) {
      console.error('WorkflowService.after error:', e);
      throw new Error('Failed to record workflow outcome');
    }
  }

  /**
   * STATUS: Full platform health snapshot across all 20 tiers (parallel calls)
   * Calls: T17, T8, T11, T19, T13, T14, T16, T18, T15
   */
  async status(accountId?: string): Promise<WorkflowStatusOutput> {
    const services = {
      analytics: new AnalyticsService(this.db),
      patterns: new PatternsService(this.db, this.ai),
      bootstrap: new BootstrapService(this.db),
      audit: new AuditService(this.db),
      consensus: new ConsensusService(this.db),
      snapshot: new SnapshotService(this.db),
      version: new VersionService(this.db),
      marketplace: new MarketplaceService(this.db),
    };

    try {
      const results = await Promise.all([
        services.analytics.getSystemAnalytics(), // T17
        services.patterns
          .discoverPatterns('any', 'general')
          .then((p) => p?.length || 0)
          .catch(() => 0), // T8
        services.bootstrap
          .getTemplates('general')
          .then((t) => t?.length || 0)
          .catch(() => 0), // T11
        services.audit
          .getAuditLog(accountId ? { account_id: accountId } : {})
          .then((a) => (a?.entries?.length || 0))
          .catch(() => 0), // T19
        services.consensus
          .calculateConsensus('')
          .catch(() => ({})), // T13
        services.snapshot
          .listSnapshots(accountId || 'any', 50)
          .then((s) => s?.length || 0)
          .catch(() => 0), // T14
        services.version
          .getCurrentVersion()
          .then((v) => (v?.version || 'unknown'))
          .catch(() => 'unknown'), // T16
        services.marketplace
          .getMarketplace('recent', 50)
          .then((l) => l?.length || 0)
          .catch(() => 0), // T18
        services.snapshot
          .getRestoreStatus('latest', accountId || 'any')
          .catch(() => ({ status: 'not_found' })), // T15
      ]);

      const [
        analytics,
        patterns_count,
        templates_available,
        audit_trail_count,
        consensus_health,
        snapshots_count,
        api_version,
        lessons_published,
        restore_status,
      ] = results;

      return {
        analytics: analytics || {},
        patterns_count: patterns_count as number,
        templates_available: templates_available as number,
        audit_trail_count: audit_trail_count as number,
        consensus_health: consensus_health || {},
        snapshots_count: snapshots_count as number,
        api_version: api_version as string,
        lessons_published: lessons_published as number,
        restore_status: restore_status || {},
        stream_available: true, // T20: always available
        timestamp: new Date().toISOString(),
      };
    } catch (e) {
      console.error('WorkflowService.status error:', e);
      throw new Error('Failed to retrieve platform status');
    }
  }
}
