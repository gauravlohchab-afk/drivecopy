# Cirrus — S3-backed cloud drive

Cirrus is a Google Drive–style file storage web app with original branding. Files live in a
private Amazon S3 bucket; MongoDB holds users, folders, file metadata, upload sessions and
storage accounting. Browsers upload and download **directly to/from S3** with short-lived
presigned URLs, and the API verifies every upload server-side before a file appears.

| Area | What's implemented |
| --- | --- |
| Accounts | Register, sign in/out, current user, profile name, password change (signs out other sessions). Argon2id hashing, server-side sessions in HTTP-only cookies, CSRF tokens, rate limiting. |
| Folders | Create, nest (64 levels), open, breadcrumbs, rename, move (no cycles, serialized per user), star, Trash/restore, permanent delete. |
| Files | Upload (single PUT or multipart), real progress, retry, cancel, preview (images, PDF, video/audio streaming, text), download, rename, move, star, multi-select + bulk actions, Trash/restore, permanent delete. |
| Uploads | Allow-list of types, size limit, atomic quota reservation, presigned URLs with signed `Content-Type`/`Content-Length`, server verification (exists, exact size, magic-number check), idempotent completion, expiry, cleanup of abandoned/multipart uploads, crash recovery. |
| Discovery | Search by name (whole drive or within a folder), type and date filters, sort by name/date/size, cursor pagination, Recent, Starred. |
| Storage | Per-user quota, used/remaining/in-Trash/uploading display, reconciliation tool for counters and S3 orphans. |
| UI | Responsive (desktop, tablet, phone drawer), grid/list views, context menus, keyboard support, loading skeletons, empty/error/retry states, confirmations, toasts with undo. |

Sharing, version history and collaboration are **not** implemented, so the UI has no controls for them.

## Repository layout

```
server/            Express + TypeScript API
  src/config       environment parsing (zod)
  src/models       Mongoose models (User, Session, Folder, File, UploadSession, Settlement, Lock)
  src/services     business logic (auth, folders, files, uploads, trash/purge, search, storage, S3)
  src/controllers  HTTP handlers;  src/routes  route table;  src/validators  request schemas
  src/middleware   auth, CSRF, rate limits, validation, error handling
  src/jobs         periodic maintenance (upload cleanup, purge retries)
  src/scripts      reconcile.ts operator tool
  test/            unit + integration tests (S3 mocked), e2e harness
client/            React + Vite + Tailwind SPA
  src/api          typed API client;  src/hooks  queries/prefs
  src/uploads      upload manager (direct-to-S3, multipart, retries, cancel)
  src/components   ui primitives, layout, drive (browser, dialogs, preview)
  src/pages        routes
docs/              API, deployment (AWS setup), security, storage policy, testing
e2e/               Playwright smoke test run against the e2e harness
```

## Quick start (local)

Requirements: Node 20+, a MongoDB 6+ instance, and an S3 bucket configured as in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) (or an S3-compatible endpoint such as MinIO).

```bash
npm install
cp .env.example server/.env      # fill in MONGODB_URI, SESSION_SECRET, AWS_* values
npm run dev --workspace server   # API on http://localhost:4000
npm run dev --workspace client   # app on http://localhost:5173 (proxies /api to the API)
```

Checks:

```bash
npm run typecheck && npm run lint && npm run test && npm run build
```

Integration tests need MongoDB (`MONGODB_URI`, default `mongodb://127.0.0.1:27017`). S3 is always
mocked in tests. See [docs/TESTING.md](docs/TESTING.md).

## Verification status (read this)

- **Verified in development:** type checks, lint and builds for both apps; 64 server tests
  (unit + integration) and 6 client tests pass; a Playwright smoke test drove the real UI through
  register → folders → uploads (incl. a 12 MB multipart upload) → preview → rename → star → move →
  Trash/restore → search → empty Trash → tablet/phone layouts → sign out with no console errors.
- **Not verified against real AWS.** No AWS credentials were available. Every S3 call is
  implemented with AWS SDK v3, but tests use an in-memory S3 mock, and the UI smoke test routed
  presigned URLs to a local fake. Before release, run the app against a real test bucket and
  check uploads (single + multipart), previews, video seeking, downloads and deletes.
- **MongoDB:** integration tests ran against FerretDB (MongoDB-wire-compatible, SQLite backend)
  because a MongoDB server could not be installed in the build environment. CI runs them against
  real MongoDB 7 (`.github/workflows/ci.yml`).
- Malware scanning, thumbnail generation for videos/PDFs and office-document previews are not
  implemented; see [docs/SECURITY.md](docs/SECURITY.md) for the production hardening list.

## Documentation

- [docs/API.md](docs/API.md) — endpoints, request/response formats, pagination, error codes
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — S3 bucket, Block Public Access, IAM, CORS, lifecycle rules, MongoDB, running and deploying
- [docs/SECURITY.md](docs/SECURITY.md) — threat model, controls, and what to add before production
- [docs/STORAGE_POLICY.md](docs/STORAGE_POLICY.md) — quota, Trash and deletion semantics
- [docs/TESTING.md](docs/TESTING.md) — test suites and the e2e harness
