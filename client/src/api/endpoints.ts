import { api } from './client';
import type {
  User, FolderItem, FileItem, FolderContents, StorageUsage, SortKey, SortOrder,
  InitiateResponse, UploadPolicy, FileCategory, DriveItem, SharePerson, ActivityEntry, StorageBreakdown, WorkspaceSummary, SharedDriveSummary, DriveMember, DriveRole,
} from './types';

const qs = (params: Record<string, string | number | undefined | null>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : '';
};

/** Routes inside a shared drive live under /drives/:driveId; the rest of the path is unchanged. */
const at = (driveId: string | null | undefined, p: string) => (driveId ? `/drives/${driveId}${p}` : p);
type D = string | null | undefined;

export const authApi = {
  me: () => api<{ user: User; csrfToken: string }>('/auth/me'),
  login: (body: { email: string; password: string }) => api<{ user: User; csrfToken: string }>('/auth/login', { method: 'POST', body }),
  register: (body: { name: string; email: string; password: string }) =>
    api<{ user: User; csrfToken: string }>('/auth/register', { method: 'POST', body }),
  logout: () => api<void>('/auth/logout', { method: 'POST' }),
  updateProfile: (body: { name: string }) => api<{ user: User }>('/auth/me', { method: 'PATCH', body }),
  changePassword: (body: { currentPassword: string; newPassword: string }) => api<void>('/auth/password', { method: 'POST', body }),
};

export interface ListParams {
  sort: SortKey;
  order: SortOrder;
  cursor?: string | null;
}

export const folderApi = {
  contents: (folderId: string | null, p: ListParams, driveId?: D) =>
    api<FolderContents>(at(driveId, `/folders/${folderId ?? 'root'}/contents${qs({ sort: p.sort, order: p.order, cursor: p.cursor, limit: 100 })}`)),
  list: (parentFolderId: string | null, driveId?: D) => api<{ items: FolderItem[] }>(at(driveId, `/folders${qs({ parentFolderId: parentFolderId ?? 'root' })}`)),
  create: (name: string, parentFolderId: string | null, driveId?: D) => api<{ folder: FolderItem }>(at(driveId, '/folders'), { method: 'POST', body: { name, parentFolderId } }),
  rename: (id: string, name: string, driveId?: D) => api<{ folder: FolderItem }>(at(driveId, `/folders/${id}`), { method: 'PATCH', body: { name } }),
  star: (id: string, starred: boolean) => api<{ folder: FolderItem }>(`/folders/${id}/star`, { method: 'POST', body: { starred } }),
  move: (id: string, destinationFolderId: string | null, driveId?: D) =>
    api<{ folder: FolderItem }>(at(driveId, `/folders/${id}/move`), { method: 'POST', body: { destinationFolderId } }),
  trash: (id: string, driveId?: D) => api<{ trashed: boolean }>(at(driveId, `/folders/${id}`), { method: 'DELETE' }),
};

export const fileApi = {
  rename: (id: string, name: string, driveId?: D) => api<{ file: FileItem }>(at(driveId, `/files/${id}`), { method: 'PATCH', body: { name } }),
  star: (id: string, starred: boolean) => api<{ file: FileItem }>(`/files/${id}/star`, { method: 'POST', body: { starred } }),
  move: (id: string, destinationFolderId: string | null, driveId?: D) =>
    api<{ file: FileItem }>(at(driveId, `/files/${id}/move`), { method: 'POST', body: { destinationFolderId } }),
  trash: (id: string, driveId?: D) => api<{ trashed: boolean }>(at(driveId, `/files/${id}`), { method: 'DELETE' }),
  previewUrl: (id: string, driveId?: D) => api<{ url: string; expiresAt: string; mimeType: string }>(at(driveId, `/files/${id}/preview-url`), { method: 'POST' }),
  downloadUrl: (id: string, driveId?: D) => api<{ url: string; expiresAt: string }>(at(driveId, `/files/${id}/download-url`), { method: 'POST' }),
  thumbnailUrls: (ids: string[], driveId?: D) =>
    api<{ urls: Record<string, string>; expiresAt: string }>(at(driveId, '/files/thumbnail-urls'), { method: 'POST', body: { ids } }),
};

export const uploadApi = {
  policy: () => api<UploadPolicy>('/uploads/policy'),
  initiate: (body: { name: string; size: number; mimeType?: string; parentFolderId: string | null }, signal?: AbortSignal, driveId?: D) =>
    api<InitiateResponse>(at(driveId, '/uploads/initiate'), { method: 'POST', body, signal }),
  refreshUrl: (id: string, driveId?: D) => api<{ url: string; headers: Record<string, string> }>(at(driveId, `/uploads/${id}/url`), { method: 'POST' }),
  complete: (id: string, driveId?: D) => api<{ status: 'completed'; file: FileItem }>(at(driveId, `/uploads/${id}/complete`), { method: 'POST' }),
  cancel: (id: string, driveId?: D) => api<{ status: string }>(at(driveId, `/uploads/${id}/cancel`), { method: 'POST' }),
  partUrls: (id: string, partNumbers: number[], driveId?: D) =>
    api<{ parts: { partNumber: number; size: number; url: string }[] }>(at(driveId, `/uploads/${id}/multipart/part-url`), { method: 'POST', body: { partNumbers } }),
  completeMultipart: (id: string, parts: { partNumber: number; etag: string }[], driveId?: D) =>
    api<{ status: 'completed'; file: FileItem }>(at(driveId, `/uploads/${id}/multipart/complete`), { method: 'POST', body: { parts } }),
  abortMultipart: (id: string, driveId?: D) => api<{ status: string }>(at(driveId, `/uploads/${id}/multipart/abort`), { method: 'POST' }),
};

export const trashApi = {
  list: (driveId?: D) => api<{ folders: FolderItem[]; files: FileItem[] }>(at(driveId, '/trash')),
  restore: (id: string, driveId?: D) => api<{ restored: boolean; restoredToRoot: boolean }>(at(driveId, `/trash/${id}/restore`), { method: 'POST' }),
  purge: (id: string, driveId?: D) =>
    api<{ deletedFiles: number; deletedFolders: number; pendingRetries: number }>(at(driveId, `/trash/${id}/permanent`), { method: 'DELETE' }),
  empty: (driveId?: D) => api<{ deletedFiles: number; deletedFolders: number; pendingRetries: number }>(at(driveId, '/trash'), { method: 'DELETE' }),
};

export const driveApi = {
  list: () => api<{ drives: SharedDriveSummary[] }>('/drives'),
  get: (id: string) => api<{ drive: SharedDriveSummary }>(`/drives/${id}`),
  create: (name: string) => api<{ drive: SharedDriveSummary }>('/drives', { method: 'POST', body: { name } }),
  update: (id: string, patch: { name?: string; hidden?: boolean }) => api<{ drive: SharedDriveSummary }>(`/drives/${id}`, { method: 'PATCH', body: patch }),
  remove: (id: string) => api<{ deleted: boolean }>(`/drives/${id}`, { method: 'DELETE' }),
  members: (id: string) => api<{ members: DriveMember[] }>(`/drives/${id}/members`),
  addMember: (id: string, email: string, role: DriveRole) => api<{ members: DriveMember[] }>(`/drives/${id}/members`, { method: 'POST', body: { email, role } }),
  setRole: (id: string, userId: string, role: DriveRole) => api<{ members: DriveMember[] }>(`/drives/${id}/members/${userId}`, { method: 'PATCH', body: { role } }),
  removeMember: (id: string, userId: string) => api<{ members: DriveMember[] }>(`/drives/${id}/members/${userId}`, { method: 'DELETE' }),
};

const sharesPath = (item: DriveItem) => `/${item.kind === 'folder' ? 'folders' : 'files'}/${item.id}/shares`;

export const shareApi = {
  people: (item: DriveItem) => api<{ people: SharePerson[] }>(sharesPath(item)),
  add: (item: DriveItem, email: string) => api<{ people: SharePerson[] }>(sharesPath(item), { method: 'POST', body: { email } }),
  remove: (item: DriveItem, userId: string) => api<{ people: SharePerson[] }>(`${sharesPath(item)}/${userId}`, { method: 'DELETE' }),
  sharedWithMe: () => api<{ folders: FolderItem[]; files: FileItem[] }>('/shared'),
  folderContents: (folderId: string, p: ListParams) =>
    api<FolderContents>(`/shared/folders/${folderId}/contents${qs({ sort: p.sort, order: p.order, cursor: p.cursor, limit: 100 })}`),
  leave: (id: string) => api<{ removed: boolean }>(`/shared/${id}`, { method: 'DELETE' }),
};

type ItemRef = { id: string; kind: 'file' | 'folder' };

export const workspaceApi = {
  list: () => api<{ workspaces: WorkspaceSummary[] }>('/workspaces'),
  get: (id: string) => api<{ workspace: WorkspaceSummary; unavailable: number; folders: FolderItem[]; files: FileItem[] }>(`/workspaces/${id}`),
  create: (name: string, items: ItemRef[]) => api<{ workspace: WorkspaceSummary }>('/workspaces', { method: 'POST', body: { name, items } }),
  update: (id: string, patch: { name?: string; hidden?: boolean }) => api<{ workspace: WorkspaceSummary }>(`/workspaces/${id}`, { method: 'PATCH', body: patch }),
  remove: (id: string) => api<{ deleted: boolean }>(`/workspaces/${id}`, { method: 'DELETE' }),
  addItems: (id: string, items: ItemRef[]) => api<{ workspace: WorkspaceSummary }>(`/workspaces/${id}/items`, { method: 'POST', body: { items } }),
  removeItem: (id: string, itemId: string) => api<{ workspace: WorkspaceSummary }>(`/workspaces/${id}/items/${itemId}`, { method: 'DELETE' }),
};

export interface SearchParams extends ListParams {
  q?: string;
  type?: 'folder' | FileCategory | '';
  folderId?: string | null;
  modifiedAfter?: string;
  modifiedBefore?: string;
  /** 'me', 'others' or an owner's email. */
  owner?: string;
  location?: 'mydrive' | 'shared';
  inTrash?: boolean;
  starred?: boolean;
  sharedTo?: string;
  sizeMin?: number;
  sizeMax?: number;
}

export const discoveryApi = {
  search: (p: SearchParams) =>
    api<{ folders: FolderItem[]; files: FileItem[]; nextCursor: string | null }>(
      `/search${qs({ q: p.q, type: p.type, folderId: p.folderId, modifiedAfter: p.modifiedAfter, modifiedBefore: p.modifiedBefore, owner: p.owner, location: p.location, inTrash: p.inTrash ? 'true' : undefined, starred: p.starred ? 'true' : undefined, sharedTo: p.sharedTo, sizeMin: p.sizeMin, sizeMax: p.sizeMax, sort: p.sort, order: p.order, cursor: p.cursor, limit: 100 })}`,
    ),
  recent: (cursor?: string | null) => api<{ files: FileItem[]; nextCursor: string | null }>(`/recent${qs({ cursor, limit: 50 })}`),
  starred: () => api<{ folders: FolderItem[]; files: FileItem[] }>('/starred'),
  usage: () => api<StorageUsage>('/storage/usage'),
  storageBreakdown: () => api<StorageBreakdown>('/storage/breakdown'),
  home: () => api<{ folders: FolderItem[]; files: FileItem[] }>('/home'),
  activity: (cursor?: string | null) => api<{ items: ActivityEntry[]; nextCursor: string | null }>(`/activity${qs({ cursor, limit: 50 })}`),
};
