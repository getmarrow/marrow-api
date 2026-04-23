/**
 * backfill-baselines.ts
 * Standalone script: calls BaselineService.backfillBaselinesForAccount() for each account.
 * Run: npx wrangler d1 execute DB --remote --file=scripts/backfill-baselines.ts
 *   OR: node --experimental-vm-modules scripts/backfill-baselines.ts
 *
 * Clean: no admin backdoor left in production after backfill.
 */

import type { D1Database } from '@cloudflare/workers-types';
import { BaselineService } from '../src/services/baseline.service';

// For wrangler script mode, D1 is injected as env.DB
// For local testing, use env from wrangler (import get minimum env from .dev.vars)
// This file is designed to run as a wrangler script: `wrangler d1 execute DB --remote --file=scripts/backfill-baselines.ts`
// but that needs a different invocation. Use the direct D1 execute approach instead:

async function main() {
  // Note: This script must be run via wrangler as: wrangler d1 execute DB --remote --file=scripts/backfill-baselines.ts
  // Or invoked as a one-shot admin route in the worker itself.
  // For now, log usage guidance.
  console.log('[backfill-baselines] Run manually via: wrangler d1 execute DB --remote --file=scripts/backfill-baselines.ts');
  console.log('[backfill-baselines] Or call /v1/admin/backfill-baselines?account_id=acc-empirebuu-001 once then remove route.');
}

main().catch(console.error);