import { Types } from 'mongoose';
import { env, limits } from '../config/env.js';
import { FileModel, Folder, Settlement, UploadSession, User } from '../models/index.js';
import type { UploadSessionDoc } from '../models/UploadSession.js';
import { AppError, notFound } from '../lib/errors.js';
import { ruleFor, matchesSignature, signatureFor, sanitizeName } from '../lib/fileTypes.js';
import { fileDto } from '../lib/serialize.js';
import { logger } from '../lib/logger.js';
import { withLock } from '../lib/lock.js';
import { resolveDestination } from './folder.service.js';
import { s3Service, newObjectKey } from './s3.service.js';

type Owner = { userId: Types.ObjectId; userIdStr: string };

const OPEN_STATES = ['pending', 'uploading'] as const;

export function planParts(size: number) {
  let partSize = limits.partSize;
  // S3 allows at most 10,000 parts; grow the part size for very large files.
  if (Math.ceil(size / partSize) > limits.maxParts) partSize = Math.ceil(size / limits.maxParts);
  return { partSize, partCount: Math.max(1, Math.ceil(size / partSize)) };
}

/**
 * Reserves quota. A per-user lock serialises reservations, and the write is additionally a
 * compare-and-swap on the counters (it only applies if storageUsed/storageReserved are unchanged
 * since they were read), so concurrent uploads can never jointly exceed the quota, even if a
 * settlement lands in between.
 */
async function reserveQuota(userId: Types.ObjectId, size: number) {
  return withLock(`quota:${String(userId)}`, () => reserveQuotaCas(userId, size), { ttlMs: 15_000, waitMs: 10_000 });
}

async function reserveQuotaCas(userId: Types.ObjectId, size: number) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const user = await User.findOne({ _id: userId, status: 'active' }, { storageQuota: 1, storageUsed: 1, storageReserved: 1 }).lean();
    if (!user) throw new AppError(401, 'UNAUTHENTICATED', 'Account not available');
    const available = user.storageQuota - user.storageUsed - user.storageReserved;
    if (size > available) {
      throw new AppError(413, 'QUOTA_EXCEEDED', 'Not enough storage space for this file', { available: Math.max(0, available) });
    }
    const res = await User.updateOne(
      { _id: userId, storageUsed: user.storageUsed, storageReserved: user.storageReserved },
      { $inc: { storageReserved: size } },
    );
    if (res.modifiedCount === 1) return;
  }
  throw new AppError(409, 'BUSY', 'Too many simultaneous uploads. Please try again.');
}

/**
 * Settles the reservation exactly once. `commit` moves bytes from reserved to used; otherwise the
 * reservation is released. The flag flip and the counter update are separate writes; if the
 * process dies between them, the reconcile job recomputes the counters from metadata.
 */
async function settleReservation(session: UploadSessionDoc, commit: boolean) {
  const size = session.expectedSize;
  try {
    await Settlement.create({ _id: session._id, ownerId: session.ownerId, outcome: commit ? 'committed' : 'released', bytes: size });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return; // already settled
    throw err;
  }
  await UploadSession.updateOne({ _id: session._id }, { $set: { reservationSettled: true } });
  await User.updateOne({ _id: session.ownerId }, { $inc: commit ? { storageReserved: -size, storageUsed: size } : { storageReserved: -size } });
}

async function getOwnedSession(owner: Owner, uploadId: Types.ObjectId) {
  const session = await UploadSession.findOne({ _id: uploadId, ownerId: owner.userId });
  if (!session) throw notFound('Upload');
  return session;
}

function assertOpen(session: UploadSessionDoc) {
  if (session.status === 'cancelled') throw new AppError(409, 'UPLOAD_STATE', 'This upload was cancelled');
  if (session.status === 'failed') throw new AppError(409, 'UPLOAD_STATE', session.failureReason ?? 'This upload failed. Start it again.');
  if (session.expiresAt < new Date() && session.status !== 'completed') {
    throw new AppError(410, 'UPLOAD_EXPIRED', 'This upload session has expired. Start the upload again.');
  }
}

async function completedResult(session: UploadSessionDoc) {
  const file = await FileModel.findById(session.fileId).lean();
  if (!file) throw notFound('File');
  return { status: 'completed' as const, file: fileDto(file) };
}

/** Marks a session failed, releases quota and deletes whatever reached S3. */
async function failSession(session: UploadSessionDoc, reason: string, status: 'failed' | 'cancelled' = 'failed') {
  await UploadSession.updateOne(
    { _id: session._id, status: { $ne: 'completed' } },
    { $set: { status, failureReason: reason, cleanupPending: true, 'verification.reason': reason } },
  );
  await FileModel.updateOne({ _id: session.fileId, uploadStatus: { $ne: 'completed' } }, { $set: { uploadStatus: status } });
  await settleReservation(session, false);
  await cleanupObjects(session);
}

/** Best effort: aborts the multipart upload and deletes the object. Retried by the cleanup job. */
export async function cleanupObjects(session: UploadSessionDoc) {
  try {
    if (session.multipartUploadId) await s3Service.abortMultipart(session.s3Key, session.multipartUploadId);
    await s3Service.deleteObject(session.s3Key);
    await FileModel.deleteOne({ _id: session.fileId, uploadStatus: { $in: ['failed', 'cancelled'] } });
    await UploadSession.updateOne({ _id: session._id }, { $set: { cleanupPending: false } });
  } catch (err) {
    logger.warn({ uploadId: String(session._id), err: (err as Error).message }, 'Upload cleanup deferred');
  }
}

/**
 * Server-side verification. The browser's word is never enough: the object must exist, have
 * exactly the size that was reserved and signed, and start with the signature its type requires.
 */
async function verifyAndFinalize(session: UploadSessionDoc) {
  const claimed = await UploadSession.findOneAndUpdate(
    { _id: session._id, status: { $in: [...OPEN_STATES, 'verifying'] } },
    { $set: { status: 'verifying' } },
    { new: true },
  );
  if (!claimed) {
    const fresh = await UploadSession.findById(session._id);
    if (fresh?.status === 'completed') return completedResult(fresh);
    throw new AppError(409, 'UPLOAD_STATE', 'This upload can no longer be completed');
  }
  await FileModel.updateOne({ _id: session.fileId, uploadStatus: { $ne: 'completed' } }, { $set: { uploadStatus: 'verifying' } });

  const head = await s3Service.head(session.s3Key);
  if (!head) {
    // The object is not there yet (or the PUT failed). Let the client retry the transfer.
    await UploadSession.updateOne({ _id: session._id, status: 'verifying' }, { $set: { status: 'uploading' } });
    await FileModel.updateOne({ _id: session.fileId, uploadStatus: 'verifying' }, { $set: { uploadStatus: 'uploading' } });
    throw new AppError(409, 'UPLOAD_NOT_VERIFIED', 'The file has not reached storage yet. Retry the upload.');
  }
  if (head.size !== session.expectedSize) {
    await failSession(session, `Size mismatch: expected ${session.expectedSize} bytes, storage has ${head.size}`);
    throw new AppError(422, 'UPLOAD_NOT_VERIFIED', 'The uploaded file did not match the expected size. Please upload it again.');
  }
  const ext = session.fileName.includes('.') ? session.fileName.split('.').pop()!.toLowerCase() : '';
  const signature = signatureFor(ext);
  if (signature && session.expectedSize > 0) {
    const bytes = await s3Service.readHead(session.s3Key, signature === 'text' ? 4096 : 64);
    if (!matchesSignature(signature, bytes)) {
      await failSession(session, 'File content does not match its type');
      throw new AppError(422, 'UNSUPPORTED_FILE_TYPE', 'The file content does not match its extension, so it was rejected.');
    }
  }

  // Inherit the parent's state if it changed while the upload was in flight.
  const update: Record<string, unknown> = { uploadStatus: 'completed', size: head.size, etag: head.etag, lastActivityAt: new Date() };
  if (session.parentFolderId) {
    const parent = await Folder.findOne({ _id: session.parentFolderId, ownerId: session.ownerId }).lean();
    if (!parent || parent.purgePending) update.parentFolderId = null;
    else if (parent.deletedAt) Object.assign(update, { deletedAt: parent.deletedAt, trashRootId: parent.trashRootId });
  }
  const file = await FileModel.findOneAndUpdate({ _id: session.fileId }, { $set: update }, { new: true }).lean();
  if (!file) throw new AppError(500, 'INTERNAL', 'Upload record missing');
  await settleReservation(session, true);
  await UploadSession.updateOne(
    { _id: session._id },
    { $set: { status: 'completed', verification: { status: 'verified', verifiedAt: new Date(), actualSize: head.size, etag: head.etag ?? null, reason: null } } },
  );
  return { status: 'completed' as const, file: fileDto(file) };
}

export const uploadService = {
  async initiate(owner: Owner, input: { name: string; size: number; mimeType?: string; parentFolderId: Types.ObjectId | null }) {
    const name = sanitizeName(input.name);
    if (!name) throw new AppError(400, 'VALIDATION_ERROR', 'File name is required');
    const rule = ruleFor(name);
    if (!rule) throw new AppError(415, 'UNSUPPORTED_FILE_TYPE', 'This file type is not allowed', { allowed: 'see /api/uploads/policy' });
    if (input.size > limits.maxFileSize) {
      throw new AppError(413, 'FILE_TOO_LARGE', `Files can be at most ${env.MAX_FILE_SIZE_MB} MB`);
    }
    await resolveDestination(owner.userId, input.parentFolderId);
    await reserveQuota(owner.userId, input.size);

    const uploadId = new Types.ObjectId();
    const fileId = new Types.ObjectId();
    const s3Key = newObjectKey(owner.userIdStr);
    const multipart = input.size > limits.multipartThreshold;
    let multipartUploadId: string | null = null;
    try {
      if (multipart) multipartUploadId = await s3Service.createMultipart(s3Key, rule.mime);
      const plan = multipart ? planParts(input.size) : null;
      const session = await UploadSession.create({
        _id: uploadId,
        ownerId: owner.userId,
        fileId,
        parentFolderId: input.parentFolderId,
        s3Key,
        fileName: name,
        mimeType: rule.mime,
        expectedSize: input.size,
        multipartUploadId,
        partSize: plan?.partSize ?? null,
        partCount: plan?.partCount ?? null,
        status: 'pending',
        expiresAt: new Date(Date.now() + env.UPLOAD_SESSION_TTL_MINUTES * 60_000),
      });
      await FileModel.create({
        _id: fileId,
        ownerId: owner.userId,
        name,
        originalName: name,
        extension: rule.extension,
        mimeType: rule.mime,
        category: rule.category,
        size: input.size,
        s3Key,
        parentFolderId: input.parentFolderId,
        uploadId,
        uploadStatus: 'pending',
      });
      if (multipart) {
        return { uploadId: String(uploadId), fileId: String(fileId), mode: 'multipart' as const, partSize: plan!.partSize, partCount: plan!.partCount, expiresAt: session.expiresAt };
      }
      const url = await s3Service.presignPut(s3Key, rule.mime, input.size);
      return {
        uploadId: String(uploadId),
        fileId: String(fileId),
        mode: 'single' as const,
        url,
        headers: { 'Content-Type': rule.mime },
        urlExpiresInSeconds: env.PRESIGNED_URL_TTL_SECONDS,
        expiresAt: session.expiresAt,
      };
    } catch (err) {
      // Roll back everything created so far, including the quota reservation.
      await User.updateOne({ _id: owner.userId }, { $inc: { storageReserved: -input.size } });
      await UploadSession.deleteOne({ _id: uploadId });
      await FileModel.deleteOne({ _id: fileId });
      if (multipartUploadId) await s3Service.abortMultipart(s3Key, multipartUploadId).catch(() => undefined);
      throw err;
    }
  },

  /** Fresh single-part URL, for retries after a network failure or an expired URL. */
  async refreshUrl(owner: Owner, uploadId: Types.ObjectId) {
    const session = await getOwnedSession(owner, uploadId);
    if (session.status === 'completed') throw new AppError(409, 'UPLOAD_STATE', 'This upload is already complete');
    assertOpen(session);
    if (session.multipartUploadId) throw new AppError(400, 'VALIDATION_ERROR', 'Use part URLs for multipart uploads');
    await UploadSession.updateOne({ _id: session._id, status: 'pending' }, { $set: { status: 'uploading' } });
    const url = await s3Service.presignPut(session.s3Key, session.mimeType, session.expectedSize);
    return { url, headers: { 'Content-Type': session.mimeType }, urlExpiresInSeconds: env.PRESIGNED_URL_TTL_SECONDS };
  },

  async partUrls(owner: Owner, uploadId: Types.ObjectId, partNumbers: number[]) {
    const session = await getOwnedSession(owner, uploadId);
    assertOpen(session);
    if (session.status === 'completed') throw new AppError(409, 'UPLOAD_STATE', 'This upload is already complete');
    if (!session.multipartUploadId || !session.partSize || !session.partCount) {
      throw new AppError(400, 'VALIDATION_ERROR', 'This is not a multipart upload');
    }
    const { partSize, partCount, expectedSize } = session;
    for (const n of partNumbers) {
      if (n < 1 || n > partCount) throw new AppError(400, 'VALIDATION_ERROR', `Part number ${n} is out of range`);
    }
    await UploadSession.updateOne({ _id: session._id, status: 'pending' }, { $set: { status: 'uploading' } });
    await FileModel.updateOne({ _id: session.fileId, uploadStatus: 'pending' }, { $set: { uploadStatus: 'uploading' } });
    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => {
        const length = partNumber === partCount ? expectedSize - partSize * (partCount - 1) : partSize;
        return { partNumber, size: length, url: await s3Service.presignPart(session.s3Key, session.multipartUploadId!, partNumber, length) };
      }),
    );
    return { parts, urlExpiresInSeconds: env.PRESIGNED_URL_TTL_SECONDS };
  },

  async complete(owner: Owner, uploadId: Types.ObjectId) {
    const session = await getOwnedSession(owner, uploadId);
    if (session.status === 'completed') return completedResult(session); // idempotent
    assertOpen(session);
    if (session.multipartUploadId) throw new AppError(400, 'VALIDATION_ERROR', 'Use the multipart completion endpoint');
    return verifyAndFinalize(session);
  },

  /**
   * Completes a multipart upload. The part list comes from S3 (ListParts), and the client's
   * ETags must match it, so a missing or corrupted part cannot be silently accepted.
   */
  async completeMultipart(owner: Owner, uploadId: Types.ObjectId, clientParts: { partNumber: number; etag: string }[]) {
    const session = await getOwnedSession(owner, uploadId);
    if (session.status === 'completed') return completedResult(session);
    assertOpen(session);
    if (!session.multipartUploadId || !session.partCount) throw new AppError(400, 'VALIDATION_ERROR', 'This is not a multipart upload');

    const existing = await s3Service.head(session.s3Key);
    if (!existing) {
      const stored = await s3Service.listParts(session.s3Key, session.multipartUploadId);
      const byNumber = new Map(stored.map((p) => [p.PartNumber, p]));
      const missing: number[] = [];
      for (let n = 1; n <= session.partCount; n++) if (!byNumber.has(n)) missing.push(n);
      if (missing.length) {
        throw new AppError(409, 'UPLOAD_NOT_VERIFIED', 'Some parts have not been uploaded yet', { missingParts: missing.slice(0, 100) });
      }
      const norm = (e: string) => e.replace(/"/g, '');
      for (const cp of clientParts) {
        const sp = byNumber.get(cp.partNumber);
        if (sp && norm(sp.ETag) !== norm(cp.etag)) {
          throw new AppError(409, 'UPLOAD_NOT_VERIFIED', `Part ${cp.partNumber} does not match what storage received. Re-upload it.`, { missingParts: [cp.partNumber] });
        }
      }
      const parts = Array.from({ length: session.partCount }, (_, i) => ({ PartNumber: i + 1, ETag: byNumber.get(i + 1)!.ETag }));
      await s3Service.completeMultipart(session.s3Key, session.multipartUploadId, parts);
    }
    // Either we just completed it, or a previous attempt did and its response was lost.
    return verifyAndFinalize(session);
  },

  async abortMultipart(owner: Owner, uploadId: Types.ObjectId) {
    return this.cancel(owner, uploadId);
  },

  async cancel(owner: Owner, uploadId: Types.ObjectId) {
    const session = await getOwnedSession(owner, uploadId);
    if (session.status === 'completed') throw new AppError(409, 'UPLOAD_STATE', 'This upload already finished. Move the file to Trash instead.');
    if (session.status === 'cancelled' || session.status === 'failed') return { status: session.status };
    await failSession(session, 'Cancelled by user', 'cancelled');
    return { status: 'cancelled' as const };
  },

  async get(owner: Owner, uploadId: Types.ObjectId) {
    const s = await getOwnedSession(owner, uploadId);
    return {
      uploadId: String(s._id),
      fileId: String(s.fileId),
      status: s.status,
      expectedSize: s.expectedSize,
      mode: s.multipartUploadId ? 'multipart' : 'single',
      partSize: s.partSize,
      partCount: s.partCount,
      expiresAt: s.expiresAt,
      failureReason: s.failureReason,
    };
  },
};

export const uploadMaintenance = {
  /**
   * Expires abandoned sessions, retries deferred cleanup, re-runs verification for sessions stuck
   * in "verifying" (S3 succeeded but the metadata update did not), and aborts orphaned multipart
   * uploads that have no session at all.
   */
  async run() {
    const now = new Date();
    let expired = 0;
    let recovered = 0;
    let cleaned = 0;
    let abortedOrphans = 0;

    const stuck = await UploadSession.find({ status: 'verifying', updatedAt: { $lt: new Date(now.getTime() - 5 * 60_000) } }).limit(200);
    for (const s of stuck) {
      try {
        await verifyAndFinalize(s);
        recovered++;
      } catch (err) {
        logger.warn({ uploadId: String(s._id), code: (err as AppError).code }, 'Stuck upload could not be finalised');
      }
    }

    const stale = await UploadSession.find({ status: { $in: OPEN_STATES }, expiresAt: { $lt: now } }).limit(500);
    for (const s of stale) {
      // The object may have landed just before expiry; accept it if it verifies.
      const head = await s3Service.head(s.s3Key).catch(() => null);
      if (head && !s.multipartUploadId) {
        try {
          await verifyAndFinalize(s);
          recovered++;
          continue;
        } catch {
          // fall through to expiry
        }
      }
      await failSession(s, 'Upload expired before it was completed');
      expired++;
    }

    const pending = await UploadSession.find({ cleanupPending: true }).limit(500);
    for (const s of pending) {
      await cleanupObjects(s);
      cleaned++;
    }

    try {
      const orphans = await s3Service.listStaleMultipartUploads('users/', new Date(now.getTime() - 24 * 3600_000));
      for (const o of orphans) {
        const known = await UploadSession.exists({ multipartUploadId: o.uploadId, status: { $in: OPEN_STATES } });
        if (!known) {
          await s3Service.abortMultipart(o.key, o.uploadId);
          abortedOrphans++;
        }
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Could not list multipart uploads');
    }

    return { expired, recovered, cleaned, abortedOrphans };
  },
};
