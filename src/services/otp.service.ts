/**
 * OTP Service — Email verification for API key signup
 */
import { now } from '../utils/crypto';

/**
 * Hash OTP before storage — never store plaintext (H3 fix)
 */
async function hashOtp(otp: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`marrow-otp:${otp}`);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Constant-time string compare via HMAC (M4 fix — prevents timing attacks on OTP comparison)
 */
async function timingSafeCompare(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  const aKey = await crypto.subtle.importKey('raw', aBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bKey = await crypto.subtle.importKey('raw', bBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const msg = encoder.encode('marrow-otp-compare');
  const aHmac = await crypto.subtle.sign('HMAC', aKey, msg);
  const bHmac = await crypto.subtle.sign('HMAC', bKey, msg);
  const aHex = Array.from(new Uint8Array(aHmac)).map(b => b.toString(16).padStart(2, '0')).join('');
  const bHex = Array.from(new Uint8Array(bHmac)).map(b => b.toString(16).padStart(2, '0')).join('');
  return aHex === bHex;
}

export class OtpService {
  constructor(private db: D1Database) {}

  /**
   * Generate a 6-digit OTP using Web Crypto API (not Math.random)
   */
  generateOtp(): string {
    const arr = new Uint8Array(4);
    crypto.getRandomValues(arr);
    const val = (arr[0] << 24 | arr[1] << 16 | arr[2] << 8 | arr[3]) >>> 0;
    return String(val % 1000000).padStart(6, '0');
  }

  /**
   * Store OTP in D1, replacing any existing one for this email.
   * OTP is hashed before storage (H3 fix — never store plaintext).
   */
  async storeOtp(email: string, otp: string): Promise<void> {
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const hashedOtp = await hashOtp(otp);

    // H2 fix: DDL removed from hot path — table created via migration only
    // M6 fix: Clean up expired OTPs for this email before inserting
    await this.db
      .prepare('DELETE FROM email_otps WHERE email = ? AND expires_at < datetime(\'now\')')
      .bind(email)
      .run();

    await this.db
      .prepare(`
        INSERT INTO email_otps (email, otp, expires_at, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(email) DO UPDATE SET otp = excluded.otp, expires_at = excluded.expires_at, created_at = excluded.created_at
      `)
      .bind(email, hashedOtp, expiresAt, now())
      .run();
  }

  /**
   * Verify OTP — returns true if valid + not expired, deletes on success.
   * Uses hashed comparison + constant-time compare (H3 + M4 fix).
   */
  async verifyOtp(email: string, otp: string): Promise<boolean> {
    const row = await this.db
      .prepare('SELECT otp, expires_at FROM email_otps WHERE email = ?')
      .bind(email)
      .first<{ otp: string; expires_at: string }>();

    if (!row) return false;

    // Hash the incoming OTP and compare against stored hash (constant-time)
    const hashedOtp = await hashOtp(otp);
    const match = await timingSafeCompare(row.otp, hashedOtp);
    if (!match) return false;

    if (new Date(row.expires_at) < new Date()) {
      // Expired — clean up
      await this.db.prepare('DELETE FROM email_otps WHERE email = ?').bind(email).run();
      return false;
    }

    // Valid — delete OTP (one-time use)
    await this.db.prepare('DELETE FROM email_otps WHERE email = ?').bind(email).run();
    return true;
  }
}
