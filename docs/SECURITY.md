# Security

## Controls in place

**Identity and sessions**
- Passwords hashed with Argon2id (m=19 MiB, t=2, p=1). Unknown emails still run a hash
  verification so timing does not reveal which accounts exist. Login errors are generic.
- Sessions are random 256-bit tokens in an HTTP-only, `SameSite=Lax` cookie (`Secure` and
  `__Host-` prefixed in production). Only a SHA-256 hash is stored server-side, with a TTL.
  Logout deletes the session. Restarting with a changed `ADMIN_LOGIN_USERNAME` or
  `ADMIN_LOGIN_PASSWORD` revokes every session.
- There is one login and no registration. Credentials come only from the backend environment and
  are compared by SHA-256 digest with `timingSafeEqual`, always checking both values. An Argon2id
  hash in the database is used only to notice a changed password at startup. The startup check
  rejects passwords under 12 characters and the example value.
- The user id always comes from the server-side session, never from the request.
- Rate limits: 10 failed login attempts / 15 min / IP; 600 requests / min / IP on the API overall.
- 20 consecutive failed logins from any mix of addresses pause all logins for 15 minutes. Someone
  could trigger this on purpose to keep the administrator out, and restarting the backend clears it.
- Activity logs never contain passwords, tokens or AWS credentials. A failed login records only the
  time, the IP address and the fact that it failed, not what was typed.

**CSRF**
- State-changing authenticated requests require `X-CSRF-Token`, an HMAC of the session token hash
  (double-submit, bound to the session). Requests with a foreign `Origin` are rejected. SameSite
  cookies are an extra layer.

**Authorization / IDOR**
- Every query includes `ownerId` from the session. Unknown, malformed and foreign ids all return
  404. Destination folders, upload sessions, trash items and thumbnails are all owner-checked.
  Integration tests (`test/integration/isolation.test.ts`) attempt cross-user reads, writes,
  moves, restores, purges and upload hijacking.
- Sharing grants read access only (list, preview, download). Every shared read re-checks, per
  request, that the item is alive and that it or one of its current ancestors is shared with the
  caller; all writes keep the owner-only queries above. Viewers never see the owner's folder
  names above the shared folder, their stars or parent ids. Shares are deleted with the item on
  purge. `test/integration/sharing.test.ts` covers access, revocation, moves, Trash and scope.

**Input handling**
- Every body/query is parsed with zod into plain values before reaching a query; there is no path
  for user-supplied query operators. Cursors are validated. Search input is regex-escaped.
- Display names are normalised (NFC), stripped of control characters and path separators, and
  limited to 255 chars. Names are metadata only.

**S3**
- Bucket is private with Block Public Access (see DEPLOYMENT.md). No public or permanent URLs.
- Object keys are built by the server as `users/<ownerId>/<cleaned file name>`. Path separators,
  control characters and characters unsafe in keys are removed, so a name cannot leave the owner's
  prefix, and a key already in use (in records or in S3) is never issued again. File names are
  therefore visible to anyone who can list the bucket, and appear in presigned URLs.
- Presigned URLs live 15 minutes by default, are issued only to the owner, and are never logged
  (only paths are logged; response bodies are not). API responses carrying them are `no-store`.
- Upload URLs sign `Content-Type` and `Content-Length`, so the browser cannot upload a different
  size or type than was approved and reserved.
- AWS credentials are server-only and optional (IAM roles preferred). The client has no AWS config
  and no `VITE_` secrets.
- S3 errors are logged with their AWS request id; clients get a generic 503.

**Uploads**
- Allow-list of extensions; the stored and signed MIME type comes from the allow-list, not the
  browser. HTML, SVG, scripts and executables are rejected.
- After upload the API checks: object exists, size equals the reserved size, and the first bytes
  match the file type's signature (magic number); text files must not contain NUL bytes. Failures
  delete the object and release its reservation.
- The per-file size limit is enforced server-side. There is no storage quota, so watch AWS billing:
  set an AWS Budgets alert on the account.
- Inline previews are only issued for types browsers render safely (images except SVG, PDF,
  audio/video, plain text/markdown); everything else downloads with `Content-Disposition: attachment`.

**Transport and headers**
- Helmet defaults plus a restrictive CSP on API responses; CORS limited to `FRONTEND_URL` with
  credentials; JSON bodies limited to 256 KB; `x-powered-by` disabled.
- The central error handler never returns stack traces or internal messages.

## Known gaps and production hardening (not implemented)

- **Malware scanning.** Signature checks are not antivirus. Add asynchronous scanning (e.g. GuardDuty
  Malware Protection for S3, or ClamAV on an S3 event) and quarantine flagged objects before preview
  or download.
- **Single login:** no MFA, and everyone who has the password is the same user in the activity log.
  If the password is lost, set a new one in the environment and restart.
- **Account lookup when sharing**: adding someone by email says whether an account exists (rate
  limited to 60 attempts / 15 min / IP). Switch to invitations if that matters for your users.
- **Rate limiting is in-memory per instance.** With several API instances behind a load balancer,
  use a shared store (Redis) for `express-rate-limit`, or rate-limit at the edge (WAF).
- **Presigned URLs are bearer tokens** until they expire. Shorten `PRESIGNED_URL_TTL_SECONDS` if
  your threat model needs it; a leaked URL cannot be revoked early.
- **Audit logging** of security events (logins, password changes, permanent deletes) to a separate
  sink.
- **Object versioning / backups** of the bucket, and MongoDB backups with restore drills.
- **Very large Trash folders:** the Trash list loads trashed items for the user and filters roots in
  memory; add an `isTrashRoot` index if users routinely trash hundreds of thousands of items.
