import { mockClient } from 'aws-sdk-client-mock';
import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  CreateMultipartUploadCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { createHash, randomUUID } from 'node:crypto';

const notFound = () => Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
const etagOf = (b: Uint8Array) => `"${createHash('md5').update(b).digest('hex')}"`;

/**
 * In-memory stand-in for an S3 bucket. Tests write bytes with `putObject`/`putPart` to simulate
 * the browser's direct upload, then exercise the API. `failNext` injects storage outages.
 */
export function createFakeS3() {
  const objects = new Map<string, { body: Uint8Array; lastModified: Date }>();
  const multipart = new Map<string, { key: string; parts: Map<number, Uint8Array>; initiated: Date }>();
  const failing = new Set<string>();
  const deleteFailures = new Set<string>();
  const mock = mockClient(S3Client);

  const guard = (op: string) => {
    if (failing.has(op) || failing.has('*')) throw Object.assign(new Error('ServiceUnavailable'), { name: 'ServiceUnavailable', $metadata: { httpStatusCode: 503 } });
  };

  mock.on(HeadObjectCommand).callsFake((input) => {
    guard('HeadObject');
    const o = objects.get(input.Key);
    if (!o) throw notFound();
    return { ContentLength: o.body.byteLength, ETag: etagOf(o.body) };
  });
  mock.on(GetObjectCommand).callsFake((input) => {
    guard('GetObject');
    const o = objects.get(input.Key);
    if (!o) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
    let body = o.body;
    const m = /bytes=(\d+)-(\d+)/.exec(input.Range ?? '');
    if (m) body = body.slice(Number(m[1]), Number(m[2]) + 1);
    return { Body: { transformToByteArray: async () => body } };
  });
  mock.on(PutObjectCommand).callsFake(() => {
    throw new Error('Server must never proxy uploads through PutObject');
  });
  mock.on(DeleteObjectCommand).callsFake((input) => {
    guard('DeleteObject');
    objects.delete(input.Key);
    return {};
  });
  mock.on(DeleteObjectsCommand).callsFake((input) => {
    guard('DeleteObjects');
    const Errors: { Key: string; Code: string }[] = [];
    for (const o of input.Delete.Objects) {
      if (deleteFailures.has(o.Key)) Errors.push({ Key: o.Key, Code: 'InternalError' });
      else objects.delete(o.Key);
    }
    return { Errors };
  });
  mock.on(CreateMultipartUploadCommand).callsFake((input) => {
    guard('CreateMultipartUpload');
    const UploadId = randomUUID();
    multipart.set(UploadId, { key: input.Key, parts: new Map(), initiated: new Date() });
    return { UploadId };
  });
  mock.on(ListPartsCommand).callsFake((input) => {
    guard('ListParts');
    const mp = multipart.get(input.UploadId);
    if (!mp) throw Object.assign(new Error('NoSuchUpload'), { name: 'NoSuchUpload', $metadata: { httpStatusCode: 404 } });
    return {
      Parts: [...mp.parts.entries()].sort((a, b) => a[0] - b[0]).map(([PartNumber, b]) => ({ PartNumber, ETag: etagOf(b), Size: b.byteLength })),
      IsTruncated: false,
    };
  });
  mock.on(CompleteMultipartUploadCommand).callsFake((input) => {
    guard('CompleteMultipartUpload');
    const mp = multipart.get(input.UploadId);
    if (!mp) throw Object.assign(new Error('NoSuchUpload'), { name: 'NoSuchUpload', $metadata: { httpStatusCode: 404 } });
    const chunks = input.MultipartUpload.Parts.map((p: { PartNumber: number; ETag: string }) => {
      const b = mp.parts.get(p.PartNumber);
      if (!b || etagOf(b) !== p.ETag) throw Object.assign(new Error('InvalidPart'), { name: 'InvalidPart', $metadata: { httpStatusCode: 400 } });
      return b;
    });
    objects.set(mp.key, { body: Buffer.concat(chunks), lastModified: new Date() });
    multipart.delete(input.UploadId);
    return { ETag: '"multipart-etag"' };
  });
  mock.on(AbortMultipartUploadCommand).callsFake((input) => {
    guard('AbortMultipartUpload');
    if (!multipart.delete(input.UploadId)) throw Object.assign(new Error('NoSuchUpload'), { name: 'NoSuchUpload', $metadata: { httpStatusCode: 404 } });
    return {};
  });
  mock.on(ListMultipartUploadsCommand).callsFake(() => ({
    Uploads: [...multipart.entries()].map(([UploadId, mp]) => ({ UploadId, Key: mp.key, Initiated: mp.initiated })),
    IsTruncated: false,
  }));
  mock.on(ListObjectsV2Command).callsFake(() => ({
    Contents: [...objects.entries()].map(([Key, o]) => ({ Key, Size: o.body.byteLength, LastModified: o.lastModified })),
    IsTruncated: false,
  }));

  return {
    mock,
    objects,
    multipart,
    putObject(key: string, body: Uint8Array) {
      objects.set(key, { body, lastModified: new Date() });
    },
    putPart(uploadId: string, partNumber: number, body: Uint8Array) {
      const mp = multipart.get(uploadId);
      if (!mp) throw new Error('unknown multipart upload');
      mp.parts.set(partNumber, body);
      return etagOf(body);
    },
    failNext(op: string) {
      failing.add(op);
    },
    failDeleteFor(key: string) {
      deleteFailures.add(key);
    },
    heal() {
      failing.clear();
      deleteFailures.clear();
    },
    reset() {
      objects.clear();
      multipart.clear();
      failing.clear();
      deleteFailures.clear();
    },
  };
}
