/**
 * PII Stripping Service — regex-based
 * Strips: names→[PERSON], emails→[EMAIL], amounts→[AMOUNT], phones→[PHONE], orgs→[ORG]
 */

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const AMOUNT_REGEX = /(?:\$|€|£|¥|₹|USD|EUR|GBP|BTC|ETH|USDT)\s?\d[\d,]*\.?\d*/gi;
const AMOUNT_REGEX_2 = /\d[\d,]*\.?\d*\s?(?:dollars?|euros?|pounds?|sats?|btc|eth|usdt)/gi;
// Phone must run AFTER amounts to avoid matching dollar amounts as phone numbers
// Matches: +66812345678, +1-555-123-4567, 08X XXXX XXXX, (555) 123-4567
const PHONE_REGEX = /\+\d{7,15}|\+\d{1,4}[\s.-]\d[\d\s.-]{5,14}\d|\(?\d{2,4}\)?[\s.-]\d{2,4}[\s.-]\d{2,9}|0\d{1,2}[\s.-]?\d{3,4}[\s.-]?\d{3,4}/g;

// Common org suffixes
const ORG_REGEX = /\b[A-Z][A-Za-z0-9&\s]+(?:Inc\.?|LLC|Ltd\.?|Corp\.?|Co\.?|GmbH|Pty|PLC|SA|AG|BV|NV|Pte|Limited)\b/g;

export class PiiService {
  /**
   * Strip PII from a string
   */
  stripString(input: string): string {
    let result = input;
    // Order matters: email first (contains @), then amounts (contains $), then phone (digits only)
    result = result.replace(EMAIL_REGEX, '[EMAIL]');
    result = result.replace(AMOUNT_REGEX, '[AMOUNT]');
    result = result.replace(AMOUNT_REGEX_2, '[AMOUNT]');
    result = result.replace(PHONE_REGEX, '[PHONE]');
    result = result.replace(ORG_REGEX, '[ORG]');
    return result;
  }

  /**
   * Strip PII from an object (deep)
   */
  stripObject(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        result[key] = this.stripString(value);
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = this.stripObject(value as Record<string, unknown>);
      } else if (Array.isArray(value)) {
        result[key] = value.map(v =>
          typeof v === 'string' ? this.stripString(v) :
          v && typeof v === 'object' ? this.stripObject(v as Record<string, unknown>) : v
        );
      } else {
        result[key] = value;
      }
    }
    return result;
  }
}
