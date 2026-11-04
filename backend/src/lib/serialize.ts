type Doc = Record<string, unknown> & { _id: unknown };

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : null);

export function folderDto(f: Doc) {
  return {
    id: String(f._id),
    kind: 'folder' as const,
    name: f.name as string,
    parentFolderId: f.parentFolderId ? String(f.parentFolderId) : null,
    isStarred: Boolean(f.isStarred),
    deletedAt: iso(f.deletedAt),
    createdAt: iso(f.createdAt),
    updatedAt: iso(f.updatedAt),
  };
}

export function fileDto(f: Doc) {
  return {
    id: String(f._id),
    kind: 'file' as const,
    name: f.name as string,
    parentFolderId: f.parentFolderId ? String(f.parentFolderId) : null,
    isStarred: Boolean(f.isStarred),
    size: f.size as number,
    mimeType: f.mimeType as string,
    category: f.category as string,
    extension: f.extension as string,
    deletedAt: iso(f.deletedAt),
    createdAt: iso(f.createdAt),
    updatedAt: iso(f.updatedAt),
    lastActivityAt: iso(f.lastActivityAt),
  };
}
