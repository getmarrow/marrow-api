/**
 * ServiceContext — lazy-init service cache for CF Workers.
 * Creates each service once per request, eliminates 178+ `new Service()` calls.
 * Workers are pooled — no state leaks between requests.
 */
import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from '../types';

import { AuthService } from './auth.service';
import { DecisionService } from './decision.service';
import { PatternsService } from './patterns.service';
import { CollaborationService } from './collaboration.service';
import { FeedbackService } from './feedback.service';
import { CausalityService } from './causality.service';
import { PriorityService } from './priority.service';
import { EnterpriseService } from './enterprise.service';
import { AnalyticsService } from './analytics.service';
import { AuditService } from './audit.service';
import { PatternRecognitionService } from './pattern-recognition.service';
import { TransferService } from './transfer.service';
import { BootstrapService } from './bootstrap.service';
import { ConsensusService } from './consensus.service';
import { SnapshotService } from './snapshot.service';
import { VersionService } from './version.service';
import { MarketplaceService } from './marketplace.service';
import { OtpService } from './otp.service';
import { WebhookService } from './webhook.service';
import { OrgService } from './org.service';
import { RetentionService } from './retention.service';
import { PiiService } from './pii.service';
import { WorkflowRegistryService } from './workflow-registry.service';
import { TrendsService } from './trends.service';
import { SessionService } from './session.service';
import { ImpactService } from './impact.service';
import { DashboardService } from './dashboard.service';
import { CollectiveService } from './collective.service';
import { WorkflowDetectionService } from './workflow-detection.service';
import { AgentService } from './agent.service';
import { TemplatesService } from './templates.service';
import { FleetService } from './fleet.service';
import { NarrativeService } from './narrative.service';
import { EmailService } from './email.service';
import { MemoryService } from './memory.service';
import { VelocityService } from './velocity.service';
import { BaselineService } from './baseline.service';
import { NudgeService } from './nudge.service';
import { WorkflowService } from '../workflow';

export class ServiceContext {
  private cache = new Map<string, unknown>();
  constructor(
    public readonly db: D1Database,
    public readonly ai: any,
    public readonly env: Env,
  ) {}

  private get<T>(name: string, factory: () => T): T {
    if (!this.cache.has(name)) this.cache.set(name, factory());
    return this.cache.get(name) as T;
  }

  auth()      { return this.get('auth', () => new AuthService(this.db)); }
  decisions() { return this.get('decisions', () => new DecisionService(this.db, this.ai)); }
  patterns()  { return this.get('patterns', () => new PatternsService(this.db, this.ai)); }
  workflow()  { return this.get('workflow', () => new WorkflowService(this.db, this.ai)); }
  nudge()     { return this.get('nudge', () => new NudgeService(this.db)); }
  email()     { return this.get('email', () => new EmailService(this.db, this.env)); }
  pii()       { return this.get('pii', () => new PiiService()); }
  baseline()  { return this.get('baseline', () => new BaselineService(this.db)); }
  velocity()  { return this.get('velocity', () => new VelocityService(this.db)); }
  impact()    { return this.get('impact', () => new ImpactService(this.db)); }
  dashboard() { return this.get('dashboard', () => new DashboardService(this.db, this.ai)); }
  collective(){ return this.get('collective', () => new CollectiveService(this.db)); }
  collaboration() { return this.get('collaboration', () => new CollaborationService(this.db)); }
  feedback()  { return this.get('feedback', () => new FeedbackService(this.db)); }
  causality() { return this.get('causality', () => new CausalityService(this.db)); }
  priority()  { return this.get('priority', () => new PriorityService(this.db)); }
  enterprise(){ return this.get('enterprise', () => new EnterpriseService(this.db, this.ai)); }
  analytics() { return this.get('analytics', () => new AnalyticsService(this.db)); }
  audit()     { return this.get('audit', () => new AuditService(this.db)); }
  patternRecognition() { return this.get('patRecognition', () => new PatternRecognitionService(this.db)); }
  transfer()  { return this.get('transfer', () => new TransferService(this.db, this.ai)); }
  bootstrap() { return this.get('bootstrap', () => new BootstrapService(this.db)); }
  consensus() { return this.get('consensus', () => new ConsensusService(this.db)); }
  snapshot()  { return this.get('snapshot', () => new SnapshotService(this.db)); }
  version()   { return this.get('version', () => new VersionService(this.db)); }
  marketplace() { return this.get('marketplace', () => new MarketplaceService(this.db)); }
  otp()       { return this.get('otp', () => new OtpService(this.db)); }
  webhook()   { return this.get('webhook', () => new WebhookService(this.db)); }
  org()       { return this.get('org', () => new OrgService(this.db)); }
  retention() { return this.get('retention', () => new RetentionService(this.db)); }
  workflowRegistry() { return this.get('wfRegistry', () => new WorkflowRegistryService(this.db)); }
  trends()    { return this.get('trends', () => new TrendsService(this.db)); }
  session()   { return this.get('session', () => new SessionService(this.db)); }
  sessions()  { return this.session(); }
  workflowDetection() { return this.get('wfDetection', () => new WorkflowDetectionService(this.db)); }
  agent()     { return this.get('agent', () => new AgentService(this.db)); }
  agents()    { return this.agent(); }
  templates() { return this.get('templates', () => new TemplatesService(this.db)); }
  fleet()     { return this.get('fleet', () => new FleetService(this.db)); }
  narrative() { return this.get('narrative', () => new NarrativeService(this.db)); }
  memory()    { return this.get('memory', () => new MemoryService(this.db)); }
}

export function createServices(env: Env): ServiceContext {
  return new ServiceContext(env.DB, env.AI, env);
}
