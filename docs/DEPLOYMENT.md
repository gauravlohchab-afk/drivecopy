# Deployment and AWS setup

None of this was run against a real AWS account while building the app. Follow it once for a test
bucket and check the end-to-end flows before going to production.

## 1. Create the S3 bucket

```bash
export AWS_REGION=eu-west-1
export BUCKET=yourcompany-cirrus-prod          # globally unique
aws s3api create-bucket --bucket "$BUCKET" --region "$AWS_REGION" \
  --create-bucket-configuration LocationConstraint="$AWS_REGION"   # omit this flag for us-east-1
```

### Block Public Access (required)

```bash
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-ownership-controls --bucket "$BUCKET" \
  --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'
```

Objects are only reachable through presigned URLs the API issues to the owner. Never add a public
bucket policy.

### Encryption and transport

```bash
aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'
```

Add a bucket policy that denies non-TLS access:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "DenyInsecureTransport",
    "Effect": "Deny",
    "Principal": "*",
    "Action": "s3:*",
    "Resource": ["arn:aws:s3:::BUCKET", "arn:aws:s3:::BUCKET/*"],
    "Condition": { "Bool": { "aws:SecureTransport": "false" } }
  }]
}
```

### CORS (needed for direct browser uploads/previews)

CORS only lets the browser read responses from S3; it is **not** access control. Authorization is
the presigned signature. Allow only your app origin:

```json
[
  {
    "AllowedOrigins": ["https://drive.example.com"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type", "content-length"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

```bash
aws s3api put-bucket-cors --bucket "$BUCKET" --cors-configuration file://cors.json
```

`ExposeHeaders: ETag` is required: multipart uploads read each part's ETag in the browser.

### Lifecycle (safety net for abandoned multipart uploads)

The API aborts abandoned multipart uploads itself; this rule is a second line of defence.

```bash
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration \
  '{"Rules":[{"ID":"abort-incomplete-mpu","Status":"Enabled","Filter":{"Prefix":"users/"},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":2}}]}'
```

Do not enable object expiration rules on `users/`: deletion is driven by the app so metadata and
storage stay consistent.

## 2. IAM (least privilege)

Prefer an IAM **role** (ECS task role, EC2 instance profile, EKS IRSA, Lambda role). Leave
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` empty and the SDK picks up the role. Use access keys
only for local development, with a dedicated IAM user scoped to a dev bucket.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ObjectAccess",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject", "s3:GetObject", "s3:DeleteObject",
        "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"
      ],
      "Resource": "arn:aws:s3:::BUCKET/users/*"
    },
    {
      "Sid": "BucketListing",
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:ListBucketMultipartUploads"],
      "Resource": "arn:aws:s3:::BUCKET",
      "Condition": { "StringLike": { "s3:prefix": ["users/*"] } }
    }
  ]
}
```

`s3:PutObject` also covers `CreateMultipartUpload`, `UploadPart` and `CompleteMultipartUpload`;
`DeleteObjects` (batch) is authorised per key by `s3:DeleteObject`. Presigned URLs carry the
permissions of the credentials that signed them, so this policy also bounds what a leaked URL could
do (one object, one method, until expiry). When the app runs on a role, a presigned URL also stops
working when the role's session credentials expire, which may be sooner than the URL's TTL.

## 3. MongoDB

Use MongoDB 6+ (Atlas or self-hosted) with authentication and TLS:

```
MONGODB_URI=mongodb+srv://cirrus-app:<password>@cluster0.example.mongodb.net/cirrus?retryWrites=true&w=majority
```

Give the app user `readWrite` on its database only. The API creates indexes at start-up
(`syncIndexes`), including TTL indexes for sessions and locks. Enable backups.

## 4. Configure and run

```bash
npm ci
npm run build                       # server/dist and client/dist
cp .env.example server/.env         # or inject env vars from your secret manager
NODE_ENV=production node server/dist/index.js
```

Production checklist:

- `NODE_ENV=production` (secure `__Host-` cookies, https-only `FRONTEND_URL`).
- `SESSION_SECRET` from a secret manager (≥32 random chars), not from a committed file.
- Serve the SPA and the API on the **same site** (e.g. `https://drive.example.com` for the SPA and
  `https://drive.example.com/api` reverse-proxied to Node). Session cookies are `SameSite=Lax`;
  a different site for the API would need `SameSite=None` and is not supported as configured.
- Set `TRUST_PROXY` to the number of proxies in front of Node so rate limits see real client IPs.
- Serve `client/dist` from a CDN or the reverse proxy with an SPA fallback to `index.html`, and a
  Content-Security-Policy such as:
  `default-src 'self'; img-src 'self' data: https://BUCKET.s3.REGION.amazonaws.com; media-src https://BUCKET.s3.REGION.amazonaws.com; frame-src https://BUCKET.s3.REGION.amazonaws.com; connect-src 'self' https://BUCKET.s3.REGION.amazonaws.com; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'`
- Run one or more API instances; maintenance jobs coordinate through a lock in MongoDB, so only one
  instance runs them at a time.
- Schedule `npm run reconcile --workspace server` (e.g. daily) and alert on its output.
- Health check: `GET /api/health`.

Example nginx front:

```nginx
server {
  listen 443 ssl http2;
  server_name drive.example.com;
  client_max_body_size 1m;            # uploads go straight to S3, never through nginx
  location /api/ { proxy_pass http://127.0.0.1:4000; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; }
  location / { root /srv/cirrus/client/dist; try_files $uri /index.html; }
}
```

## 5. Smoke test after deploying

Register a user; create nested folders; upload a PDF, an image and a video larger than
`MULTIPART_THRESHOLD_MB`; preview each (seek in the video); download; rename and move; Trash and
restore; delete forever and confirm the object is gone from the bucket (`aws s3 ls s3://$BUCKET/users/ --recursive`);
sign in as a second user and confirm the first user's ids return 404.
