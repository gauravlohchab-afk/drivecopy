import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, HeadObjectCommand, DeleteObjectsCommand, AbortMultipartUploadCommand } from '@aws-sdk/client-s3';
import { s3Service, objectKeyFor, contentDisposition } from '../../src/services/s3.service.js';
import { planParts } from '../../src/services/upload.service.js';

const mock = mockClient(S3Client);
beforeEach(() => mock.reset());

describe('S3 service', () => {
  describe('object keys', () => {
    const owner = 'a'.repeat(24);
    const key = (name: string, attempt = 0) => objectKeyFor(owner, name, attempt).slice(`users/${owner}/`.length);

    it('uses the file name, under the owner, and refuses bad owner ids', () => {
      expect(key('Master of Business Administration(MBA).pdf')).toBe('Master of Business Administration(MBA).pdf');
      expect(key('résumé 2026.pdf')).toBe('résumé 2026.pdf');
      expect(() => objectKeyFor('../x', 'a.pdf')).toThrow();
    });

    it('numbers repeats before the extension', () => {
      expect(key('report.pdf', 1)).toBe('report (1).pdf');
      expect(key('archive.tar.gz', 2)).toBe('archive.tar (2).gz');
      expect(key('notes', 3)).toBe('notes (3)');
    });

    it('cannot leave the owner prefix, whatever the name', () => {
      for (const name of ['../../other/secret.pdf', '..\\..\\x.pdf', '/etc/passwd', '..', '.', '...pdf']) {
        const k = objectKeyFor(owner, name);
        expect(k.startsWith(`users/${owner}/`)).toBe(true);
        expect(k.slice(`users/${owner}/`.length)).not.toContain('/');
        expect(k).not.toContain('..');
      }
    });

    it('replaces characters that are unsafe in keys', () => {
      expect(key('a#b%c?d{e}[f]<g>|h:i*.pdf')).toBe('a_b_c_d_e__f__g__h_i_.pdf');
      expect(key('new\nline\ttab.pdf')).toBe('new_line_tab.pdf');
    });

    it('fits S3 limits for very long names, keeping the extension', () => {
      for (const name of [`${'x'.repeat(255)}.pdf`, `${'é'.repeat(250)}.pdf`, `${'文'.repeat(250)}.pdf`]) {
        const k = key(name, 12);
        expect(Buffer.byteLength(k)).toBeLessThanOrEqual(200);
        expect(k.endsWith(' (12).pdf')).toBe(true);
      }
    });
  });

  it('returns null for missing objects and maps other failures to a safe 503', async () => {
    mock.on(HeadObjectCommand).rejectsOnce(Object.assign(new Error('nf'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }));
    expect(await s3Service.head('k')).toBeNull();
    mock.on(HeadObjectCommand).rejectsOnce(Object.assign(new Error('AccessDenied for arn:aws:s3:::secret-bucket'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }));
    await expect(s3Service.head('k')).rejects.toMatchObject({ status: 503, code: 'STORAGE_UNAVAILABLE', message: expect.not.stringContaining('arn') });
  });

  it('reports per-key delete failures and whole-batch failures for retry', async () => {
    mock.on(DeleteObjectsCommand).resolvesOnce({ Errors: [{ Key: 'b', Code: 'InternalError' }] });
    expect(await s3Service.deleteObjects(['a', 'b'])).toEqual({ failed: ['b'] });
    mock.on(DeleteObjectsCommand).rejectsOnce(new Error('network'));
    expect(await s3Service.deleteObjects(['c'])).toEqual({ failed: ['c'] });
  });

  it('treats aborting a vanished multipart upload as success', async () => {
    mock.on(AbortMultipartUploadCommand).rejectsOnce(Object.assign(new Error('x'), { name: 'NoSuchUpload', $metadata: { httpStatusCode: 404 } }));
    await expect(s3Service.abortMultipart('k', 'u')).resolves.toBeUndefined();
  });

  it('presigns GET URLs with short expiry and RFC 5987 filenames', async () => {
    const url = new URL(await s3Service.presignGet('users/x/y', { disposition: 'attachment', filename: 'résumé "final".pdf', contentType: 'application/pdf' }));
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('response-content-disposition')).toBe(contentDisposition('attachment', 'résumé "final".pdf'));
    expect(contentDisposition('inline', 'résumé "final".pdf')).toBe(`inline; filename="r_sum_ _final_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22.pdf`);
  });

  it('plans multipart parts within S3 limits', () => {
    const MB = 1024 * 1024;
    expect(planParts(12 * MB)).toEqual({ partSize: 5 * MB, partCount: 3 });
    const huge = planParts(100_000 * MB);
    expect(huge.partCount).toBeLessThanOrEqual(10_000);
    expect(huge.partSize * huge.partCount).toBeGreaterThanOrEqual(100_000 * MB);
  });
});
