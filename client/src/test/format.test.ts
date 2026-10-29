import { describe, it, expect } from 'vitest';
import { formatBytes, extensionOf } from '../lib/format';

describe('format helpers', () => {
  it('formats bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(15 * 1024 ** 3)).toBe('15.0 GB');
  });
  it('extracts extensions', () => {
    expect(extensionOf('a.PDF')).toBe('pdf');
    expect(extensionOf('.env')).toBe('');
    expect(extensionOf('noext')).toBe('');
  });
});
