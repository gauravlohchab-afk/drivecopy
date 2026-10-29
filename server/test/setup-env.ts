// Test configuration. Never points at real AWS: S3 is mocked in-process (see helpers/fakeS3.ts).
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017/drivecopy_test';
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-123456';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.AWS_REGION = 'us-east-1';
process.env.AWS_S3_BUCKET = 'drivecopy-test-bucket';
process.env.AWS_ACCESS_KEY_ID = 'AKIATESTTESTTESTTEST';
process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-key-not-real';
process.env.AWS_S3_ENDPOINT = '';
process.env.MAX_FILE_SIZE_MB = '200';
process.env.MAX_USER_STORAGE_MB = '100';
process.env.MULTIPART_THRESHOLD_MB = '10';
process.env.MULTIPART_PART_SIZE_MB = '5';
process.env.CLEANUP_INTERVAL_MINUTES = '0';
