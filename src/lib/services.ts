/**
 * Service Registry — module-level DI container.
 *
 * Created once per Worker isolate, reused across all requests.
 * Eliminates 157+ `new Service()` calls scattered across route handlers.
 * Service constructors are stateless — same DB/AI bindings every request.
 */
import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from '../types';

import { AuthService }            from '../services/auth.service';
import { DecisionService }        from '../services/decision.service';
import { PatternsService }        from '../services/patterns.service';
import { CollaborationService }   from '../services/collaboration.service';
import { FeedbackService }        from '../services/feedback.service';
import { CausalityService }       from '../services/causality.service';
import { PriorityService }        from '../services/priority.service';
import { EnterpriseService }      from '../services/enterprise.service';
import { AnalyticsService }       from '../services/analytics.service';
import { AuditService }           from '../services/audit.service';
import { TransferService }        from '../services/transfer.service';
import { BootstrapService }       from '../services/bootstrap.service';
import { ConsensusService }       from '../services/consensus.service';
import { SnapshotService }        from '../services/snapshot.service';
import { VersionService }         from '../services/version.service';
import { MarketplaceService }     from '../services/marketplace.service';
import { OtpService }             from '../services/otp.service';
import { WebhookService }         from '../services/webhook.service';
import { OrgService }             from '../services/org.service';
import { RetentionService }       from '../services/retention.service';
import { PiiService }             from '../services/pii.service';
import { WorkflowRegistryService } from '../services/workflow-registry.service';
import { TrendsService }          from '../services/trends.service';
import { SessionService }         from '../services/session.service';
import { ImpactService }          from '../services/impact.service';
import { DashboardService }       from '../services/dashboard.service';
import { CollectiveService }      from '../services/collective.service';
import { WorkflowDetectionService } from '../services/workflow-detection.service';
import { TemplatesService }       from '../services/templates.service';
import { FleetService }           from '../services/fleet.service';
import { NarrativeService }       from '../services/narrative.service';
import { EmailService }           from '../services/email.service';
import { MemoryService }          from '../services/memory.service';
import { VelocityService }        from '../services/velocity.service';
import { BaselineService }        from '../services/baseline.service';
import { NudgeService }           from '../services/nudge.service';
import { WorkflowService }        from '../workflow';

export interface Services {
  auth:                    AuthService;
  decisions:               DecisionService;
  patterns:                PatternsService;
  collaboration:           CollaborationService;
  feedback:                FeedbackService;
  causality:               CausalityService;
  priority:                PriorityService;
  enterprise:              EnterpriseService;
  analytics:               AnalyticsService;
  audit:                   AuditService;
  patternRecognition:      PatternsService;
  transfer:                TransferService;
  bootstrap:               BootstrapService;
  consensus:               ConsensusService;
  snapshot:                SnapshotService;
  version:                 VersionService;
  marketplace:             MarketplaceService;
  otp:                     OtpService;
  webhook:                 WebhookService;
  org:                     OrgService;
  retention:               RetentionService;
  pii:                     PiiService;
  workflowRegistry:        WorkflowRegistryService;
  trends:                  TrendsService;
  session:                 SessionService;
  impact:                  ImpactService;
  dashboard:               DashboardService;
  collective:              CollectiveService;
  workflowDetection:       WorkflowDetectionService;
  agent:                   FleetService;
  templates:               TemplatesService;
  fleet:                   FleetService;
  narrative:               NarrativeService;
  email:                   EmailService;
  memory:                  MemoryService;
  velocity:                VelocityService;
  baseline:                BaselineService;
  nudge:                   NudgeService;
  workflow:                WorkflowService;
}

const servicesByDb = new WeakMap<object, Services>();

/**
 * Return the singleton Services registry for this DB binding.
 *
 * In production, env.DB is stable across requests inside a worker isolate, so
 * services are created once and reused. In tests, each mock DB is a distinct
 * object, so state does not bleed between cases.
 */
export function getServices(env: Env): Services {
  const cacheKey = env.DB as unknown as object;
  const cached = servicesByDb.get(cacheKey);
  if (cached) return cached;

  const db: D1Database = env.DB;
  const ai: any = env.AI;

  const patterns = new PatternsService(db, ai);
  const fleet = new FleetService(db);

  const services: Services = {
      auth:                    new AuthService(db),
      decisions:               new DecisionService(db, ai),
      patterns,
      collaboration:           new CollaborationService(db),
      feedback:                new FeedbackService(db),
      causality:               new CausalityService(db),
      priority:                new PriorityService(db),
      enterprise:              new EnterpriseService(db, env.ENCRYPTION_KEY),
      analytics:               new AnalyticsService(db),
      audit:                   new AuditService(db),
      patternRecognition:      patterns,
      transfer:                new TransferService(db, ai),
      bootstrap:               new BootstrapService(db),
      consensus:               new ConsensusService(db),
      snapshot:                new SnapshotService(db, env.ENCRYPTION_KEY),
      version:                 new VersionService(db),
      marketplace:             new MarketplaceService(db),
      otp:                     new OtpService(db),
      webhook:                 new WebhookService(db, env.ENCRYPTION_KEY),
      org:                     new OrgService(db),
      retention:               new RetentionService(db),
      pii:                     new PiiService(),
      workflowRegistry:        new WorkflowRegistryService(db),
      trends:                  new TrendsService(db),
      session:                 new SessionService(db),
      impact:                  new ImpactService(db),
      dashboard:               new DashboardService(db, ai),
      collective:              new CollectiveService(db),
      workflowDetection:       new WorkflowDetectionService(db),
      agent:                   fleet,
      templates:               new TemplatesService(db),
      fleet,
      narrative:               new NarrativeService(db),
      email:                   new EmailService(db, env),
      memory:                  new MemoryService(db),
      velocity:                new VelocityService(db),
      baseline:                new BaselineService(db),
      nudge:                   new NudgeService(db),
      workflow:                new WorkflowService(db, ai),
  };

  servicesByDb.set(cacheKey, services);
  return services;
}

/**
 * Reset the service cache. Used only in tests to get fresh state.
 */
export function resetServices(): void {
  // WeakMap state is keyed by DB identity; tests use fresh mock DB objects.
}
