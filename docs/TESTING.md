# Testing

## Server (`server/`)

```bash
MONGODB_URI=mongodb://127.0.0.1:27017 npm test --workspace server
npm run test:unit --workspace server          # no database needed
npm run test:integration --workspace server
```

- **Unit** (`test/unit`): file-type policy and magic numbers, name sanitising, S3 service error
  mapping and batch delete failures (with `aws-sdk-client-mock`), presigned URL parameters,
  multipart planning, keyset cursors.
- **Integration** (`test/integration`): the real Express app over HTTP (supertest) against a real
  MongoDB-compatible database, with S3 replaced by an in-memory fake (`test/helpers/fakeS3.ts`)
  that can inject outages and per-key delete failures. Each file uses its own database.
  - `auth`: register/login/logout, Argon2id, hashed session tokens, CSRF and origin checks,
    password change revoking other sessions, generic errors.
  - `folders`: nesting, breadcrumbs, validation, duplicates, rename/star, moves, self/descendant
    move rejection, concurrent cross-moves.
  - `uploads`: presigned URL contents, verification before listing, idempotent and concurrent
    completion, size mismatch, signature mismatch, type/size rejection, URL refresh, expiry,
    cancel, destination ownership, trashed destination, S3 outage (503 then retry), DB failure
    after S3 success recovered by the maintenance job, multipart (missing parts, bad ETags,
    duplicate completion), orphaned multipart cleanup, concurrent quota enforcement.
  - `files-trash`: rename/move without S3 calls, preview/download URL headers, thumbnails, star,
    recent, subtree trash/restore, restore to root, permanent delete (S3 + metadata + quota),
    partial S3 delete failure and retry, empty Trash, search filters and cursor pagination.
  - `isolation`: cross-user access attempts on every route family.

The integration suite was run against FerretDB 1.24 (SQLite backend) during development because a
MongoDB binary could not be downloaded there; FerretDB does not support TTL indexes, so the test
helper skips only those. CI runs the same suite against MongoDB 7.

Integration tests against a **real S3 test bucket** are not included: no credentials were
available. To exercise S3 for real, point a local run at a dedicated test bucket and follow the
smoke test in DEPLOYMENT.md.

## Client (`client/`)

```bash
npm test --workspace client
```

Upload manager tests (with a fake `XMLHttpRequest`): client-side type/size rejection, real progress
events, completion only after the server verifies, retry with a fresh URL after a network error,
and cancellation calling the server. Plus formatting helpers.

## Browser smoke test (`e2e/`)

`server/test/e2e/harness.ts` serves the built SPA and the real API on one origin, with S3 replaced
by the in-memory fake. `e2e/smoke.cjs` (Playwright) routes the presigned S3 URLs to the harness and
walks through the main flows on desktop, tablet and phone viewports, failing on horizontal overflow.

```bash
npm run build --workspace client
(cd server && E2E_MONGODB_URI=mongodb://127.0.0.1:27017/drivecopy_e2e npx tsx test/e2e/harness.ts) &
npx playwright install chromium   # once
node e2e/smoke.cjs                # screenshots land in e2e/shots/
```

This verifies application behaviour, not AWS configuration.
