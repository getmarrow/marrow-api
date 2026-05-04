import type { Env, RequestContext, WorkflowWarning } from '../types';

export type ActionQualityErrorCode =
  | 'action_required'
  | 'action_too_short'
  | 'action_lacks_substance'
  | 'not_meaningful'
  | 'no_verb';

export type ActionQualityValidation =
  | { valid: true }
  | {
      valid: false;
      code: ActionQualityErrorCode;
      message: string;
      hint?: string;
      quality: 'trivial';
      reason:
        | 'empty'
        | 'too_short'
        | 'low_entropy'
        | 'noise_pattern'
        | 'missing_verb';
    };

export const NOISE_PATTERNS = [
  /^session (stable|active|check|end|final|summary|start|open|alive|running)(?:[\s.!:,-]*)$/i,
  /^session(?:[\s.!:,-]*)$/i,
  /^(?:still\s+)?(?:standing|waiting|monitoring|watching|listening|holding)(?:\s+by)?(?:[\s.!:,-]*)$/i,
  /^holding (?:position|steady)(?:[\s.!:,-]*)$/i,
  /^all (?:systems?\s+)?(?:good|green|nominal|ok|fine|stable|healthy|clear|quiet)(?:[\s.!:,-]*)$/i,
  /^everything(?:'?s)?\s+(?:good|fine|ok|stable|working)(?:[\s.!:,-]*)$/i,
  /^(?:status\s+)?(?:check|update)(?:\s*[.!:,-]*)$/i,
  /^no\s+(?:updates?|changes?|issues?|news?|progress|activity|errors?)(?:[\s.!:,-]*)$/i,
  /^nothing\s+(?:new|to\s+report|happening)(?:[\s.!:,-]*)$/i,
  /^(?:ok|okay|got\s+it|understood|acknowledged|confirmed|noted|roger|10-4)(?:[\s.!:,-]*)$/i,
  /^(?:heartbeat|pulse|ping|health\s*check)(?:[\s.!:,-]*)$/i,
  /^(?:still|I'?m)\s+(?:here|alive|awake|around|present)(?:[\s.!:,-]*)$/i,
  /^(?:reading|checking|reviewing|looking\s+at|scanning)\s+(?:context|memory|notes?|files?|docs?|history)(?:[\s.!:,-]*)$/i,
  /^(?:loading|fetching|getting)\s+(?:context|memory|state)(?:[\s.!:,-]*)$/i,
  /^(?:ready|standing|raring|primed)(?:[\s.!:,-]*)$/i,
  /^(?:yep|yeah|yes|nope?|nah|sure|alright)(?:[\s.!:,-]*)$/i,
  /^(?:here|present)(?:\s*[!]*)?(?:[\s.!:,-]*)$/i,
];

export const ACTION_VERBS = /\b(?:add|analyze|audit|build|change|clean|commit|configure|create|debug|delete|deploy|deprecate|design|draft|document|extend|fix|generate|implement|install|integrate|investigate|migrate|modify|optimize|patch|plan|publish|push|record|refactor|release|remove|repair|replace|report|resolve|restart|review|rollback|run|schedule|script|setup|ship|spec|start|stop|sync|test|track|train|triage|troubleshoot|update|upgrade|validate|verify|write)\b/i;

function normalizeAction(action: string): string {
  return action.trim().replace(/\s+/g, ' ');
}

function uniqueNonWhitespaceChars(action: string): number {
  return new Set(action.replace(/\s+/g, '').split('')).size;
}

export function validateActionQuality(action: string): ActionQualityValidation {
  const normalized = normalizeAction(action || '');

  if (!normalized) {
    return {
      valid: false,
      code: 'action_required',
      message: 'Action required',
      quality: 'trivial',
      reason: 'empty',
    };
  }

  if (normalized.length < 10) {
    return {
      valid: false,
      code: 'action_too_short',
      message: 'Action must be at least 10 characters',
      quality: 'trivial',
      reason: 'too_short',
    };
  }

  if (uniqueNonWhitespaceChars(normalized) <= 3) {
    return {
      valid: false,
      code: 'action_lacks_substance',
      message: 'Action lacks substance',
      quality: 'trivial',
      reason: 'low_entropy',
    };
  }

  if (NOISE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      valid: false,
      code: 'not_meaningful',
      message: 'Action not meaningful enough to log. Requires a specific verb describing what was done.',
      hint: "Instead of 'checking context', try 'Updated memory with session context'",
      quality: 'trivial',
      reason: 'noise_pattern',
    };
  }

  if (normalized.length < 40 && !ACTION_VERBS.test(normalized)) {
    return {
      valid: false,
      code: 'no_verb',
      message: 'Action requires a recognizable verb describing what was done',
      quality: 'trivial',
      reason: 'missing_verb',
    };
  }

  return { valid: true };
}

export function classifyDecisionQuality(action: string): {
  quality: 'trivial' | null;
  filtered: boolean;
  reason?: 'trivial_action';
} {
  const result = validateActionQuality(action);
  if (!result.valid) {
    return { quality: 'trivial', filtered: true, reason: 'trivial_action' };
  }
  return { quality: null, filtered: false };
}

export function actionQualityWarning(result: Exclude<ActionQualityValidation, { valid: true }>): WorkflowWarning {
  return {
    severity: 'LOW',
    message: `${result.message}${result.hint ? ` ${result.hint}` : ''}`,
    pattern: 'trivial_action',
  };
}

export function isStrictQualityMode(env: Env, ctx?: RequestContext | null): boolean {
  if (ctx?.api_key_type === 'test') return true;
  const flag = String(env.MARROW_STRICT_QUALITY || '').trim().toLowerCase();
  return flag === 'true' || flag === '1' || flag === 'yes' || flag === 'on';
}
