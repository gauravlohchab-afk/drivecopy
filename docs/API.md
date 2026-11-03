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

## Sharing

Viewer access only: people an item is shared with can list, preview and download it, never change
it. A folder share covers its whole subtree, checked per request against the item's current
ancestors, so moves, Trash and unsharing take effect immediately. Items someone else owns come
back with `owner: {name, email}` (and `sharedAt` on the Shared list), `isStarred: false` and
`parentFolderId: null`.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/files/:id/shares`, `/folders/:id/shares` | Owner only. `{people: [{userId, name, email, sharedAt}]}` |
| POST | `/files/:id/shares`, `/folders/:id/shares` | Owner only. `{email}`; 404 if no account uses it, 400 for yourself. Idempotent. Rate limited (60 / 15 min / IP). Returns `{people}` |
| DELETE | `/files/:id/shares/:userId`, `/folders/:id/shares/:userId` | Owner only. Revokes access; returns `{people}` |
| GET | `/shared` | Items shared directly with you: `{folders, files}`, newest first. Trashed items are left out |
| GET | `/shared/folders/:id/contents` | Read-only listing of a shared folder or any folder inside it (same shape as `/folders/:id/contents`). `path` starts at the shared folder |
| DELETE | `/shared/:id` | Removes an item from your Shared list (drops your own access) |

`POST /files/:id/preview-url`, `/download-url` and `/files/thumbnail-urls` also accept files
shared with you. Viewers opening a file don't change the owner's Recent list.

## Shared drives

A shared drive owns its files through a non-login principal account (`kind: "drive"`) that also carries its storage quota. Roles: `manager` > `content_manager` > `viewer`. Non-members get 404 for everything about a drive.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/drives` | `{drives: [{id, name, role, hidden, memberCount, createdAt}]}` |
| POST | `/drives` | `{name}` → `201 {drive}`; you become its manager |
| GET | `/drives/:id` | `{drive}` with `usage` (the drive's storage) |
| PATCH | `/drives/:id` | `{name?}` (manager) and/or `{hidden?}` (per member) |
| DELETE | `/drives/:id` | Manager; 409 unless the drive is empty, Trash included |
| GET | `/drives/:id/members` | `{members: [{userId, name, email, role, isYou}]}` |
| POST | `/drives/:id/members` | Manager. `{email, role}`; 404 unknown email, 409 already a member |
| PATCH | `/drives/:id/members/:userId` | Manager. `{role}`; 400 if it would leave no manager |
| DELETE | `/drives/:id/members/:userId` | Manager, or yourself (leave); 400 if it would leave no manager |

Inside a drive, the regular routes are available under `/drives/:id`: `folders` (list, create, get, contents, rename, move, trash), `files` (get, rename, move, preview-url, download-url, thumbnail-urls, trash), `uploads/*`, `trash` (list, restore, permanent, empty), `search` and `storage/usage`. Viewers may only GET and request preview/download/thumbnail URLs (403 otherwise); stars are not available on drive items. Every file/folder in these responses carries `driveId` and `driveRole`; global `/search` results from drives also carry `driveName`.

## Trash, search and the rest

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/trash` | `{folders, files}` that were trashed directly (not their contents) |
| POST | `/trash/:id/restore` | `{restored, restoredToRoot, kind}` |
| DELETE | `/trash/:id/permanent` | `{deletedFiles, deletedFolders, freedBytes, pendingRetries}` |
| DELETE | `/trash` | Empty Trash (same response) |
| GET | `/search` | `q` (name), `type` (`folder`, `image`, `video`, `audio`, `pdf`, `document`, `spreadsheet`, `presentation`, `text`, `archive`), `folderId` (that folder and its subfolders), `modifiedAfter`, `modifiedBefore` (ISO dates), `owner` (`any`, `me`, `others` or an email), `location` (`anywhere`, `mydrive`, `shared`), `inTrash`, `starred` (`true`), `sharedTo` (email: items you shared with them), `sizeMin`, `sizeMax` (bytes; files only), sort/order/limit/cursor. Covers your items (paginated) plus, on the first page, items shared with you directly or inside shared folders (up to 200, carrying `owner`) |
| GET | `/recent` | Files by last activity (upload, rename, move, preview, download) |
| GET | `/starred` | `{folders, files}` |
| GET | `/storage/usage` | `{quota, used, reserved, inTrash, remaining}` in bytes |
| GET | `/home` | Suggested items: `{folders, files}` you used most recently, merged with items recently shared with you (which carry `owner`) |
| GET | `/activity` | `limit`, `cursor`. `{items: [{id, action, at, actor, owner, target, item: {id, kind, name}, detail}], nextCursor}`. Actions: `upload`, `create_folder`, `rename` (detail = old name), `move` (detail = destination), `trash`, `restore`, `delete`, `share`, `unshare`, `download`. Includes what you did, what happened to your items, and shares with you |
| GET | `/storage/breakdown` | `{byCategory: [{category, bytes, count}], largestFolders: [{folder, bytes}]}` for active (not trashed) files; folder sizes include subfolders |
| GET | `/workspaces` | `{workspaces: [{id, name, hidden, itemCount, createdAt, updatedAt}]}` (your own only) |
| POST | `/workspaces` | `{name, items?: [{id, kind}]}` → `201 {workspace}`. Items must be readable by you (own or shared); max 25 per workspace, 100 workspaces |
| GET | `/workspaces/:id` | `{workspace, unavailable, folders, files}`; items are re-checked for access on every read, and ones in Trash or no longer shared are counted in `unavailable` instead of listed |
| PATCH | `/workspaces/:id` | `{name?, hidden?}` |
| DELETE | `/workspaces/:id` | Deletes the workspace only; its files and folders are untouched |
| POST | `/workspaces/:id/items` | `{items: [{id, kind}]}`; duplicates ignored, 400 past 25 items |
| DELETE | `/workspaces/:id/items/:itemId` | Removes the reference only |
| GET | `/health` | `{status:"ok"}` |
