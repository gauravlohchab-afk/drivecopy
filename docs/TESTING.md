# Testing

## Backend (`backend/`)

```bash
MONGODB_URI=mongodb://127.0.0.1:27017 npm test --workspace backend
npm run test:unit --workspace backend          # no database needed
npm run test:integration --workspace backend
```

- **Unit** (`test/unit`): file-type policy and magic numbers, name sanitising, S3 service error
  mapping and batch delete failures (with `aws-sdk-client-mock`), presigned URL parameters,
  multipart planning, keyset cursors.
- **Integration** (`test/integration`): the real Express app over HTTP (supertest) against a real
  MongoDB-compatible database, with S3 replaced by an in-memory fake (`test/helpers/fakeS3.ts`)
  that can inject outages and per-key delete failures. Each file uses its own database.
  - `auth`: no registration, environment credentials, generic errors, failed-login lockout, hashed
    session tokens, CSRF and origin checks, password and username changes applying on restart.
  - `admin-migration`: former accounts moved to the admin with S3 keys unchanged, Trash, usage,
    workspaces, drives, shares and in-progress uploads carried over, repeat and interrupted runs.
  - `activity-log`: JSON Lines objects and keys in S3, no overwrites, no secrets, sharing and sign-in
    events, paging across objects, filters, S3 outage and recovery, older history copied once.
  - `s3-stats`: real figures with S3 pagination, caching, updates after upload and delete, listing
    races, outages, and no quota anywhere.
  - `folders`: nesting, breadcrumbs, validation, duplicates, rename/star, moves, self/descendant
    move rejection, concurrent cross-moves.
  - `uploads`: presigned URL contents, verification before listing, idempotent and concurrent
    completion, size mismatch, signature mismatch, type/size rejection, URL refresh, expiry,
    cancel, destination ownership, trashed destination, S3 outage (503 then retry), DB failure
    after S3 success recovered by the maintenance job, multipart (missing parts, bad ETags,
    duplicate completion), orphaned multipart cleanup.
  - `files-trash`: rename/move without S3 calls, preview/download URL headers, thumbnails, star,
    recent, subtree trash/restore, restore to root, permanent delete (S3 + metadata + usage),
    partial S3 delete failure and retry, empty Trash, search filters and cursor pagination.
  - `isolation`: cross-user access attempts on every route family. The API can no longer create
    accounts, so `test/helpers/app.ts` creates these users directly in the database.

The integration suite was run against FerretDB 1.24 (SQLite backend) during development because a
MongoDB binary could not be downloaded there; FerretDB does not support TTL indexes, so the test
helper skips only those. CI runs the same suite against MongoDB 7.

Integration tests against a **real S3 test bucket** are not included: no credentials were
available. To exercise S3 for real, point a local run at a dedicated test bucket and follow the
smoke test in DEPLOYMENT.md.

## Frontend (`frontend/`)

```bash
npm test --workspace frontend
```

Upload manager tests (with a fake `XMLHttpRequest`): client-side type/size rejection, real progress
events, completion only after the server verifies, retry with a fresh URL after a network error,
and cancellation calling the server. Plus formatting helpers.

## Browser smoke test (`e2e/`)

`backend/test/e2e/harness.ts` serves the built SPA and the real API on one origin, with S3 replaced
by the in-memory fake. `e2e/smoke.cjs` (Playwright) routes the presigned S3 URLs to the harness and
walks through the main flows on desktop, tablet and phone viewports, failing on horizontal overflow.

```bash
npm run build --workspace frontend
(cd backend && E2E_MONGODB_URI=mongodb://127.0.0.1:27017/drivecopy_e2e npx tsx test/e2e/harness.ts) &
npx playwright install chromium   # once
node e2e/smoke.cjs                # screenshots land in e2e/shots/
```

The harness uses the test login from `test/setup-env.ts`. Set `E2E_ADMIN_USERNAME` and
`E2E_ADMIN_PASSWORD` if you started it with different credentials.

This verifies application behaviour, not AWS configuration.
