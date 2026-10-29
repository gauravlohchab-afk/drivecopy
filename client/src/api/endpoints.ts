import { api } from './client';
import type {
  User, FolderItem, FileItem, FolderContents, StorageUsage, SortKey, SortOrder,
  InitiateResponse, UploadPolicy, FileCategory,
} from './types';

const qs = (params: Record<string, string | number | undefined | null>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : '';
};

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
  contents: (folderId: string | null, p: ListParams) =>
    api<FolderContents>(`/folders/${folderId ?? 'root'}/contents${qs({ sort: p.sort, order: p.order, cursor: p.cursor, limit: 100 })}`),
  list: (parentFolderId: string | null) => api<{ items: FolderItem[] }>(`/folders${qs({ parentFolderId: parentFolderId ?? 'root' })}`),
  create: (name: string, parentFolderId: string | null) => api<{ folder: FolderItem }>('/folders', { method: 'POST', body: { name, parentFolderId } }),
  rename: (id: string, name: string) => api<{ folder: FolderItem }>(`/folders/${id}`, { method: 'PATCH', body: { name } }),
  star: (id: string, starred: boolean) => api<{ folder: FolderItem }>(`/folders/${id}/star`, { method: 'POST', body: { starred } }),
  move: (id: string, destinationFolderId: string | null) =>
    api<{ folder: FolderItem }>(`/folders/${id}/move`, { method: 'POST', body: { destinationFolderId } }),
  trash: (id: string) => api<{ trashed: boolean }>(`/folders/${id}`, { method: 'DELETE' }),
};

export const fileApi = {
  rename: (id: string, name: string) => api<{ file: FileItem }>(`/files/${id}`, { method: 'PATCH', body: { name } }),
  star: (id: string, starred: boolean) => api<{ file: FileItem }>(`/files/${id}/star`, { method: 'POST', body: { starred } }),
  move: (id: string, destinationFolderId: string | null) =>
    api<{ file: FileItem }>(`/files/${id}/move`, { method: 'POST', body: { destinationFolderId } }),
  trash: (id: string) => api<{ trashed: boolean }>(`/files/${id}`, { method: 'DELETE' }),
  previewUrl: (id: string) => api<{ url: string; expiresAt: string; mimeType: string }>(`/files/${id}/preview-url`, { method: 'POST' }),
  downloadUrl: (id: string) => api<{ url: string; expiresAt: string }>(`/files/${id}/download-url`, { method: 'POST' }),
  thumbnailUrls: (ids: string[]) => api<{ urls: Record<string, string>; expiresAt: string }>('/files/thumbnail-urls', { method: 'POST', body: { ids } }),
};

export const uploadApi = {
  policy: () => api<UploadPolicy>('/uploads/policy'),
  initiate: (body: { name: string; size: number; mimeType?: string; parentFolderId: string | null }, signal?: AbortSignal) =>
    api<InitiateResponse>('/uploads/initiate', { method: 'POST', body, signal }),
  refreshUrl: (id: string) => api<{ url: string; headers: Record<string, string> }>(`/uploads/${id}/url`, { method: 'POST' }),
  complete: (id: string) => api<{ status: 'completed'; file: FileItem }>(`/uploads/${id}/complete`, { method: 'POST' }),
  cancel: (id: string) => api<{ status: string }>(`/uploads/${id}/cancel`, { method: 'POST' }),
  partUrls: (id: string, partNumbers: number[]) =>
    api<{ parts: { partNumber: number; size: number; url: string }[] }>(`/uploads/${id}/multipart/part-url`, { method: 'POST', body: { partNumbers } }),
  completeMultipart: (id: string, parts: { partNumber: number; etag: string }[]) =>
    api<{ status: 'completed'; file: FileItem }>(`/uploads/${id}/multipart/complete`, { method: 'POST', body: { parts } }),
  abortMultipart: (id: string) => api<{ status: string }>(`/uploads/${id}/multipart/abort`, { method: 'POST' }),
};

export const trashApi = {
  list: () => api<{ folders: FolderItem[]; files: FileItem[] }>('/trash'),
  restore: (id: string) => api<{ restored: boolean; restoredToRoot: boolean }>(`/trash/${id}/restore`, { method: 'POST' }),
  purge: (id: string) => api<{ deletedFiles: number; deletedFolders: number; pendingRetries: number }>(`/trash/${id}/permanent`, { method: 'DELETE' }),
  empty: () => api<{ deletedFiles: number; deletedFolders: number; pendingRetries: number }>('/trash', { method: 'DELETE' }),
};

export interface SearchParams extends ListParams {
  q?: string;
  type?: 'folder' | FileCategory | '';
  folderId?: string | null;
  modifiedAfter?: string;
}

export const discoveryApi = {
  search: (p: SearchParams) =>
    api<{ folders: FolderItem[]; files: FileItem[]; nextCursor: string | null }>(
      `/search${qs({ q: p.q, type: p.type, folderId: p.folderId, modifiedAfter: p.modifiedAfter, sort: p.sort, order: p.order, cursor: p.cursor, limit: 100 })}`,
    ),
  recent: (cursor?: string | null) => api<{ files: FileItem[]; nextCursor: string | null }>(`/recent${qs({ cursor, limit: 50 })}`),
  starred: () => api<{ folders: FolderItem[]; files: FileItem[] }>('/starred'),
  usage: () => api<StorageUsage>('/storage/usage'),
};
