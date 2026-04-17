/**
 * Org Service — organization/workspace management (V5 Fleet)
 * Extends V4 orgs with RBAC, slugs, industry, and plan columns.
 */
import { uuid, now } from '../utils/crypto';

export type OrgRole = 'owner' | 'admin' | 'operator' | 'viewer';

export interface Org {
  id: string;
  name: string;
  slug: string | null;
  industry: string | null;
  plan: string;
  owner_account_id: string;
  pii_strip_team: number;
  hive_contribution?: number;
  default_visibility?: string;
  created_at: string;
  updated_at: string | null;
}

export interface OrgMember {
  id: string | null;
  org_id: string;
  account_id: string;
  role: OrgRole;
  invited_at: string | null;
  joined_at: string | null;
}

const VALID_ROLES: OrgRole[] = ['owner', 'admin', 'operator', 'viewer'];

/** Role hierarchy: higher index = more access */
const ROLE_LEVEL: Record<OrgRole, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 };

export class OrgService {
  constructor(private db: D1Database) {}

  /**
   * Create an organization. The creator becomes the owner.
   */
  async createOrg(
    name: string,
    ownerAccountId: string,
    industry?: string
  ): Promise<Org> {
    const id = uuid();
    const ts = now();
    const safeName = (name || '').trim().slice(0, 100);
    if (!safeName) throw new Error('Organization name is required');

    const slug = safeName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60);

    const safeIndustry = industry?.trim().slice(0, 100) || null;

    await this.db
      .prepare(
        `INSERT INTO orgs (id, name, slug, industry, plan, owner_account_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'free', ?, ?, ?)`
      )
      .bind(id, safeName, slug, safeIndustry, ownerAccountId, ts, ts)
      .run();

    // Set org_id on owner account
    await this.db
      .prepare('UPDATE accounts SET org_id = ? WHERE id = ?')
      .bind(id, ownerAccountId)
      .run();

    // Add owner as member
    const memberId = uuid();
    await this.db
      .prepare(
        `INSERT INTO org_members (id, org_id, account_id, role, invited_at, joined_at)
         VALUES (?, ?, ?, 'owner', ?, ?)`
      )
      .bind(memberId, id, ownerAccountId, ts, ts)
      .run();

    return {
      id,
      name: safeName,
      slug,
      industry: safeIndustry,
      plan: 'free',
      owner_account_id: ownerAccountId,
      pii_strip_team: 0,
      created_at: ts,
      updated_at: ts,
    };
  }

  /**
   * Get organization by ID.
   */
  async getOrg(orgId: string): Promise<Org | null> {
    return this.db
      .prepare('SELECT * FROM orgs WHERE id = ?')
      .bind(orgId)
      .first<Org>();
  }

  /**
   * Get org details + members for display.
   */
  async getOrgWithMembers(orgId: string): Promise<{ org: Org; members: OrgMember[] } | null> {
    const org = await this.getOrg(orgId);
    if (!org) return null;
    const members = await this.listMembers(orgId);
    return { org, members };
  }

  /**
   * Add a member to the org. Caller must be admin or owner.
   */
  async addMember(
    orgId: string,
    accountId: string,
    role: OrgRole = 'viewer'
  ): Promise<OrgMember> {
    if (!VALID_ROLES.includes(role) || role === 'owner') {
      throw new Error(`Invalid role: ${role}. Use admin, operator, or viewer.`);
    }

    // M1 fix: Verify target account exists before creating member record
    const accountExists = await this.db
      .prepare('SELECT id FROM accounts WHERE id = ? LIMIT 1')
      .bind(accountId)
      .first();
    if (!accountExists) throw new Error('Target account does not exist');

    const ts = now();
    const memberId = uuid();

    await this.db
      .prepare(
        `INSERT OR IGNORE INTO org_members (id, org_id, account_id, role, invited_at, joined_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(memberId, orgId, accountId, role, ts, ts)
      .run();

    // Set org_id on invited account
    await this.db
      .prepare('UPDATE accounts SET org_id = ? WHERE id = ?')
      .bind(orgId, accountId)
      .run();

    return { id: memberId, org_id: orgId, account_id: accountId, role, invited_at: ts, joined_at: ts };
  }

  /**
   * Remove a member from the org. Cannot remove the owner.
   */
  async removeMember(orgId: string, memberId: string): Promise<boolean> {
    // Don't allow removing owners
    const member = await this.db
      .prepare('SELECT role, account_id FROM org_members WHERE id = ? AND org_id = ?')
      .bind(memberId, orgId)
      .first<{ role: string; account_id: string }>();

    if (!member) return false;
    if (member.role === 'owner') throw new Error('Cannot remove the organization owner');

    await this.db
      .prepare('DELETE FROM org_members WHERE id = ? AND org_id = ?')
      .bind(memberId, orgId)
      .run();

    // Clear org_id on removed account
    await this.db
      .prepare('UPDATE accounts SET org_id = NULL WHERE id = ? AND org_id = ?')
      .bind(member.account_id, orgId)
      .run();

    return true;
  }

  /**
   * Update a member's role. Cannot change owner role.
   */
  async updateMemberRole(orgId: string, memberId: string, newRole: OrgRole): Promise<boolean> {
    if (!VALID_ROLES.includes(newRole) || newRole === 'owner') {
      throw new Error(`Invalid role: ${newRole}`);
    }

    const member = await this.db
      .prepare('SELECT role FROM org_members WHERE id = ? AND org_id = ?')
      .bind(memberId, orgId)
      .first<{ role: string }>();

    if (!member) return false;
    if (member.role === 'owner') throw new Error('Cannot change the owner role');

    await this.db
      .prepare('UPDATE org_members SET role = ? WHERE id = ? AND org_id = ?')
      .bind(newRole, memberId, orgId)
      .run();

    return true;
  }

  /**
   * Get a member's role in an org. Returns null if not a member.
   */
  async getMemberRole(orgId: string, accountId: string): Promise<OrgRole | null> {
    const row = await this.db
      .prepare('SELECT role FROM org_members WHERE org_id = ? AND account_id = ?')
      .bind(orgId, accountId)
      .first<{ role: OrgRole }>();
    return row?.role || null;
  }

  /**
   * Check if account has at least the required role level.
   */
  async hasMinRole(orgId: string, accountId: string, minRole: OrgRole): Promise<boolean> {
    const role = await this.getMemberRole(orgId, accountId);
    if (!role) return false;
    return ROLE_LEVEL[role] >= ROLE_LEVEL[minRole];
  }

  /**
   * List members of an org.
   */
  async listMembers(orgId: string): Promise<OrgMember[]> {
    const res = await this.db
      .prepare('SELECT id, org_id, account_id, role, invited_at, joined_at FROM org_members WHERE org_id = ? ORDER BY joined_at')
      .bind(orgId)
      .all<OrgMember>();
    return res.results || [];
  }

  /**
   * Get the org for an account (via accounts.org_id).
   */
  async getOrgForAccount(accountId: string): Promise<Org | null> {
    return this.db
      .prepare('SELECT o.* FROM orgs o JOIN accounts a ON a.org_id = o.id WHERE a.id = ? LIMIT 1')
      .bind(accountId)
      .first<Org>();
  }

  /**
   * Update PII strip team setting.
   */
  async updatePiiStripTeam(orgId: string, enabled: boolean): Promise<void> {
    await this.db
      .prepare('UPDATE orgs SET pii_strip_team = ? WHERE id = ?')
      .bind(enabled ? 1 : 0, orgId)
      .run();
  }

  /**
   * Check if account is an org member.
   */
  async isOrgMember(orgId: string, accountId: string): Promise<boolean> {
    const row = await this.db
      .prepare('SELECT 1 FROM org_members WHERE org_id = ? AND account_id = ? LIMIT 1')
      .bind(orgId, accountId)
      .first();
    return !!row;
  }
}
