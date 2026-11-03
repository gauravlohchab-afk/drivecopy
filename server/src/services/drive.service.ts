import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { FileModel, Folder, SharedDrive, User, type DriveRole } from '../models/index.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { limits } from '../config/env.js';
import { storageService } from './storage.service.js';

type Owner = { userId: Types.ObjectId; userIdStr: string };

const MAX_MEMBERS = 200;
const MAX_DRIVES_CREATED = 50;

export const ROLE_RANK: Record<DriveRole, number> = { viewer: 0, content_manager: 1, manager: 2 };

type DriveLean = {
  _id: Types.ObjectId;
  name: string;
  principalId: Types.ObjectId;
  members: { userId: Types.ObjectId; role: string; hidden?: boolean; addedAt?: Date }[];
  createdAt: Date;
};

const memberOf = (d: DriveLean, userId: Types.ObjectId) => d.members.find((m) => m.userId.equals(userId));

function summary(d: DriveLean, userId: Types.ObjectId) {
  const me = memberOf(d, userId)!;
  return {
    id: String(d._id),
    name: d.name,
    role: me.role as DriveRole,
    hidden: Boolean(me.hidden),
    memberCount: d.members.length,
    createdAt: d.createdAt.toISOString(),
  };
}

async function load(user: Owner, driveId: Types.ObjectId) {
  const d = (await SharedDrive.findOne({ _id: driveId, 'members.userId': user.userId }).lean()) as DriveLean | null;
  // Non-members get the same 404 as a drive that doesn't exist.
  if (!d) throw notFound('Shared drive');
  return d;
}

function requireRole(d: DriveLean, user: Owner, needed: DriveRole) {
  const me = memberOf(d, user.userId)!;
  if (ROLE_RANK[me.role as DriveRole] < ROLE_RANK[needed]) {
    throw new AppError(403, 'FORBIDDEN', needed === 'manager' ? 'Only managers of this shared drive can do that' : 'You have view-only access to this shared drive');
  }
  return me.role as DriveRole;
}

/** A drive must always keep at least one manager. */
function assertManagerRemains(members: { role: string }[]) {
  if (!members.some((m) => m.role === 'manager')) throw badRequest('A shared drive needs at least one manager');
}

export const driveService = {
  async list(user: Owner) {
    const drives = (await SharedDrive.find({ 'members.userId': user.userId }).lean()) as DriveLean[];
    return drives.sort((a, b) => a.name.localeCompare(b.name)).map((d) => summary(d, user.userId));
  },

  async create(user: Owner, name: string) {
    if ((await SharedDrive.countDocuments({ createdBy: user.userId })) >= MAX_DRIVES_CREATED) {
      throw badRequest(`You can create up to ${MAX_DRIVES_CREATED} shared drives`);
    }
    // The drive's owning principal: it cannot sign in (no usable password, kind "drive").
    const principalId = new Types.ObjectId();
    await User.create({
      _id: principalId,
      kind: 'drive',
      name,
      email: `drive-${principalId}@shared-drive.invalid`,
      passwordHash: `!disabled:${randomBytes(16).toString('hex')}`,
      storageQuota: limits.defaultQuota,
    });
    const d = await SharedDrive.create({ name, principalId, createdBy: user.userId, members: [{ userId: user.userId, role: 'manager' }] });
    return summary(d.toObject() as DriveLean, user.userId);
  },

  async get(user: Owner, driveId: Types.ObjectId) {
    const d = await load(user, driveId);
    return { ...summary(d, user.userId), usage: await storageService.usage(d.principalId) };
  },

  async rename(user: Owner, driveId: Types.ObjectId, name: string) {
    const d = await load(user, driveId);
    requireRole(d, user, 'manager');
    await SharedDrive.updateOne({ _id: driveId }, { $set: { name } });
    await User.updateOne({ _id: d.principalId }, { $set: { name } });
    return summary({ ...d, name }, user.userId);
  },

  async setHidden(user: Owner, driveId: Types.ObjectId, hidden: boolean) {
    await load(user, driveId);
    await SharedDrive.updateOne({ _id: driveId, 'members.userId': user.userId }, { $set: { 'members.$.hidden': hidden } });
    return summary((await load(user, driveId)), user.userId);
  },

  /** Like Drive, a shared drive can only be deleted once it is empty (Trash included). */
  async remove(user: Owner, driveId: Types.ObjectId) {
    const d = await load(user, driveId);
    requireRole(d, user, 'manager');
    const hasContent = (await FileModel.exists({ ownerId: d.principalId })) || (await Folder.exists({ ownerId: d.principalId }));
    if (hasContent) throw new AppError(409, 'CONFLICT', 'Delete everything in this shared drive (including its Trash) before deleting the drive');
    await SharedDrive.deleteOne({ _id: driveId });
    await User.deleteOne({ _id: d.principalId, kind: 'drive' });
    return { deleted: true };
  },

  async members(user: Owner, driveId: Types.ObjectId) {
    const d = await load(user, driveId);
    const users = await User.find({ _id: { $in: d.members.map((m) => m.userId) } }, { name: 1, email: 1 }).lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    return d.members
      .filter((m) => byId.has(String(m.userId)))
      .map((m) => ({ userId: String(m.userId), name: byId.get(String(m.userId))!.name, email: byId.get(String(m.userId))!.email, role: m.role as DriveRole, isYou: m.userId.equals(user.userId) }))
      .sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role] || a.name.localeCompare(b.name));
  },

  async addMember(user: Owner, driveId: Types.ObjectId, email: string, role: DriveRole) {
    const d = await load(user, driveId);
    requireRole(d, user, 'manager');
    const person = await User.findOne({ email, status: 'active', kind: { $ne: 'drive' } }, { _id: 1 }).lean();
    if (!person) throw new AppError(404, 'NOT_FOUND', 'No Cirrus account uses that email address');
    if (memberOf(d, person._id)) throw new AppError(409, 'CONFLICT', 'That person is already a member');
    if (d.members.length >= MAX_MEMBERS) throw badRequest(`A shared drive can have up to ${MAX_MEMBERS} members`);
    await SharedDrive.updateOne({ _id: driveId, 'members.userId': { $ne: person._id } }, { $push: { members: { userId: person._id, role } } });
    return this.members(user, driveId);
  },

  async setRole(user: Owner, driveId: Types.ObjectId, memberId: Types.ObjectId, role: DriveRole) {
    const d = await load(user, driveId);
    requireRole(d, user, 'manager');
    if (!memberOf(d, memberId)) throw notFound('Member');
    assertManagerRemains(d.members.map((m) => (m.userId.equals(memberId) ? { role } : m)));
    await SharedDrive.updateOne({ _id: driveId, 'members.userId': memberId }, { $set: { 'members.$.role': role } });
    return this.members(user, driveId);
  },

  /** Managers can remove anyone; any member can remove themselves (leave). */
  async removeMember(user: Owner, driveId: Types.ObjectId, memberId: Types.ObjectId) {
    const d = await load(user, driveId);
    if (!memberId.equals(user.userId)) requireRole(d, user, 'manager');
    if (!memberOf(d, memberId)) throw notFound('Member');
    assertManagerRemains(d.members.filter((m) => !m.userId.equals(memberId)));
    await SharedDrive.updateOne({ _id: driveId }, { $pull: { members: { userId: memberId } } });
    return memberId.equals(user.userId) ? [] : this.members(user, driveId);
  },

  /**
   * Checks membership and role for a request inside a drive, and returns the identity the
   * existing file/folder services act as: the drive's owning principal.
   */
  async enter(user: Owner, driveId: Types.ObjectId, needed: DriveRole) {
    const d = await load(user, driveId);
    const role = requireRole(d, user, needed);
    return { role, principal: { userId: d.principalId, userIdStr: String(d.principalId) } };
  },

  /** Drives the user belongs to, keyed by their owning principal (for search and activity). */
  async memberships(userId: Types.ObjectId) {
    const drives = (await SharedDrive.find({ 'members.userId': userId }).lean()) as DriveLean[];
    return drives.map((d) => ({ driveId: String(d._id), name: d.name, principalId: d.principalId, role: memberOf(d, userId)!.role as DriveRole }));
  },
};
