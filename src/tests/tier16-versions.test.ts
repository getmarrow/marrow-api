import { describe, it, expect, beforeAll } from 'vitest';
import { setupTestDb } from './helpers';
import { VersionService } from '../services/version.service';

describe('Tier 16: Version History', () => {
  let db: D1Database;
  let service: VersionService;

  beforeAll(async () => {
    db = await setupTestDb();
    service = new VersionService(db);
    
    await service.addVersion('1.0.0', 'Initial release', 'Breaking: Initial API');
    await service.addVersion('2.0.0', 'Major update', 'Breaking: Endpoint changes');
    await service.addMigrationGuide('1.0.0', '2.0.0', 'Update all endpoints with /v2 prefix', 'Endpoints changed from /v1/ to /v2/');
  });

  it('should get versions', async () => {
    const versions = await service.getVersions();
    expect(Array.isArray(versions)).toBe(true);
    expect(versions.length).toBeGreaterThan(0);
  });

  it('should get current version', async () => {
    const version = await service.getCurrentVersion();
    expect(version).toBeDefined();
    expect(version?.version).toBeDefined();
  });

  it('should add version', async () => {
    await service.addVersion('3.0.0', 'New features', 'Breaking: Schema changes');
    const versions = await service.getVersions();
    const v3 = versions.find(v => v.version === '3.0.0');
    expect(v3).toBeDefined();
  });

  it('should get migration guide', async () => {
    const guide = await service.getMigrationGuide('1.0.0', '2.0.0');
    expect(guide).toBeDefined();
    expect(guide?.guide).toBeDefined();
  });

  it('should add migration guide', async () => {
    await service.addMigrationGuide('2.0.0', '3.0.0', 'Update schemas', 'Schema format changed');
    const guide = await service.getMigrationGuide('2.0.0', '3.0.0');
    expect(guide).toBeDefined();
  });

  it('should return null for missing migration guide', async () => {
    const guide = await service.getMigrationGuide('99.0.0', '100.0.0');
    expect(guide).toBeNull();
  });
});
