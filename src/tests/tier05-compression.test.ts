/**
 * Tier 5: LZ4 Context Compression — 12 tests
 */
import { describe, it, expect } from 'vitest';
import { compress, decompress, compressionStats } from '../utils/compression';

describe('Tier 5: LZ4 Context Compression', () => {
  it('compresses and decompresses correctly', () => {
    const original = 'Hello World! '.repeat(100);
    const compressed = compress(original);
    const decompressed = decompress(compressed);
    expect(decompressed).toBe(original);
  });

  it('returns original for short strings', () => {
    const short = 'hello';
    const result = compress(short);
    expect(result).toBe(short);
  });

  it('handles empty string', () => {
    expect(compress('')).toBe('');
    expect(decompress('')).toBe('');
  });

  it('compressed is smaller than original for repetitive data', () => {
    const original = JSON.stringify({ key: 'value', data: 'x'.repeat(500), more: 'y'.repeat(500) });
    const compressed = compress(original);
    expect(compressed.length).toBeLessThan(original.length);
  });

  it('decompresses non-compressed data as-is', () => {
    const plain = 'not compressed data';
    expect(decompress(plain)).toBe(plain);
  });

  it('compression stats are accurate', () => {
    const original = 'A'.repeat(1000);
    const compressed = compress(original);
    const stats = compressionStats(original, compressed);
    expect(stats.original_size).toBe(1000);
    expect(stats.compressed_size).toBeLessThan(1000);
    expect(stats.ratio).toBeLessThan(1);
    expect(stats.savings_percent).toBeGreaterThan(0);
  });

  it('handles JSON context compression', () => {
    const ctx = JSON.stringify({
      market: 'crypto',
      exchange: 'binance',
      pair: 'BTC/USDT',
      data: Array.from({ length: 50 }, (_, i) => ({ price: 50000 + i, volume: 1000 + i })),
    });
    const compressed = compress(ctx);
    const decompressed = decompress(compressed);
    expect(decompressed).toBe(ctx);
  });

  it('handles unicode content', () => {
    const unicode = '日本語テスト '.repeat(50);
    const compressed = compress(unicode);
    const decompressed = decompress(compressed);
    expect(decompressed).toBe(unicode);
  });

  it('handles special characters', () => {
    const special = '!@#$%^&*()_+-=[]{}|;:,.<>? '.repeat(50);
    const compressed = compress(special);
    const decompressed = decompress(compressed);
    expect(decompressed).toBe(special);
  });

  it('compression ratio for realistic context', () => {
    const ctx = JSON.stringify({
      decision_type: 'trading',
      market_conditions: { bull: true, volatility: 'high', volume: 'increasing' },
      historical_data: Array.from({ length: 100 }, (_, i) => ({ day: i, price: 50000 + Math.random() * 1000 })),
    });
    const stats = compressionStats(ctx, compress(ctx));
    expect(stats.original_size).toBeGreaterThan(0);
    expect(stats.ratio).toBeDefined();
  });

  it('handles exactly 32 byte string (boundary)', () => {
    const str = 'A'.repeat(32);
    const compressed = compress(str);
    const decompressed = decompress(compressed);
    expect(decompressed).toBe(str);
  });

  it('idempotent: decompress(compress(x)) = x for various inputs', () => {
    const inputs = [
      'a'.repeat(100),
      'abcdef'.repeat(100),
      JSON.stringify({ nested: { deep: { value: 42 } } }).repeat(10),
    ];
    for (const input of inputs) {
      expect(decompress(compress(input))).toBe(input);
    }
  });
});
