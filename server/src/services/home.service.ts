import type { Types } from 'mongoose';
import { Folder, FileModel } from '../models/index.js';
import { folderDto, fileDto } from '../lib/serialize.js';
import { activeFilter } from './folder.service.js';
import { shareService } from './share.service.js';

type Owner = { userId: Types.ObjectId; userIdStr: string };

const SUGGESTED_FOLDERS = 8;
const SUGGESTED_FILES = 12;

/** Newest first by when the user last touched it (own items) or when it was shared with them. */
function newest<T>(items: { dto: T; at: Date }[], limit: number) {
  return items.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit).map((i) => i.dto);
}

export const homeService = {
  /** Home suggestions: the folders and files the user has been working with, plus recent shares. */
  async suggestions(user: Owner) {
    const [folders, files, shared] = await Promise.all([
      Folder.find(activeFilter(user.userId)).sort({ lastActivityAt: -1, _id: -1 }).limit(SUGGESTED_FOLDERS).lean(),
      FileModel.find({ ...activeFilter(user.userId), uploadStatus: 'completed' }).sort({ lastActivityAt: -1, _id: -1 }).limit(SUGGESTED_FILES).lean(),
      shareService.sharedWithMe(user),
    ]);
    return {
      folders: newest(
        [
          ...folders.map((f) => ({ dto: folderDto(f), at: f.lastActivityAt })),
          ...shared.folders.slice(0, SUGGESTED_FOLDERS).map((f) => ({ dto: f, at: new Date(f.sharedAt) })),
        ],
        SUGGESTED_FOLDERS,
      ),
      files: newest(
        [
          ...files.map((f) => ({ dto: fileDto(f), at: f.lastActivityAt })),
          ...shared.files.slice(0, SUGGESTED_FILES).map((f) => ({ dto: f, at: new Date(f.sharedAt) })),
        ],
        SUGGESTED_FILES,
      ),
    };
  },
};
