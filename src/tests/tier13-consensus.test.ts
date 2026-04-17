import { describe, it, expect, beforeAll } from 'vitest';
import { setupTestDb } from './helpers';
import { ConsensusService } from '../services/consensus.service';

describe('Tier 13: Hive Consensus', () => {
  let db: D1Database;
  let service: ConsensusService;
  let accountId: string;
  let decisionId: string;

  beforeAll(async () => {
    db = await setupTestDb();
    service = new ConsensusService(db);
    accountId = 'consensus-account-' + Date.now();
    decisionId = 'consensus-dec-' + Date.now();

    await db.prepare('INSERT INTO accounts (id, name, email, tier) VALUES (?, ?, ?, ?)').bind(accountId, 'Test', 'test@example.com', 'free').run();
    await db
      .prepare('INSERT INTO decisions (id, account_id, decision_type, context, outcome, confidence, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(decisionId, accountId, 'test', JSON.stringify({}), 'outcome', 0.5, 'hive', new Date().toISOString(), new Date().toISOString())
      .run();
  });

  it('should record agree vote', async () => {
    const result = await service.recordVote(decisionId, accountId, 'agree');
    expect(result.vote_id).toBeDefined();
  });

  it('should record disagree vote', async () => {
    const agentId = 'agent-' + Date.now();
    const result = await service.recordVote(decisionId, agentId, 'disagree');
    expect(result.vote_id).toBeDefined();
  });

  it('should record abstain vote', async () => {
    const agentId = 'agent-abstain-' + Date.now();
    const result = await service.recordVote(decisionId, agentId, 'abstain');
    expect(result.vote_id).toBeDefined();
  });

  it('should calculate consensus', async () => {
    const analysis = await service.calculateConsensus(decisionId);
    expect(analysis).toBeDefined();
    expect(typeof analysis.consensus_ratio).toBe('number');
  });

  it('should get hive consensus', async () => {
    const result = await service.getHiveConsensus('test', 10);
    expect(Array.isArray(result)).toBe(true);
  });

  it('should detect disagreement', async () => {
    const result = await service.detectDisagreement(decisionId);
    expect(result).toBeDefined();
    expect(typeof result.disagreement_level).toBe('number');
  });
});
