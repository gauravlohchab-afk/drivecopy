# Storage, Trash and deletion policy

## No storage quota

The application does not limit total storage. Uploads are limited only by file-type validation, the
per-file limit (`MAX_FILE_SIZE_MB`), S3 itself and your AWS bill. `storageQuota` values on older
account records are ignored and left in place.

## What the sidebar shows

`GET /api/storage/s3` reports what is really in the bucket under `users/`, which holds all files,
shared drives included:

- A full listing, following S3's pagination, runs at startup and every
  `STORAGE_STATS_REFRESH_MINUTES`. The result is cached in MongoDB, so page loads never list the bucket.
- Each completed upload and permanent delete adjusts the cached figures immediately, and schedules a
  verifying listing within 5 minutes. Bursts of changes share one listing.
- If an upload or delete lands during a listing, the listing's result is discarded and it runs again.
- Files in Trash count, because their objects remain in S3 until permanently deleted.
- Activity logs are excluded, since they are not files.
- If S3 cannot be reached, the status shows Unavailable with the last verified figures and their
  time. Before the first successful listing, no number is shown.

## Activity log

Events are stored in S3 as JSON Lines, one object per batch, separate from user files:

```text
activity-logs/2026/11/04/activity-20261104T113621123Z-<uuid>.jsonl
```

```json
{"eventId":"<uuid>","eventType":"FILE_UPLOADED","userId":"<id>","fileId":"<id>","fileName":"MBA_Certificate.pdf","action":"Uploaded a file","details":{"fileSize":1677721,"mimeType":"application/pdf"},"timestamp":"2026-11-04T06:06:21.123Z","status":"SUCCESS"}
```

Folder events carry `folderId` and `folderName` instead of the file fields. Timestamps are UTC.

| Group | `eventType` |
| --- | --- |
| Files | `FILE_UPLOADED`, `FILE_DOWNLOADED`, `FILE_PREVIEWED`, `FILE_RENAMED`, `FILE_MOVED`, `FILE_DELETED` (to Trash), `FILE_RESTORED`, `FILE_PERMANENTLY_DELETED` |
| Folders | `FOLDER_CREATED`, `FOLDER_RENAMED`, `FOLDER_MOVED`, `FOLDER_DELETED` (to Trash), `FOLDER_RESTORED`, `FOLDER_PERMANENTLY_DELETED` |
| Sharing | `FILE_SHARED`, `FOLDER_SHARED`, `SHARING_PERMISSIONS_CHANGED` (a shared drive member's role), `FILE_ACCESS_REVOKED`, `FOLDER_ACCESS_REVOKED` |
| Sign-in | `LOGIN_SUCCESSFUL`, `LOGIN_FAILED`, `LOGOUT` |

**Writing.** An event is saved to the `activityoutboxes` collection in the same request, and a
background job writes batches to S3 every `ACTIVITY_FLUSH_SECONDS`, removing them from the outbox only
after S3 confirms. Only one instance writes at a time. Objects are created with `If-None-Match: *` and
never modified, so a log cannot be overwritten. If S3 fails, events stay in the outbox and are retried.
A crash between the write and the removal can store a batch twice; readers drop repeats by `eventId`.

**Reading.** The backend walks days and objects newest first, filtering as it goes. Date filters skip
whole days without reading them. Each request reads at most 100 objects, so a narrow search over a long
history can return a short page with a cursor to continue. Objects never change, so recently read ones
are cached in memory.

**Older history** in the `activities` collection is copied to S3 once, into one
`activity-00000000T000000000Z-legacy.jsonl` object per day. The collection is no longer written to.

## Existing accounts

On startup, every account other than the admin is moved to it:

- Each account's top-level items go into an `Imported from <email>` folder in the admin's My Drive,
  with their structure intact. Trash, workspaces, sharing records and uploads in progress move too.
- **Only metadata changes.** Each file record keeps its existing `s3Key`, so nothing in S3 is copied or
  uploaded again by this step. `npm run sync-s3` (see S3 object names) moves those objects if wanted.
- The admin becomes a manager of every shared drive. Existing members stay.
- The former account record is kept, `status: "disabled"` with `mergedIntoUserId` set, and its
  sessions are ended.
- Every step can safely run again, so an interrupted migration finishes on the next start.
- If `ADMIN_LOGIN_USERNAME` is an existing account's email the first time this runs, that account
  becomes the admin and its files stay where they are.

## What counts toward an owner's usage

| State | Counted? | Where |
| --- | --- | --- |
| Completed file in My Drive | Yes | `users.storageUsed` |
| Completed file in Trash | **Yes**, until permanently deleted | `users.storageUsed` (shown separately as "in Trash") |
| Upload in progress (initiated, not yet completed/failed/cancelled/expired) | Yes, as a reservation of its declared size | `users.storageReserved` |
| Failed, cancelled or expired upload | No (reservation released) | — |
| File pending purge whose S3 delete has not succeeded yet | Yes (the bytes still exist) | `users.storageUsed` |

These counters are bookkeeping for the Storage page and shared drive headers. They never block an
upload. On completion the reservation is converted to used bytes exactly once (guarded by a unique
`settlements` record).

The size used is the size declared at initiation, which is part of the presigned URL signature
(`Content-Length`) and is re-checked against S3 (`HeadObject`) before the file is accepted. The
browser's reported size is never trusted on its own.

## Duplicate names

Names do not need to be unique: two files called `report.pdf` in the same folder are two different
files with different ids and different S3 objects. Items are always addressed by id.

## S3 object names

The bucket mirrors the app, so it is readable in the S3 console:

```text
users/admin/Reports/2026/Q1 report.pdf
users/Shared drive - Team/Docs/plan.pdf
```

- **Files** upload directly to the right path. If a key is taken, the next free number is used, such as
  `report (1).pdf`; the app still shows `report.pdf`.
- **Folders** get an empty object ending in `/`, so a new folder shows in S3 before it holds any files.
- **Renames and moves**, of files or folders, apply in the app immediately. A background job then updates
  S3 within seconds: it copies each object, verifies the copy, updates the record, then deletes the
  original. Moving a large folder means copying everything in it, so it takes as long as that takes.
- **Reads** always use the key in the record, so a file works throughout, and a file not yet moved works
  the same way. A presigned link issued just before a move stops working when the original is deleted;
  opening the file again gets a new one. Failures are retried a minute later.
- **Trash** is not reflected in S3: items stay at their path until permanently deleted.
- **Same names:** S3 has no real folders, so two app folders with the same name in the same place share a
  path there. They stay separate in the app, and their files never overwrite each other.
- **Limits:** objects over 5 GB stay where they are, since S3 cannot copy them in one request. Trees too
  deep for S3's 1024-byte key limit are placed at the top of the account.

`npm run sync-s3 --workspace backend` brings existing data into this layout. It shows the plan unless given
`-- --apply --log <file>`, which records each file's old and new key before deleting the original. Running
it again is safe.

## Trash

- Moving a folder to Trash moves everything inside it. All of them get the same `trashRootId`,
  and only the folder shows in Trash.
- Items that were already in Trash keep their own entry, so they can be restored separately.
- Restoring brings back the whole group. If the original parent folder was deleted or is itself in
  Trash, the item is restored to the top of My Drive (the UI says so).
- Uploads that finish into a folder that was trashed in the meantime land in Trash with that folder.
- Nothing in S3 is deleted while an item is in Trash.

## Permanent deletion

MongoDB and S3 share no transaction, so deletion is ordered and resumable:

1. All items of the group are marked `purgePending` (hidden everywhere immediately).
2. S3 objects are deleted in batches (`DeleteObjects`).
3. Only files whose S3 delete succeeded have their metadata removed and their bytes subtracted.
4. Folders are removed once no purge-pending files reference them. Independently trashed children
   of a purged folder are re-parented to the root so they are never orphaned.
5. Anything that failed stays `purgePending` and is retried by the maintenance job
   (`CLEANUP_INTERVAL_MINUTES`) and by `npm run reconcile --workspace backend`.

## Reconciliation

`npm run reconcile --workspace backend` recomputes every user's `storageUsed`/`storageReserved` from
metadata, runs upload/purge maintenance, reports S3 objects that have no metadata (older than 24 h)
and completed files whose object is missing. `-- --delete-orphans` deletes the orphaned objects.
