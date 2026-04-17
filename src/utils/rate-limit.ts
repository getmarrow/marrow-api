/**
 * Simple D1-backed rate limiter
 */

export async function checkRateLimit(
  db: D1Database,
  key: string,
  maxRequests: number,
  windowMs: number
): Promise<boolean> {
  const windowStart = new Date(Date.now() - windowMs).toISOString();
  const now = new Date().toISOString();

  // H2 fix: DDL removed from hot path — table created via migration only

  // Count requests in window
  const row = await db
    .prepare('SELECT COUNT(*) as cnt FROM rate_limits WHERE key = ? AND created_at > ?')
    .bind(key, windowStart)
    .first<{ cnt: number }>();

  if ((row?.cnt ?? 0) >= maxRequests) return false;

  // Record this request
  await db
    .prepare('INSERT INTO rate_limits (key, created_at) VALUES (?, ?)')
    .bind(key, now)
    .run();

  // M5 fix: Cleanup old entries — blocking with error logging
  try {
    await db.prepare('DELETE FROM rate_limits WHERE created_at < ?')
      .bind(windowStart)
      .run();
  } catch (e) {
    console.error('[rate-limit] cleanup failed:', e);
  }

  return true;
}
