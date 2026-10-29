# REST API

Base path: `/api`. JSON in, JSON out. All routes except register/login/logout/health require a
session cookie. Every resource is scoped to the signed-in user; ids belonging to someone else
return **404** (never 403), exactly like ids that do not exist.

## Conventions

- **Auth:** HTTP-only session cookie (`dc_session`, `__Host-dc_session` in production).
- **CSRF:** authenticated `POST`/`PATCH`/`DELETE` requests must send `X-CSRF-Token` equal to the
  `csrfToken` returned by login/register/me (also in the readable `dc_csrf` cookie). Any `Origin`
  header must equal `FRONTEND_URL`.
- **Folder references:** `null` or `"root"` means the top of My Drive.
- **Pagination:** list endpoints take `limit` (1–200, default 50) and `cursor`; responses include
  `nextCursor` (`null` on the last page). Cursors are opaque keyset cursors.
- **Sorting:** `sort=name|modified|size`, `order=asc|desc`. Folders are listed before files.
- **Errors:** `{"error":{"code":"…","message":"…","details":{…}}}`.

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Invalid body/query (`details.fields`) |
| 400 | `INVALID_MOVE` | Folder moved into itself or a descendant, or too deep |
| 401 | `UNAUTHENTICATED` | Missing/expired session or wrong credentials |
| 403 | `CSRF_FAILED` | Missing/invalid CSRF token or foreign origin |
| 404 | `NOT_FOUND` | Unknown id or not yours |
| 409 | `CONFLICT` / `UPLOAD_STATE` / `UPLOAD_NOT_VERIFIED` / `BUSY` | Duplicate email; upload not in a valid state; object missing or parts missing (`details.missingParts`); concurrent tree change (retry) |
| 410 | `UPLOAD_EXPIRED` | Upload session expired; start again |
| 413 | `FILE_TOO_LARGE` / `QUOTA_EXCEEDED` | Over the per-file limit / not enough space (`details.available`) |
| 415 | `UNSUPPORTED_FILE_TYPE` | Type not allowed, content does not match the extension, or not previewable |
| 422 | `UPLOAD_NOT_VERIFIED` | Object in storage has the wrong size (upload rejected and removed) |
| 429 | `RATE_LIMITED` | Too many attempts |
| 503 | `STORAGE_UNAVAILABLE` | S3 error (details are logged server-side only) |

## Item shapes

```jsonc
// folder
{ "id": "…", "kind": "folder", "name": "Projects", "parentFolderId": null, "isStarred": false,
  "deletedAt": null, "createdAt": "…", "updatedAt": "…" }
// file
{ "id": "…", "kind": "file", "name": "report.pdf", "parentFolderId": "…", "isStarred": false,
  "size": 1048576, "mimeType": "application/pdf", "category": "pdf", "extension": "pdf",
  "deletedAt": null, "createdAt": "…", "updatedAt": "…", "lastActivityAt": "…" }
```

## Auth

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| POST | `/auth/register` | `{name, email, password}` (password ≥10 chars, letters + digits) | `201 {user, csrfToken}` + cookies |
| POST | `/auth/login` | `{email, password}` | `{user, csrfToken}` + cookies |
| POST | `/auth/logout` | – | `204`, session revoked |
| GET | `/auth/me` | – | `{user, csrfToken}` |
| PATCH | `/auth/me` | `{name}` | `{user}` |
| POST | `/auth/password` | `{currentPassword, newPassword}` | `204`, other sessions revoked |

Register/login/password are limited to 10 failed attempts per 15 minutes per IP.

## Folders

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/folders?parentFolderId=` | Subfolders of a folder (used by the move picker) |
| POST | `/folders` | `{name, parentFolderId}` → `201 {folder}` |
| GET | `/folders/:id` | `{folder: {...folder, path:[{id,name}]}}` |
| GET | `/folders/:id/contents` | `:id` may be `root`. Query: sort/order/limit/cursor. `{folder, path, folders, files, nextCursor}` (folders only on the first page) |
| PATCH | `/folders/:id` | `{name?, isStarred?}` |
| POST | `/folders/:id/star` | `{starred: boolean}` |
| POST | `/folders/:id/move` | `{destinationFolderId}` |
| DELETE | `/folders/:id` | Moves the folder and its contents to Trash |

## Files

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/files?folderId=` | Paginated files in a folder |
| GET | `/files/:id` | `{file}` |
| PATCH | `/files/:id` | `{name?, isStarred?}` (metadata only, no S3 copy) |
| POST | `/files/:id/move` | `{destinationFolderId}` (metadata only) |
| POST | `/files/:id/star` | `{starred}` |
| POST | `/files/:id/preview-url` | `{url, expiresAt, mimeType}`; inline disposition; 415 if not previewable |
| POST | `/files/:id/download-url` | `{url, expiresAt}`; attachment disposition with the file name |
| POST | `/files/thumbnail-urls` | `{ids: [...]}` (≤100) → `{urls: {id: url}}` for the caller's images |
| DELETE | `/files/:id` | Move to Trash |

Presigned URLs expire after `PRESIGNED_URL_TTL_SECONDS` (default 900). Responses carrying them are
`Cache-Control: no-store`.

## Uploads

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/uploads/policy` | `{maxFileSize, multipartThreshold, allowedExtensions, urlTtlSeconds}` |
| POST | `/uploads/initiate` | `{name, size, parentFolderId, mimeType?}`. Single: `{uploadId, fileId, mode:"single", url, headers}`. Multipart: `{uploadId, fileId, mode:"multipart", partSize, partCount}` |
| GET | `/uploads/:id` | Session status |
| POST | `/uploads/:id/url` | Fresh single-part URL (retry / expired URL) |
| POST | `/uploads/:id/complete` | Verifies the object and completes. Idempotent: repeats return the same `{status:"completed", file}` |
| POST | `/uploads/:id/cancel` | Cancels, deletes partial data, releases quota. Idempotent |
| POST | `/uploads/:id/multipart/part-url` | `{partNumbers:[1..]}` (≤100 per call) → `{parts:[{partNumber,size,url}]}` |
| POST | `/uploads/:id/multipart/complete` | `{parts:[{partNumber, etag}]}`. Checks parts with S3 `ListParts`; 409 with `missingParts` if any are missing or mismatched |
| POST | `/uploads/:id/multipart/abort` | Same as cancel |

Upload states: `pending → uploading → verifying → completed`, or `failed` / `cancelled`.
The browser must `PUT` the bytes with exactly the returned `Content-Type` header; part uploads
need the `ETag` response header (exposed by the bucket CORS rule).

## Trash, search and the rest

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/trash` | `{folders, files}` that were trashed directly (not their contents) |
| POST | `/trash/:id/restore` | `{restored, restoredToRoot, kind}` |
| DELETE | `/trash/:id/permanent` | `{deletedFiles, deletedFolders, freedBytes, pendingRetries}` |
| DELETE | `/trash` | Empty Trash (same response) |
| GET | `/search` | `q`, `type` (`folder`, `image`, `video`, `audio`, `pdf`, `document`, `spreadsheet`, `presentation`, `text`, `archive`), `folderId` (searches that folder and its subfolders), `modifiedAfter`, `modifiedBefore` (ISO dates), sort/order/limit/cursor |
| GET | `/recent` | Files by last activity (upload, rename, move, preview, download) |
| GET | `/starred` | `{folders, files}` |
| GET | `/storage/usage` | `{quota, used, reserved, inTrash, remaining}` in bytes |
| GET | `/health` | `{status:"ok"}` |
