// ============= Environment =============
export interface Env {
  DB: D1Database;
  AI?: any; // CF Workers AI binding (optional)
  ENCRYPTION_KEY: string;
  ENVIRONMENT?: string;
  RESEND_API_KEY?: string;
  ADMIN_DASHBOARD_PASSWORD?: string;
  ADMIN_OWNER_KEY?: string;
  INTERNAL_KEY?: string;
  MARROW_ADMIN_TOKEN?: string;
  RESEND_API_KEY_PRIMARY?: string;
}

export interface Org {
  id: string;
  name: string;
  owner_account_id: string;
  created_at: string;
  pii_strip_team?: number;
  hive_contribution?: number; // 1 = contribute to global hive (default), 0 = read-only hive reader
  default_visibility?: string; // 'hive' | 'team' | 'private' — applied to all org decisions
}

export interface OrgMember {
  org_id: string;
  account_id: string;
  role: 'owner' | 'admin' | 'member';
  joined_at: string;
}

export interface Webhook {
  id: string;
  account_id: string;
  url: string;
  secret: string;
  decision_types: string | null;
  active: number;
  consecutive_failures: number;
  created_at: string;
}

// ============= Auth (Tier 1) =============
export interface Account {
  id: string;
  name: string;
  email: string;
  tier: 'free' | 'pro' | 'enterprise' | 'owner';
  org_id?: string | null;
  created_at: string;
}

export interface ApiKey {
  id: string;
  account_id: string;
  key_hash: string;
  status: 'active' | 'revoked';
  created_at: string;
  last_used_at?: string;
  revoked_at?: string;
}

export interface RequestContext {
  account_id: string;
  tier: 'free' | 'pro' | 'enterprise' | 'owner';
  api_key_id: string;
  agent_id?: string; // Set when auth token is an agent-scoped key (marrow_agent_*)
}

// ============= Decisions (Tiers 2-3) =============
export interface Decision {
  id: string;
  account_id: string;
  decision_type: string;
  context: Record<string, unknown>;
  outcome: string;
  confidence: number;
  visibility: 'private' | 'shared' | 'hive' | 'team';
  context_compressed: boolean;
  context_hive?: Record<string, unknown> | null;
  impact_score: number;
  reuse_count: number;
  last_reused_at?: string;
  outcome_recorded_at?: string;
  outcome_success?: boolean;
  outcome_details?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// ============= Collaboration (Tier 4) =============
export interface DecisionShare {
  id: string;
  decision_id: string;
  shared_by_account_id: string;
  shared_with_account_id: string;
  trust_score: number;
  created_at: string;
}

// ============= Causality (Tier 6) =============
export interface CausalityEdge {
  id: string;
  from_decision_id: string;
  to_decision_id: string;
  reasoning: string;
  created_at: string;
}

// ============= Vectors (Tier 7) =============
export interface DecisionVector {
  id: string;
  decision_id: string;
  vector_embedding: number[];
  decision_type: string;
  created_at: string;
}

// ============= Patterns (Tier 8) =============
export interface Pattern {
  id: string;
  account_id: string;
  decision_type: string;
  pattern_signature: string;
  frequency: number;
  first_seen: string;
  last_seen: string;
  confidence: number;
  created_at: string;
}

export interface TrendSignal {
  id: string;
  account_id: string;
  decision_type: string;
  trend_direction: 'up' | 'down' | 'stable';
  magnitude: number;
  calculated_at: string;
  created_at: string;
}

// ============= Lessons (Tier 9) =============
export interface Lesson {
  id: string;
  account_id: string;
  title: string;
  content: string;
  domain_tags?: string[];
  transferability_score: number;
  is_published: boolean;
  publisher_reputation: number;
  forked_from?: string;
  created_at: string;
  updated_at: string;
}

// ============= Priority (Tier 10) =============
export interface PriorityQueueEntry {
  id: string;
  account_id: string;
  decision_id: string;
  priority_score: number;
  recalculated_at: string;
  created_at: string;
}

// ============= Audit (Tier 13) =============
export interface AuditLogEntry {
  id: string;
  timestamp: string;
  account_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  changes?: Record<string, unknown>;
  hash: string;
  prev_hash?: string;
  created_at: string;
}

// ============= Consensus (Tier 14) =============
export interface ConsensusVote {
  id: string;
  decision_id: string;
  voting_agent_id: string;
  agrees: boolean;
  confidence_boost: number;
  voted_at: string;
  created_at: string;
}

// ============= Snapshots (Tier 15) =============
export interface Snapshot {
  id: string;
  account_id: string;
  snapshot_time: string;
  decisions_count: number;
  lessons_count: number;
  file_size: number;
  created_at: string;
}

// ============= Versioning (Tier 16) =============
export interface ApiVersion {
  id: string;
  version: string;
  released_at: string;
  deprecated_at?: string;
  breaking_changes?: Record<string, unknown>;
  created_at: string;
}

// ============= Analytics (Tier 17) =============
export interface AnalyticsSnapshot {
  id: string;
  account_id?: string;
  metric_name: string;
  value: number;
  recorded_at: string;
  created_at: string;
}

// ============= Marketplace (Tier 18) =============
export interface LessonStats {
  id: string;
  lesson_id: string;
  view_count: number;
  fork_count: number;
  rating_avg: number;
  rating_count: number;
  reputation_score: number;
  created_at: string;
  updated_at: string;
}

// ============= Safety (Tier 19) =============
export interface SafetyViolation {
  id: string;
  decision_id?: string;
  violation_type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  action_taken: 'warn' | 'block' | 'escalate';
  details?: Record<string, unknown>;
  created_at: string;
}

// ============= Daily Stats (Feature 3) =============
export interface DailyStats {
  id: string;
  account_id: string;
  date: string;
  total_decisions: number;
  successful_decisions: number;
  failed_decisions: number;
  success_rate: number;
  by_type: Record<string, number>;
  created_at: string;
}

// ============= Collective Patterns (Feature 4) =============
export interface CollectivePattern {
  id: string;
  pattern_key: string;
  decision_type: string;
  action_cluster: string;
  total_decisions: number;
  success_count: number;
  failure_count: number;
  success_rate: number;
  top_failure_reasons: string[];
  top_success_patterns: string[];
  sample_size: number;
  account_count: number;
  updated_at: string;
}

// ============= Detected Workflows (Feature 5) =============
export interface DetectedWorkflow {
  id: string;
  account_id: string;
  pattern_hash: string;
  step_sequence: string;
  occurrence_count: number;
  suggested_at: string | null;
  accepted: boolean;
  workflow_id: string | null;
  created_at: string;
  updated_at: string;
}

// ============= Saves / Impact (Feature 6) =============
export interface Save {
  id: string;
  account_id: string;
  decision_id: string;
  warning_type: string;
  warning_message: string;
  subsequent_decision_id: string | null;
  subsequent_success: number | null;
  confirmed_save: boolean;
  created_at: string;
}

// ============= Pattern Engine =============
export interface ActionableInsight {
  type: 'frequency' | 'failure_pattern' | 'workflow_gap' | 'hive_trend';
  summary: string;
  action: string;
  severity: 'info' | 'warning' | 'critical';
  count: number;
}

export interface Cluster {
  id: string;
  account_id: string;
  label: string;
  centroid: number[] | null;
  decision_count: number;
  failure_count: number;
  last_seen: string | null;
  created_at: string;
}

export interface WorkflowSequence {
  trigger: string;
  followup: string;
  timeoutMinutes: number;
  severity: 'warning' | 'critical';
}

// ============= Warnings =============
export interface WorkflowWarning {
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  message: string;
  pattern: string;
}

// ============= API Response =============
export interface ApiResponse<T = unknown> {
  data?: T;
  error?: string;
  details?: Record<string, string>;
  meta?: {
    version: string;
    timestamp: string;
    deprecation_warning?: string;
  };
}
