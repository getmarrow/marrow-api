/**
 * Org Service — organization/workspace management (Enterprise tier)
 */
import { uuid, now } from '../utils/crypto';

interface Org {
  id: string;
  name: string;
  owner_account_id: string;
  pii_strip_team: number;
  hive_contribution?: number;
  default_visibility?: string;
  created_at: string;
}

interface OrgMember {
  org_id: string;
  account_id: string;
  role: 'owner' | 'admin' | 'member';
  joined_at: string;
}

export class OrgService {
  constructor(private db: D1Database) {}

  async createOrg(name: string, ownerAccountId: string): Promise<Org> {
    const id = uuid();
    const ts = now();

    await this.db
      .prepare('INSERT INTO orgs (id, name, owner_account_id, created_at) VALUES (?, ?, ?, ?)')
      .bind(id, name, ownerAccountId, ts)
      .run();

    // Set org_id on owner account
    await this.db
      .prepare('UPDATE accounts SET org_id = ? WHERE id = ?')
      .bind(id, ownerAccountId)
      .run();

    // Add owner as member
    await this.db
      .prepare('INSERT INTO org_members (org_id, account_id, role, joined_at) VALUES (?, ?, ?, ?)')
      .bind(id, ownerAccountId, 'owner', ts)
      .run();

    return { id, name, owner_account_id: ownerAccountId, pii_strip_team: 0, created_at: ts };
  }

  async inviteMember(orgId: string, accountId: string, role: 'admin' | 'member' = 'member'): Promise<OrgMember> {
    const ts = now();

    await this.db
      .prepare('INSERT OR IGNORE INTO org_members (org_id, account_id, role, joined_at) VALUES (?, ?, ?, ?)')
      .bind(orgId, accountId, role, ts)
      .run();

    // Set org_id on invited account
    await this.db
      .prepare('UPDATE accounts SET org_id = ? WHERE id = ?')
      .bind(orgId, accountId)
      .run();

    return { org_id: orgId, account_id: accountId, role, joined_at: ts };
  }

  async listMembers(orgId: string): Promise<OrgMember[]> {
    const res = await this.db
      .prepare('SELECT * FROM org_members WHERE org_id = ? ORDER BY joined_at')
      .bind(orgId)
      .all<OrgMember>();
    return res.results || [];
  }

  async getOrgForAccount(accountId: string): Promise<Org | null> {
    return this.db
      .prepare('SELECT o.* FROM orgs o JOIN accounts a ON a.org_id = o.id WHERE a.id = ? LIMIT 1')
      .bind(accountId)
      .first<Org>();
  }

  async updatePiiStripTeam(orgId: string, enabled: boolean): Promise<void> {
    await this.db
      .prepare('UPDATE orgs SET pii_strip_team = ? WHERE id = ?')
      .bind(enabled ? 1 : 0, orgId)
      .run();
  }

  async isOrgMember(orgId: string, accountId: string): Promise<boolean> {
    const row = await this.db
      .prepare('SELECT 1 FROM org_members WHERE org_id = ? AND account_id = ? LIMIT 1')
      .bind(orgId, accountId)
      .first();
    return !!row;
  }
}
