import { hash, verify } from '@node-rs/argon2';
import { Types } from 'mongoose';
import { env } from '../config/env.js';
import { FileModel, Folder, Session, Settlement, Share, SharedDrive, UploadSession, User, Workspace } from '../models/index.js';
import { withLock } from '../lib/lock.js';
import { logger } from '../lib/logger.js';
import { storageService } from './storage.service.js';
import { s3LayoutService } from './s3Layout.service.js';

// Argon2id with OWASP-recommended parameters (m=19 MiB, t=2, p=1).
const ARGON_OPTS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/**
 * Finds or creates the admin account. If the configured username is an existing account's email,
 * that account becomes the admin and keeps its files where they are.
 */
async function resolveAdmin() {
  const username = env.ADMIN_LOGIN_USERNAME;
  let admin = await User.findOne({ role: 'admin' }).select('+passwordHash');
  if (!admin) {
    admin = await User.findOne({ email: username, kind: { $ne: 'drive' } }).select('+passwordHash');
    if (admin) {
      admin.role = 'admin';
      admin.status = 'active';
      admin.mergedIntoUserId = null;
    }
  }
  if (!admin) {
    return User.create({
      name: 'Administrator',
      email: username,
      passwordHash: await hash(env.ADMIN_LOGIN_PASSWORD, ARGON_OPTS),
      role: 'admin',
    });
  }
  if (admin.email !== username) {
    if (await User.exists({ email: username, _id: { $ne: admin._id } })) {
      throw new Error('ADMIN_LOGIN_USERNAME is already the email of a former account. Choose a different username.');
    }
    admin.email = username;
    await Session.deleteMany({ userId: admin._id });
    await s3LayoutService.flagAccount(admin._id);
  }
  // Logins compare against the environment. This hash only detects a changed password at startup,
  // so that sessions signed in with the old one stop working.
  const unchanged = await verify(admin.passwordHash, env.ADMIN_LOGIN_PASSWORD).catch(() => false);
  if (!unchanged) {
    admin.passwordHash = await hash(env.ADMIN_LOGIN_PASSWORD, ARGON_OPTS);
    await Session.deleteMany({ userId: admin._id });
  }
  await admin.save();
  return admin;
}

/**
 * Moves everything a former account owned to the admin, under one folder per account. Only metadata
 * changes: each file record keeps its S3 key, so no object is copied, renamed or re-uploaded. Every
 * step can safely run again, so an interrupted migration finishes on the next start.
 */
async function mergeAccount(adminId: Types.ObjectId, account: { _id: Types.ObjectId; email: string }) {
  const ownerId = account._id;
  // Timestamps stay as they were: moving ownership is not a change to the file.
  const quiet = { timestamps: false } as const;
  const hasItems = (await FileModel.exists({ ownerId })) || (await Folder.exists({ ownerId }));
  if (hasItems) {
    let holder = await Folder.findOne({ ownerId: adminId, importedFromUserId: ownerId });
    holder ??= await Folder.create({ ownerId: adminId, name: `Imported from ${account.email}`, parentFolderId: null, importedFromUserId: ownerId });
    const top = { ownerId, parentFolderId: null };
    const into = { $set: { parentFolderId: holder._id } };
    await Folder.updateMany(top, into, quiet);
    await FileModel.updateMany(top, into, quiet);
    await UploadSession.updateMany(top, into, quiet);
  }
  const toAdmin = { $set: { ownerId: adminId } };
  for (const model of [Folder, FileModel, UploadSession, Workspace, Share]) {
    await (model as typeof Folder).updateMany({ ownerId }, toAdmin, quiet);
  }
  await Settlement.updateMany({ ownerId }, toAdmin);
  // A grant to the admin on what the admin now owns would list the item as "shared with" them.
  await Share.deleteMany({ ownerId: adminId, granteeId: adminId });
  await User.updateOne({ _id: ownerId }, { $set: { status: 'disabled', mergedIntoUserId: adminId } });
  await storageService.reconcileUser(ownerId);
  logger.info({ accountId: String(ownerId) }, 'Moved a former account to the administrator');
}

/**
 * Runs at startup, before the API serves anything. Afterwards the admin is the only account that
 * can have a session, and everything stored so far is reachable from it.
 */
export async function ensureAdminAccount() {
  return withLock(
    'job:admin-account',
    async () => {
      const admin = await resolveAdmin();
      const accounts = await User.find({ _id: { $ne: admin._id }, kind: { $ne: 'drive' }, mergedIntoUserId: null }, { email: 1 }).lean();
      for (const account of accounts) await mergeAccount(admin._id, account);
      await SharedDrive.updateMany({ 'members.userId': { $ne: admin._id } }, { $push: { members: { userId: admin._id, role: 'manager' } } });
      await SharedDrive.updateMany({ members: { $elemMatch: { userId: admin._id, role: { $ne: 'manager' } } } }, { $set: { 'members.$.role': 'manager' } });
      if (accounts.length) await storageService.reconcileUser(admin._id);
      await Session.deleteMany({ userId: { $ne: admin._id } });
      return admin;
    },
    { ttlMs: 5 * 60_000, waitMs: 60_000 },
  );
}
