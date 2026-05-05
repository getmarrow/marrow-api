import type { D1Database } from '@cloudflare/workers-types';
import { BaselineService, type ImprovementBlock } from './baseline.service';
import { ImpactService } from './impact.service';
import type { NudgeMetricHighlight, NudgeResponse } from '../types';
import { safely } from '../utils/safely';

const MIN_DECISIONS_BETWEEN_NUDGES = 50;
const MAX_MESSAGE_LENGTH = 300;

interface NudgeDeps {
  baselineService?: Pick<BaselineService, 'captureAccountBaselineIfEligible' | 'getAccountImprovement'>;
  impactService?: Pick<ImpactService, 'getSavesCount'>;
  now?: () => Date;
}

interface AccountNudgeState {
  nudged_at: string | null;
  nudged_decision_count: number;
}

export class NudgeService {
  private baselineService: Pick<BaselineService, 'captureAccountBaselineIfEligible' | 'getAccountImprovement'>;
  private impactService: Pick<ImpactService, 'getSavesCount'>;
  private now: () => Date;

  constructor(private db: D1Database, deps: NudgeDeps = {}) {
    this.baselineService = deps.baselineService || new BaselineService(db);
    this.impactService = deps.impactService || new ImpactService(db);
    this.now = deps.now || (() => new Date());
  }

  async checkNudge(accountId: string): Promise<NudgeResponse> {
    const [account, totalRow] = await Promise.all([
      this.getAccountState(accountId),
      this.db.prepare('SELECT COUNT(*) as c FROM decisions WHERE account_id = ?').bind(accountId).first<{ c: number }>(),
    ]);

    const totalDecisions = totalRow?.c || 0;
    const nudgedDecisionCount = account?.nudged_decision_count || 0;
    const decisionsSinceLastNudge = Math.max(0, totalDecisions - nudgedDecisionCount);

    if (totalDecisions < MIN_DECISIONS_BETWEEN_NUDGES || decisionsSinceLastNudge < MIN_DECISIONS_BETWEEN_NUDGES) {
      return { nudge: false, message: null, metrics: null };
    }

    await this.baselineService.captureAccountBaselineIfEligible(accountId).catch((e) => safely(() => { console.warn('[silent-catch]', e); }, 'silent-catch'));
    const [improvement, saves] = await Promise.all([
      this.baselineService.getAccountImprovement(accountId),
      this.impactService.getSavesCount(accountId),
    ]);

    if (improvement.status !== 'active') {
      return { nudge: false, message: null, metrics: null };
    }

    const highlights = this.buildHighlights(improvement, saves.total);
    if (highlights.length === 0) {
      return { nudge: false, message: null, metrics: null };
    }

    const message = this.buildMessage(decisionsSinceLastNudge, highlights);
    if (!message) {
      return { nudge: false, message: null, metrics: null };
    }

    const nudgedAt = this.now().toISOString();
    await this.db
      .prepare('UPDATE accounts SET nudged_at = ?, nudged_decision_count = ? WHERE id = ?')
      .bind(nudgedAt, totalDecisions, accountId)
      .run();

    return {
      nudge: true,
      message,
      metrics: {
        total_decisions: totalDecisions,
        decisions_since_last_nudge: decisionsSinceLastNudge,
        nudged_at: nudgedAt,
        nudged_decision_count: totalDecisions,
        saves_count: saves.total,
        highlights,
        improvement,
      },
    };
  }

  private async getAccountState(accountId: string): Promise<AccountNudgeState | null> {
    return this.db
      .prepare('SELECT nudged_at, nudged_decision_count FROM accounts WHERE id = ? LIMIT 1')
      .bind(accountId)
      .first<AccountNudgeState>();
  }

  private buildHighlights(improvement: ImprovementBlock, savesCount: number): NudgeMetricHighlight[] {
    const highlights: Array<NudgeMetricHighlight & { score: number }> = [];

    if (improvement.time_to_success_seconds.delta_pct < 0) {
      const delta = Math.abs(improvement.time_to_success_seconds.delta_pct);
      highlights.push({
        key: 'time_to_success_seconds',
        label: 'faster execution',
        delta_pct: improvement.time_to_success_seconds.delta_pct,
        sentence: `you're ${this.formatPct(delta)} faster`,
        score: delta,
      });
    }

    if (improvement.attempts_per_success.delta_pct < 0) {
      const delta = Math.abs(improvement.attempts_per_success.delta_pct);
      highlights.push({
        key: 'attempts_per_success',
        label: 'fewer retries',
        delta_pct: improvement.attempts_per_success.delta_pct,
        sentence: `you're making ${this.formatPct(delta)} fewer retries`,
        score: delta,
      });
    }

    if (improvement.drift_rate.delta_pct < 0) {
      const delta = Math.abs(improvement.drift_rate.delta_pct);
      highlights.push({
        key: 'drift_rate',
        label: 'better pattern matching',
        delta_pct: improvement.drift_rate.delta_pct,
        sentence: `pattern drift is down ${this.formatPct(delta)}`,
        score: delta,
      });
    }

    if (improvement.success_rate.delta_pct > 0) {
      const delta = improvement.success_rate.delta_pct;
      highlights.push({
        key: 'success_rate',
        label: 'higher success rate',
        delta_pct: delta,
        sentence: `success rate is up ${this.formatPct(delta)}`,
        score: delta,
      });
    }

    if (savesCount > 0) {
      highlights.push({
        key: 'saves_count',
        label: 'known failures avoided',
        value: savesCount,
        sentence: `you avoided ${savesCount} known mistake${savesCount === 1 ? '' : 's'}`,
        score: savesCount * 10,
      });
    }

    return highlights
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(({ score: _score, ...highlight }) => highlight);
  }

  private buildMessage(decisionsSinceLastNudge: number, highlights: NudgeMetricHighlight[]): string | null {
    if (highlights.length === 0) return null;

    const [first, second, third] = highlights;
    const firstSentence = `Since we last checked ${decisionsSinceLastNudge} decisions ago, ${first.sentence}${second ? ` and ${second.sentence}` : ''}.`;
    const secondSentence = third ? `${this.capitalize(third.sentence)}.` : '';
    const message = `${firstSentence}${secondSentence ? ` ${secondSentence}` : ''}`.trim();

    if (message.length <= MAX_MESSAGE_LENGTH) return message;

    const shorter = `Since we last checked ${decisionsSinceLastNudge} decisions ago, you're ${first.sentence}.`;
    return shorter.length <= MAX_MESSAGE_LENGTH ? shorter : shorter.slice(0, MAX_MESSAGE_LENGTH).trimEnd();
  }

  private formatPct(value: number): string {
    const rounded = Math.round(value * 10) / 10;
    return `${rounded}%`;
  }

  private capitalize(value: string): string {
    return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
  }
}
