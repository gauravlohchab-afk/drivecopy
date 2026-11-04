export interface User {
  id: string;
  name: string;
  email: string;
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
  /** Set on items someone else shared with you. */
  owner?: Person;
  sharedAt?: string;
  /** Set on items that live in a shared drive. */
  driveId?: string;
  driveRole?: DriveRole;
  driveName?: string;
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
  owner?: Person;
  sharedAt?: string;
  driveId?: string;
  driveRole?: DriveRole;
  driveName?: string;
}

export type DriveRole = 'viewer' | 'content_manager' | 'manager';

export interface SharedDriveSummary {
  id: string;
  name: string;
  role: DriveRole;
  hidden: boolean;
  memberCount: number;
  createdAt: string;
  usage?: StorageUsage;
}

export interface DriveMember {
  userId: string;
  name: string;
  email: string;
  role: DriveRole;
  isYou: boolean;
}

export interface Person {
  name: string;
  email: string;
}

export interface SharePerson extends Person {
  userId: string;
  sharedAt: string;
}

export type DriveItem = FolderItem | FileItem;

export interface ActivityPerson {
  id: string;
  name: string;
  isYou: boolean;
}

export type ActivityCategory = 'file' | 'folder' | 'sharing' | 'auth';

export interface ActivityEntry {
  id: string;
  /** For example FILE_UPLOADED. */
  eventType: string;
  category: ActivityCategory;
  /** Plain description, for example "Uploaded a file". */
  action: string;
  status: 'SUCCESS' | 'FAILED';
  at: string;
  /** Null for a failed sign-in, which is not tied to any account. */
  actor: ActivityPerson | null;
  target: ActivityPerson | null;
  item: { id: string; kind: 'file' | 'folder' | 'drive'; name: string } | null;
  details: Record<string, unknown>;
}

export interface ActivityPage {
  items: ActivityEntry[];
  nextCursor: string | null;
  logStorage: { status: 'ok' | 'degraded'; pendingEvents: number; reason: string | null };
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  hidden: boolean;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface StorageBreakdown {
  byCategory: { category: FileCategory; bytes: number; count: number }[];
  largestFolders: { folder: FolderItem; bytes: number }[];
}

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
  used: number;
  reserved: number;
  inTrash: number;
}

/** Bucket-wide figures. The numbers are null until the server has managed to list the bucket. */
export interface S3Stats {
  storageType: string;
  status: 'connected' | 'checking' | 'unavailable';
  totalBytes: number | null;
  totalFiles: number | null;
  totalSize: string | null;
  lastVerifiedAt: string | null;
  lastUpdatedAt: string | null;
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
