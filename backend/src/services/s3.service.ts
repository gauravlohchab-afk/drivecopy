import {
  S3Client,
  CopyObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  ListObjectsV2Command,
  type S3ServiceException,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export const s3 = new S3Client({
  region: env.AWS_REGION,
  endpoint: env.AWS_S3_ENDPOINT,
  forcePathStyle: env.AWS_S3_FORCE_PATH_STYLE,
  // Explicit keys are optional; without them the SDK uses the default provider chain,
  // which picks up IAM roles (ECS/EC2/Lambda), SSO and web identity tokens.
  credentials:
    env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
      : undefined,
  maxAttempts: 3,
});

const Bucket = env.AWS_S3_BUCKET;

/** Activity logs live under their own prefix, separate from user files (users/). */
export const ACTIVITY_PREFIX = 'activity-logs/';
const ttl = env.PRESIGNED_URL_TTL_SECONDS;

// Characters AWS advises against in keys, plus path separators and control characters.
// eslint-disable-next-line no-control-regex
const UNSAFE_KEY_CHARS = /[\u0000-\u001f\u007f/\\{}^%`[\]"<>~#|?*:]/g;
const MAX_KEY_NAME_BYTES = 200;

function trimToBytes(text: string, max: number) {
  let out = text;
  while (Buffer.byteLength(out) > max) out = [...out].slice(0, -1).join('');
  return out;
}

/**
 * users/<ownerId>/<file name>, readable in the S3 console. The name is cleaned first, so it cannot
 * leave the owner's prefix. attempt > 0 gives "report (1).pdf", because different files can share a
 * name; choosing a free attempt is up to the caller. The key is fixed once the upload starts.
 */
export function objectKeyFor(ownerId: string, fileName: string, attempt = 0): string {
  if (!/^[a-f\d]{24}$/i.test(ownerId)) throw new Error('Invalid owner id for object key');
  const clean = fileName.normalize('NFC').replace(UNSAFE_KEY_CHARS, '_').replace(/\.{2,}/g, '.').replace(/\s+/g, ' ').trim();
  const dot = clean.lastIndexOf('.');
  const ext = dot > 0 ? clean.slice(dot) : '';
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const suffix = attempt > 0 ? ` (${attempt})` : '';
  const room = MAX_KEY_NAME_BYTES - Buffer.byteLength(suffix) - Buffer.byteLength(ext);
  const safeStem = trimToBytes(stem, room).replace(/^\.+/, '').trim() || 'file';
  return `users/${ownerId}/${safeStem}${suffix}${ext}`;
}

export function isNotFound(err: unknown): boolean {
  const e = err as Partial<S3ServiceException> & { Code?: string };
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.name === 'NoSuchUpload' || e?.$metadata?.httpStatusCode === 404;
}

function storageError(op: string, err: unknown): AppError {
  const e = err as Partial<S3ServiceException>;
  logger.error({ op, errName: e?.name, status: e?.$metadata?.httpStatusCode, requestId: e?.$metadata?.requestId }, 'S3 operation failed');
  // s3Error names the cause (e.g. AccessDenied) for callers that report it; clients never see it.
  return Object.assign(new AppError(503, 'STORAGE_UNAVAILABLE', 'File storage is temporarily unavailable. Please try again.'), { s3Error: e?.name });
}

async function wrap<T>(op: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw storageError(op, err);
  }
}

/** RFC 6266 / RFC 5987 Content-Disposition with an ASCII fallback. */
export function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_');
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export const s3Service = {
  /** Single-request upload. Content-Type and Content-Length are part of the signature. */
  presignPut(key: string, contentType: string, contentLength: number) {
    const cmd = new PutObjectCommand({ Bucket, Key: key, ContentType: contentType, ContentLength: contentLength });
    return wrap('presignPut', () =>
      getSignedUrl(s3, cmd, { expiresIn: ttl, signableHeaders: new Set(['content-type', 'content-length']) }),
    );
  },

  presignGet(key: string, opts: { disposition: 'inline' | 'attachment'; filename: string; contentType: string }) {
    const cmd = new GetObjectCommand({
      Bucket,
      Key: key,
      ResponseContentDisposition: contentDisposition(opts.disposition, opts.filename),
      ResponseContentType: opts.contentType,
      ResponseCacheControl: 'private, max-age=300',
    });
    return wrap('presignGet', () => getSignedUrl(s3, cmd, { expiresIn: ttl }));
  },

  async createMultipart(key: string, contentType: string): Promise<string> {
    const out = await wrap('createMultipart', () =>
      s3.send(new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: contentType })),
    );
    if (!out.UploadId) throw storageError('createMultipart', new Error('Missing UploadId'));
    return out.UploadId;
  },

  presignPart(key: string, uploadId: string, partNumber: number, contentLength: number) {
    const cmd = new UploadPartCommand({ Bucket, Key: key, UploadId: uploadId, PartNumber: partNumber, ContentLength: contentLength });
    return wrap('presignPart', () =>
      getSignedUrl(s3, cmd, { expiresIn: ttl, signableHeaders: new Set(['content-length']) }),
    );
  },

  /** Lists parts S3 actually holds, so completion never trusts browser-reported ETags alone. */
  async listParts(key: string, uploadId: string) {
    const parts: { PartNumber: number; ETag: string; Size: number }[] = [];
    let marker: string | undefined;
    do {
      const out = await wrap('listParts', () =>
        s3.send(new ListPartsCommand({ Bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker })),
      );
      for (const p of out.Parts ?? []) {
        if (p.PartNumber && p.ETag) parts.push({ PartNumber: p.PartNumber, ETag: p.ETag, Size: p.Size ?? 0 });
      }
      marker = out.IsTruncated ? out.NextPartNumberMarker : undefined;
    } while (marker);
    return parts;
  },

  async completeMultipart(key: string, uploadId: string, parts: { PartNumber: number; ETag: string }[]) {
    return wrap('completeMultipart', () =>
      s3.send(new CompleteMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts } })),
    );
  },

  /** Aborting an upload that no longer exists is treated as success (idempotent). */
  async abortMultipart(key: string, uploadId: string) {
    try {
      await s3.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId }));
    } catch (err) {
      if (!isNotFound(err)) throw storageError('abortMultipart', err);
    }
  },

  /** Returns null when the object does not exist. */
  async head(key: string): Promise<{ size: number; etag?: string; contentType?: string } | null> {
    try {
      const out = await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
      return { size: out.ContentLength ?? -1, etag: out.ETag, contentType: out.ContentType };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw storageError('head', err);
    }
  },

  /** Copies within the bucket, keeping content type and metadata. False if the target already exists. */
  async copyObject(from: string, to: string): Promise<boolean> {
    const CopySource = `${Bucket}/${from.split('/').map(encodeURIComponent).join('/')}`;
    try {
      await s3.send(new CopyObjectCommand({ Bucket, Key: to, CopySource, IfNoneMatch: '*' }));
      return true;
    } catch (err) {
      if ((err as Partial<S3ServiceException>)?.$metadata?.httpStatusCode === 412) return false;
      throw storageError('copyObject', err);
    }
  },

  async sha256(key: string): Promise<string> {
    const out = await wrap('sha256', () => s3.send(new GetObjectCommand({ Bucket, Key: key })));
    const hash = createHash('sha256');
    await wrap('sha256Body', async () => {
      for await (const chunk of out.Body as AsyncIterable<Uint8Array>) hash.update(chunk);
    });
    return hash.digest('hex');
  },

  /** Reads only the first bytes of an object (for signature checks). */
  async readHead(key: string, length = 64): Promise<Uint8Array> {
    const out = await wrap('readHead', () => s3.send(new GetObjectCommand({ Bucket, Key: key, Range: `bytes=0-${length - 1}` })));
    if (!out.Body) return new Uint8Array();
    return wrap('readHeadBody', () => out.Body!.transformToByteArray());
  },

  /** Deleting a missing object is a success in S3; errors are surfaced, never swallowed. */
  async deleteObject(key: string) {
    await wrap('deleteObject', () => s3.send(new DeleteObjectCommand({ Bucket, Key: key })));
  },

  /** Batch delete. Returns the keys that S3 reported as failed so callers can retry them. */
  async deleteObjects(keys: string[]): Promise<{ failed: string[] }> {
    const failed: string[] = [];
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      try {
        const out = await s3.send(
          new DeleteObjectsCommand({ Bucket, Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true } }),
        );
        for (const e of out.Errors ?? []) if (e.Key) failed.push(e.Key);
      } catch (err) {
        storageError('deleteObjects', err);
        failed.push(...chunk);
      }
    }
    return { failed };
  },

  async listStaleMultipartUploads(prefix: string, olderThan: Date) {
    const stale: { key: string; uploadId: string }[] = [];
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    do {
      const out = await wrap('listMultipart', () =>
        s3.send(new ListMultipartUploadsCommand({ Bucket, Prefix: prefix, KeyMarker: keyMarker, UploadIdMarker: uploadIdMarker })),
      );
      for (const u of out.Uploads ?? []) {
        if (u.Key && u.UploadId && u.Initiated && u.Initiated < olderThan) stale.push({ key: u.Key, uploadId: u.UploadId });
      }
      keyMarker = out.IsTruncated ? out.NextKeyMarker : undefined;
      uploadIdMarker = out.IsTruncated ? out.NextUploadIdMarker : undefined;
    } while (keyMarker);
    return stale;
  },

  /**
   * Writes a new activity log object. If-None-Match makes it impossible to overwrite an existing
   * log, even with a repeated key. Returns false when the key already exists.
   */
  async putActivityLog(key: string, body: string): Promise<boolean> {
    if (!key.startsWith(ACTIVITY_PREFIX)) throw new Error('Activity logs must stay under their own prefix');
    try {
      await s3.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: 'application/x-ndjson', IfNoneMatch: '*' }));
      return true;
    } catch (err) {
      if ((err as Partial<S3ServiceException>)?.$metadata?.httpStatusCode === 412) return false;
      throw storageError('putActivityLog', err);
    }
  },

  async readText(key: string): Promise<string> {
    const out = await wrap('readText', () => s3.send(new GetObjectCommand({ Bucket, Key: key })));
    if (!out.Body) return '';
    return wrap('readTextBody', () => out.Body!.transformToString('utf-8'));
  },

  /** The "folders" directly under a prefix, e.g. activity-logs/2026/ under activity-logs/. */
  async listPrefixes(prefix: string): Promise<string[]> {
    const found: string[] = [];
    let token: string | undefined;
    do {
      const out = await wrap('listPrefixes', () =>
        s3.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, Delimiter: '/', ContinuationToken: token })),
      );
      for (const p of out.CommonPrefixes ?? []) if (p.Prefix) found.push(p.Prefix);
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
    return found;
  },

  async *listObjects(prefix: string) {
    let token: string | undefined;
    do {
      const out = await wrap('listObjects', () =>
        s3.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token })),
      );
      for (const o of out.Contents ?? []) if (o.Key) yield { key: o.Key, size: o.Size ?? 0, lastModified: o.LastModified };
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
  },
};
