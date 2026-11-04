import { FileModel, UploadSession } from '../models/index.js';
import { logger } from '../lib/logger.js';
import { objectKeyFor, s3Service } from './s3.service.js';

const UUID_KEY = /^users\/([a-f\d]{24})\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// S3's limit for a single copy request. Larger objects would need a multipart copy.
const MAX_COPY_BYTES = 5 * 1024 ** 3;
const MAX_NAME_ATTEMPTS = 1000;

export interface RenamedObject {
  fileId: string;
  name: string;
  from: string;
  to: string;
}

export interface RenameResult {
  planned: RenamedObject[];
  renamed: RenamedObject[];
  skipped: { fileId: string; name: string; reason: string }[];
  /** The record points at the new object, but the old object could not be removed. */
  leftovers: string[];
}

async function freeKey(owner: string, name: string, taken: Set<string>) {
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
    const key = objectKeyFor(owner, name, attempt);
    if (taken.has(key)) continue;
    if ((await UploadSession.exists({ s3Key: key })) || (await FileModel.exists({ s3Key: key })) || (await s3Service.head(key))) continue;
    return key;
  }
  throw new Error('No free name');
}

/** An object's ETag is its MD5 unless it was uploaded in parts, and a copy gets a new one then. */
async function sameContent(from: string, to: string, source: { size: number; etag?: string }) {
  const copy = await s3Service.head(to);
  if (!copy || copy.size !== source.size) return false;
  if (source.etag && !source.etag.includes('-')) return copy.etag === source.etag;
  return (await s3Service.sha256(from)) === (await s3Service.sha256(to));
}

/**
 * Gives files stored under a UUID a key based on their current name. The owner's prefix stays as it
 * is. For each file: copy, verify, update the records, report the mapping, and only then delete the
 * original. If anything fails before the records change, the file is untouched and can be retried;
 * files already renamed no longer match, so running this again is safe.
 */
export async function renameUuidObjects(opts: { apply: boolean; limit?: number; onRenamed?: (r: RenamedObject) => void }): Promise<RenameResult> {
  const result: RenameResult = { planned: [], renamed: [], skipped: [], leftovers: [] };
  const files = await FileModel.find({ uploadStatus: 'completed', purgePending: false }, { name: 1, s3Key: 1, uploadId: 1 }).sort({ _id: 1 }).lean();
  const taken = new Set<string>();

  for (const file of files) {
    const match = UUID_KEY.exec(file.s3Key);
    if (!match) continue;
    if (opts.limit !== undefined && result.planned.length >= opts.limit) break;
    const fileId = String(file._id);
    const skip = (reason: string) => result.skipped.push({ fileId, name: file.name, reason });

    const source = await s3Service.head(file.s3Key);
    if (!source) {
      skip('Original object not found');
      continue;
    }
    if (source.size > MAX_COPY_BYTES) {
      skip('Larger than the 5 GB single-copy limit');
      continue;
    }
    const to = await freeKey(match[1]!, file.name, taken);
    taken.add(to);
    const entry = { fileId, name: file.name, from: file.s3Key, to };
    result.planned.push(entry);
    if (!opts.apply) continue;

    try {
      if (!(await s3Service.copyObject(file.s3Key, to))) {
        skip('The new name was taken during the copy');
        continue;
      }
      if (!(await sameContent(file.s3Key, to, source))) {
        await s3Service.deleteObject(to);
        skip('The copy did not match the original');
        continue;
      }
      const updated = await FileModel.updateOne({ _id: file._id, s3Key: file.s3Key, purgePending: false }, { $set: { s3Key: to } }, { timestamps: false });
      if (!updated.modifiedCount) {
        // Deleted or changed while this ran, so the original is no longer this tool's to touch.
        await s3Service.deleteObject(to);
        skip('The file changed during the rename');
        continue;
      }
      await UploadSession.updateOne({ _id: file.uploadId, s3Key: file.s3Key }, { $set: { s3Key: to } }, { timestamps: false });
    } catch (err) {
      logger.warn({ fileId, err: (err as Error).message }, 'Could not rename an object');
      skip((err as { s3Error?: string }).s3Error ?? (err as Error).message);
      continue;
    }

    opts.onRenamed?.(entry);
    result.renamed.push(entry);
    try {
      await s3Service.deleteObject(file.s3Key);
    } catch {
      result.leftovers.push(file.s3Key);
    }
  }
  return result;
}
