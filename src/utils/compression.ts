/**
 * Tier 5: LZ4-inspired context compression
 * Simple dictionary-based compression for JSON context data
 */

const HEADER = 'MRW1';

/**
 * Compress string data using simple LZ77-style back-references
 */
export function compress(input: string): string {
  if (!input || input.length < 32) return input;

  const tokens: Array<{ type: 'lit'; char: string } | { type: 'ref'; offset: number; length: number }> = [];

  let i = 0;
  while (i < input.length) {
    let bestOffset = 0;
    let bestLength = 0;

    // Search window (up to 32KB back)
    const searchStart = Math.max(0, i - 32768);
    for (let j = searchStart; j < i; j++) {
      let matchLen = 0;
      while (matchLen < 255 && i + matchLen < input.length && input[j + matchLen] === input[i + matchLen]) {
        matchLen++;
      }
      if (matchLen > bestLength && matchLen >= 4) {
        bestOffset = i - j;
        bestLength = matchLen;
      }
    }

    if (bestLength >= 4) {
      tokens.push({ type: 'ref', offset: bestOffset, length: bestLength });
      i += bestLength;
    } else {
      tokens.push({ type: 'lit', char: input[i] });
      i++;
    }
  }

  // Encode tokens
  const parts: string[] = [HEADER];
  for (const token of tokens) {
    if (token.type === 'lit') {
      parts.push('\x01' + token.char);
    } else {
      parts.push(
        '\x00' +
        String.fromCharCode((token.offset >> 8) & 0xff) +
        String.fromCharCode(token.offset & 0xff) +
        String.fromCharCode(token.length)
      );
    }
  }
  return parts.join('');
}

/**
 * Decompress data
 */
export function decompress(input: string): string {
  if (!input.startsWith(HEADER)) return input;

  const data = input.slice(HEADER.length);
  const output: string[] = [];
  let i = 0;

  while (i < data.length) {
    const type = data.charCodeAt(i);
    i++;

    if (type === 0 && i + 2 < data.length) {
      const offsetHi = data.charCodeAt(i++);
      const offsetLo = data.charCodeAt(i++);
      const len = data.charCodeAt(i++);
      const offset = (offsetHi << 8) | offsetLo;
      const pos = output.length - offset;
      for (let j = 0; j < len; j++) {
        output.push(output[pos + j] || '');
      }
    } else if (type === 1 && i < data.length) {
      output.push(data[i++]);
    } else {
      break;
    }
  }

  return output.join('');
}

/**
 * Get compression stats
 */
export function compressionStats(original: string, compressed: string) {
  const origSize = new TextEncoder().encode(original).length;
  const compSize = new TextEncoder().encode(compressed).length;
  return {
    original_size: origSize,
    compressed_size: compSize,
    ratio: origSize > 0 ? compSize / origSize : 1,
    savings_percent: origSize > 0 ? Math.round(((origSize - compSize) / origSize) * 10000) / 100 : 0,
  };
}
