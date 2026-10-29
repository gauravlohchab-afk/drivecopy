import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, HeadObjectCommand, DeleteObjectsCommand, AbortMultipartUploadCommand } from '@aws-sdk/client-s3';
import { s3Service, newObjectKey, contentDisposition } from '../../src/services/s3.service.js';
import { planParts } from '../../src/services/upload.service.js';

const mock = mockClient(S3Client);
beforeEach(() => mock.reset());

describe('S3 service', () => {
  it('generates opaque, owner-scoped keys and refuses bad owner ids', () => {
    const key = newObjectKey('a'.repeat(24));
    expect(key).toMatch(/^users\/a{24}\/[0-9a-f-]{36}$/);
    expect(() => newObjectKey('../x')).toThrow();
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
