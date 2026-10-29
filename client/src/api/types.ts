export interface User {
  id: string;
  name: string;
  email: string;
  storageQuota: number;
  storageUsed: number;
  createdAt?: string;
}

export type FileCategory = 'image' | 'video' | 'audio' | 'pdf' | 'document' | 'spreadsheet' | 'presentation' | 'text' | 'archive' | 'other';

export interface FolderItem {
  id: string;
  kind: 'folder';
  name: string;
  parentFolderId: string | null;
  isStarred: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FileItem {
  id: string;
  kind: 'file';
  name: string;
  parentFolderId: string | null;
  isStarred: boolean;
  size: number;
  mimeType: string;
  category: FileCategory;
  extension: string;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
}

export type DriveItem = FolderItem | FileItem;

export interface Crumb {
  id: string;
  name: string;
}

export interface FolderContents {
  folder: FolderItem | null;
  path: Crumb[];
  folders: FolderItem[];
  files: FileItem[];
  nextCursor: string | null;
}

export interface StorageUsage {
  quota: number;
  used: number;
  reserved: number;
  inTrash: number;
  remaining: number;
}

export type SortKey = 'name' | 'modified' | 'size';
export type SortOrder = 'asc' | 'desc';

export interface InitiateSingle {
  uploadId: string;
  fileId: string;
  mode: 'single';
  url: string;
  headers: Record<string, string>;
  urlExpiresInSeconds: number;
}
export interface InitiateMultipart {
  uploadId: string;
  fileId: string;
  mode: 'multipart';
  partSize: number;
  partCount: number;
}
export type InitiateResponse = InitiateSingle | InitiateMultipart;

export interface UploadPolicy {
  maxFileSize: number;
  multipartThreshold: number;
  allowedExtensions: string[];
  urlTtlSeconds: number;
}
