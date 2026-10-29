import { describe, it, expect } from 'vitest';
import { ruleFor, matchesSignature, sanitizeName, extensionOf, inlinePreviewAllowed } from '../../src/lib/fileTypes.js';

describe('file type policy', () => {
  it('derives type from an allow-list, never from the browser', () => {
    expect(ruleFor('Report.PDF')).toMatchObject({ mime: 'application/pdf', category: 'pdf', extension: 'pdf' });
    expect(ruleFor('clip.mov')?.category).toBe('video');
    for (const bad of ['a.exe', 'a.html', 'a.svg', 'a.js', 'a.sh', 'noext', '.bashrc', 'trailing.']) expect(ruleFor(bad)).toBeNull();
  });

  it('extracts extensions safely', () => {
    expect(extensionOf('archive.tar.gz')).toBe('gz');
    expect(extensionOf('.hidden')).toBe('');
  });

  it('checks magic numbers', () => {
    expect(matchesSignature('pdf', Buffer.from('%PDF-1.4'))).toBe(true);
    expect(matchesSignature('pdf', Buffer.from('MZ\x90\x00'))).toBe(false);
    expect(matchesSignature('png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    expect(matchesSignature('jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(matchesSignature('iso-bmff', Buffer.from('\0\0\0\x18ftypmp42', 'latin1'))).toBe(true);
    expect(matchesSignature('ebml', Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))).toBe(true);
    expect(matchesSignature('zip', Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    expect(matchesSignature('text', Buffer.from('hello world'))).toBe(true);
    expect(matchesSignature('text', Buffer.from([0x68, 0x00, 0x69]))).toBe(false);
    expect(matchesSignature('mp3', Buffer.from('ID3\x04'))).toBe(true);
  });

  it('sanitises display names (no separators or control characters)', () => {
    expect(sanitizeName('../../etc/passwd')).toBe('....etcpasswd');
    expect(sanitizeName('a\u0000b\nc')).toBe('abc');
    expect(sanitizeName('  spaced   out  ')).toBe('spaced out');
    expect(sanitizeName('x'.repeat(400))).toHaveLength(255);
  });

  it('only previews safe inline types', () => {
    expect(inlinePreviewAllowed('application/pdf')).toBe(true);
    expect(inlinePreviewAllowed('image/svg+xml')).toBe(false);
    expect(inlinePreviewAllowed('application/zip')).toBe(false);
  });
});
