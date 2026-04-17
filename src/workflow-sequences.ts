/**
 * Workflow Sequence Definitions
 * Defines expected follow-up actions after specific triggers.
 * Hardcoded for now — designed for per-account configurability later.
 */
import { WorkflowSequence } from './types';

/**
 * Default workflow sequences.
 * trigger: keyword/phrase that indicates the start of a workflow step
 * followup: keyword/phrase expected within timeoutMinutes
 * Both use substring matching (case-insensitive) against action text
 */
export const DEFAULT_SEQUENCES: WorkflowSequence[] = [
  {
    trigger: 'build',
    followup: 'audit',
    timeoutMinutes: 30,
    severity: 'critical',
  },
  {
    trigger: 'audit',
    followup: 'patch',
    timeoutMinutes: 60,
    severity: 'warning',
  },
  {
    trigger: 'patch',
    followup: 'rescan',
    timeoutMinutes: 30,
    severity: 'critical',
  },
  {
    trigger: 'deploy',
    followup: 'verify',
    timeoutMinutes: 15,
    severity: 'warning',
  },
];

/**
 * Match an action string against workflow trigger keywords
 */
export function matchesTrigger(action: string, trigger: string): boolean {
  return action.toLowerCase().includes(trigger.toLowerCase());
}

/**
 * Match an action string against workflow followup keywords
 */
export function matchesFollowup(action: string, followup: string): boolean {
  return action.toLowerCase().includes(followup.toLowerCase());
}
