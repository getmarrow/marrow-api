/**
 * Tier 19: Safety & Alignment Guardrails
 * 12+ jailbreak pattern detectors
 */

interface SafetyPattern {
  name: string;
  regex: RegExp;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

const PATTERNS: SafetyPattern[] = [
  { name: 'prompt_injection', regex: /(?:execute|eval|run|import|require|system|shell|command|subprocess|exec)\s*(?:\(|[a-z]+\s*\()/i, severity: 'high' },
  { name: 'sql_injection', regex: /(?:DROP\s+TABLE|DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+.*SET|UNION\s+SELECT|;\s*--|';\s*DROP)/i, severity: 'critical' },
  { name: 'role_confusion', regex: /(?:i am|i'm|pretend|act as|roleplay).*(?:admin|moderator|system|root)/i, severity: 'high' },
  { name: 'authority_bypass', regex: /(?:bypass|circumvent|override|disable|deactivate)\s*(?:the\s+)?(?:auth|safety|security|permission|guard|mechanism)/i, severity: 'high' },
  { name: 'data_extraction', regex: /(?:show|reveal|expose|leak|dump|extract|exfiltrate)\s+(?:the\s+)?(?:\w+\s+)*?(?:password|secret|key|token|credential|private)/i, severity: 'critical' },
  { name: 'indirect_request', regex: /(?:ask|tell|instruct|make)\s*(?:the\s+)?(?:hive|system|other agents?)\s*(?:to\s+)?(?:violate|break|ignore|bypass)/i, severity: 'high' },
  { name: 'encoding_evasion', regex: /(?:base64|hex|rot13|unicode|encode|decode|obfuscate|unescape)\s*(?:the|this|payload|command|input)/i, severity: 'medium' },
  { name: 'token_smuggling', regex: /\x00|\x01|\x02|\x03|\x04|\x05|\x06|\x07|\x08/i, severity: 'medium' },
  { name: 'semantic_confusion', regex: /(?:don't\s+not|not\s+un|double\s+negative|reverse\s+psychology)/i, severity: 'low' },
  { name: 'authority_confusion', regex: /(?:as (?:an?|the)\s+)(?:owner|admin|creator|developer|authority|superuser|god)/i, severity: 'medium' },
  { name: 'constraint_relaxation', regex: /(?:ignore|forget|disregard|skip|remove)\s*(?:all\s+)?(?:safety|rules?|limits?|controls?|constraints?|guidelines?)/i, severity: 'high' },
  { name: 'cot_exploitation', regex: /(?:think\s+step\s+by\s+step|chain\s+of\s+thought|reasoning\s+trace).*(?:ignore|bypass|override)/i, severity: 'medium' },
  { name: 'adversarial_context', regex: /(?:destroy|attack|hack|exploit|pwn|0wn|compromise|breach|infiltrate)/i, severity: 'medium' },
];

const SEVERITY_SCORES: Record<string, number> = {
  low: 0.15,
  medium: 0.35,
  high: 0.65,
  critical: 1.0,
};

export interface SafetyResult {
  safe: boolean;
  risk_score: number;
  violations: Array<{
    type: string;
    severity: string;
    action: 'warn' | 'block' | 'escalate';
  }>;
}

/**
 * Check content for safety violations
 */
export function checkSafety(content: string): SafetyResult {
  const violations: SafetyResult['violations'] = [];
  let totalScore = 0;

  for (const pattern of PATTERNS) {
    if (pattern.regex.test(content)) {
      const action = pattern.severity === 'critical' ? 'block' as const
        : pattern.severity === 'high' ? 'escalate' as const
        : 'warn' as const;

      violations.push({
        type: pattern.name,
        severity: pattern.severity,
        action,
      });
      totalScore += SEVERITY_SCORES[pattern.severity];
    }
  }

  const riskScore = violations.length > 0
    ? Math.min(1, totalScore / violations.length)
    : 0;

  const hasCritical = violations.some(v => v.severity === 'critical');

  return {
    safe: !hasCritical,
    risk_score: riskScore,
    violations,
  };
}
