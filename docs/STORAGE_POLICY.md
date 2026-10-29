# Storage, Trash and deletion policy

## What counts toward a user's quota

| State | Counted? | Where |
| --- | --- | --- |
| Completed file in My Drive | Yes | `users.storageUsed` |
| Completed file in Trash | **Yes**, until permanently deleted | `users.storageUsed` (shown separately as "in Trash") |
| Upload in progress (initiated, not yet completed/failed/cancelled/expired) | Yes, as a reservation of its declared size | `users.storageReserved` |
| Failed, cancelled or expired upload | No (reservation released) | — |
| File pending purge whose S3 delete has not succeeded yet | Yes (the bytes still exist) | `users.storageUsed` |

`available = storageQuota − storageUsed − storageReserved`. An upload is only initiated if its
size fits in `available`; the reservation is taken under a per-user lock with a compare-and-swap
on the counters, so parallel uploads cannot exceed the quota. On completion the reservation is
converted to used bytes exactly once (guarded by a unique `settlements` record).

The size used is the size declared at initiation, which is part of the presigned URL signature
(`Content-Length`) and is re-checked against S3 (`HeadObject`) before the file is accepted. The
browser's reported size is never trusted on its own.

## Duplicate names

Names do not need to be unique: two files called `report.pdf` in the same folder are two different
files with different ids and different S3 objects. Items are always addressed by id.

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
   (`CLEANUP_INTERVAL_MINUTES`) and by `npm run reconcile --workspace server`.

## Reconciliation

`npm run reconcile --workspace server` recomputes every user's `storageUsed`/`storageReserved` from
metadata, runs upload/purge maintenance, reports S3 objects that have no metadata (older than 24 h)
and completed files whose object is missing. `-- --delete-orphans` deletes the orphaned objects.
