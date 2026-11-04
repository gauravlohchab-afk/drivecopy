# Ageless Datahub — S3-backed cloud drive

Ageless Datahub is a Google Drive–style file storage web app with original branding. Files live in a
private Amazon S3 bucket; MongoDB holds users, folders, file metadata, upload sessions and
storage accounting. Browsers upload and download **directly to/from S3** with short-lived
presigned URLs, and the API verifies every upload server-side before a file appears.

| Area | What's implemented |
| --- | --- |
| Sign-in | One login, set by `ADMIN_LOGIN_USERNAME` and `ADMIN_LOGIN_PASSWORD` in the backend environment. No public registration. Server-side sessions in HTTP-only cookies, CSRF tokens, rate limiting and failed-login protection. Changing the password and restarting signs out every session. |
| Folders | Create, nest (64 levels), open, breadcrumbs, rename, move (no cycles, serialized per user), star, Trash/restore, permanent delete. |
| Files | Upload (single PUT or multipart), real progress, retry, cancel, preview (images, PDF, video/audio streaming, text), download, rename, move, star, multi-select + bulk actions, Trash/restore, permanent delete. |
| Uploads | Allow-list of types, per-file size limit, presigned URLs with signed `Content-Type`/`Content-Length`, server verification (exists, exact size, magic-number check), idempotent completion, expiry, cleanup of abandoned/multipart uploads, crash recovery. |
| Discovery | Search by name (whole drive or within a folder), type and date filters, sort by name/date/size, cursor pagination, Recent, Starred. |
| Home & Activity | Home suggests the folders and files you used most recently. Activity is a log of file, folder, sharing and sign-in events, stored in S3 as JSON Lines under `activity-logs/YYYY/MM/DD/`, with date grouping, search, filters and paging. |
| Shared drives | Team-owned spaces: files belong to the drive, not to whoever uploaded them. Roles: Manager (members, rename, delete), Content manager (add, edit, move, delete, restore), Viewer (view, download). Folders, uploads, preview, move within the drive, per-drive Trash, members dialog, hide per member, leave, delete when empty. Drive files appear in members' search and Activity. |
| Workspaces | Personal collections of up to 25 files and folders (your own or shared with you) for what you are working on. Create, rename, hide/show, delete; add items from any item menu (multi-select works); remove items. Items stay where they are; trashed or unshared items drop out and return if restored. |
| Storage page | Total stored, a by-type breakdown, the largest folders (including nested content) and a sortable, filterable list of the largest files, all computed from server data. |
| Sharing | Share a file or folder with another Ageless Datahub user by email (view and download only). Folder shares cover everything inside, including items added later. Owners add and remove people; viewers get a "Shared with me" list, browse shared folders read-only, and can remove items from their list. |
| Storage | No fixed storage limit. The sidebar shows what is really in the bucket (size, file count, type, status) from a cached listing, plus a reconciliation tool for counters and S3 orphans. |
| UI | Responsive (desktop, tablet, phone drawer), grid/list views, context menus, keyboard support, loading skeletons, empty/error/retry states, confirmations, toasts with undo. |

The main navigation is Home, My Drive, Activity and Trash. Workspaces, shared drives, Shared with me, Recent, Starred and Storage are no longer linked from it, but their pages and data remain at `/workspaces`, `/drives`, `/shared`, `/recent`, `/starred` and `/storage`.

Public links, editor access on personal shares, version history and real-time collaboration are **not** implemented, so the UI has no controls for them.

## Tech stack

| Part | Frameworks and libraries |
| --- | --- |
| **Frontend** (`frontend/`) | React 19 + TypeScript, built with Vite 8; Tailwind CSS 4 for styling; React Router 8 (routing); TanStack Query 5 (server state, caching); React Hook Form + Zod (forms and validation); Lucide (icons) |
| **Backend** (`backend/`) | Node.js 20+ with Express 5 + TypeScript; MongoDB through Mongoose 9; AWS SDK v3 for S3 (presigned uploads/downloads, multipart); Zod (request validation); Argon2id (password hashing); Helmet + express-rate-limit (security headers, rate limits); Pino (logging) |
| **Storage** | Amazon S3 (private bucket) for file contents; MongoDB for users, folders, file metadata, sharing, shared drives, workspaces and activity |
| **Testing & tooling** | Vitest (frontend and backend tests), Supertest (API integration tests), Playwright (browser smoke test), ESLint + typescript-eslint, npm workspaces, GitHub Actions CI |

## Repository layout

```
backend/           Express + TypeScript API
  src/config       environment parsing (zod)
  src/models       Mongoose models (User, Session, Folder, File, UploadSession, ActivityOutbox, StorageStats, ...)
  src/services     business logic (auth, admin account, activity log, S3 usage, folders, files, uploads, trash/purge, search)
  src/controllers  HTTP handlers;  src/routes  route table;  src/validators  request schemas
  src/middleware   auth, CSRF, rate limits, validation, error handling
  src/jobs         periodic maintenance (upload cleanup, purge retries)
  src/scripts      reconcile.ts operator tool
  test/            unit + integration tests (S3 mocked), e2e harness
frontend/          React + Vite + Tailwind SPA
  src/api          typed API client;  src/hooks  queries/prefs
  src/uploads      upload manager (direct-to-S3, multipart, retries, cancel)
  src/components   ui primitives, layout, drive (browser, dialogs, preview)
  src/pages        routes
docs/              API, deployment (AWS setup), security, storage policy, testing
e2e/               Playwright smoke test run against the e2e harness
```

## Try it without AWS or MongoDB

```bash
npm install
npm run local        # builds the frontend, then serves app + API on http://localhost:4000
```

Sign in with `ADMIN_LOGIN_USERNAME` and `ADMIN_LOGIN_PASSWORD` from `backend/.env`. Real S3 mode
refuses to start without them. In fake mode they default to `admin` / `test-admin-password-123`.

Runs the real API and UI with an embedded MongoDB; its data is kept in `.local-data/`, so it
survives restarts (delete that folder to start over). Stop with Ctrl+C.

- **Files in your own S3 bucket:** put `AWS_REGION`, `AWS_S3_BUCKET`, `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY` and the two `ADMIN_LOGIN_*` values in `backend/.env` (git-ignored), add the bucket CORS rule and IAM policy from
  [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) with `http://localhost:4000` as the origin, and start
  again. Access is checked at startup with a specific message for wrong keys, region or
  permissions. Files uploaded earlier in fake mode are copied to the bucket once.
- **Without a bucket** (or with `LOCAL_S3=fake`), files go to a built-in fake S3 in
  `.local-data/s3`. Good for trying the app, not for verifying S3 configuration.

## Quick start (local)

Requirements: Node 20+, a MongoDB 6+ instance, and an S3 bucket configured as in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) (or an S3-compatible endpoint such as MinIO).

```bash
npm install
cp .env.example backend/.env     # fill in MONGODB_URI, SESSION_SECRET, ADMIN_LOGIN_*, AWS_* values
npm run dev --workspace backend  # API on http://localhost:4000
npm run dev --workspace frontend # app on http://localhost:5173 (proxies /api to the API)
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
- [docs/STORAGE_POLICY.md](docs/STORAGE_POLICY.md) — usage figures, activity log, Trash and deletion semantics
- [docs/TESTING.md](docs/TESTING.md) — test suites and the e2e harness
